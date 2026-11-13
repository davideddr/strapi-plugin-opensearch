import type { Core, UID } from '@strapi/strapi';
import type { Client } from '@opensearch-project/opensearch';
import type { PluginConfig } from '../types';
import { PLUGIN_ID } from '../types';
import { buildBulkBody, summarizeBulkResponse, type BulkItemError } from '../utils/bulk';
import type { IndexDocument } from './document-builder';

export type IndexOneResult = 'indexed' | 'removed';

/** Item errors kept in a report (and logged one by one); the counters always cover all of them. */
export const MAX_REPORTED_ERRORS = 50;

export interface ReindexLocaleReport {
  locale: string | null;
  alias: string;
  /** New physical index (deleted again when the locale fails). */
  index: string | null;
  /** Published entries read from Strapi. */
  read: number;
  indexed: number;
  /** Excluded by `filter`. */
  filtered: number;
  /** Changed by the real-time sync during the reindex: written by the sync, not by the bulk. */
  superseded: number;
  /** Documents touched by the sync during the reindex, written again from Strapi before the swap. */
  reconciled: number;
  /** Build errors and bulk item errors. */
  failed: number;
  errors: BulkItemError[];
  /** Documents in the new index after the final refresh. */
  count: number | null;
  /** Indices deleted after the alias swap. */
  dropped: string[];
  /** Set when the locale was aborted: the alias still points to the previous index. */
  error?: string;
}

export interface ReindexReport {
  uid: UID.ContentType;
  /** False when at least one locale was aborted. Item failures alone do not make it false. */
  ok: boolean;
  startedAt: string;
  durationMs: number;
  locales: ReindexLocaleReport[];
  error?: string;
}

export class ReindexInProgressError extends Error {
  readonly code = 'REINDEX_IN_PROGRESS';

  constructor(uid: string) {
    super(`[opensearch] a reindex of ${uid} is already running`);
    this.name = 'ReindexInProgressError';
  }
}

/** New index being filled for an alias, plus the documents the real-time sync touched meanwhile. */
interface Build {
  index: string;
  touched: Set<string>;
}

const isNotFound = (error: unknown) => (error as { meta?: { statusCode?: number } })?.meta?.statusCode === 404;

const indexer = ({ strapi }: { strapi: Core.Strapi }) => {
  const getClient = (): Client => strapi.plugin(PLUGIN_ID).service('client').getClient();
  const indexManager = () => strapi.plugin(PLUGIN_ID).service('index-manager');
  const documentBuilder = () => strapi.plugin(PLUGIN_ID).service('document-builder');
  const getConfig = <K extends keyof PluginConfig>(key: K): PluginConfig[K] => strapi.plugin(PLUGIN_ID).config(key);

  /** Aliases known to exist; avoids an `ensureIndex` round trip on every write. */
  const readyAliases = new Set<string>();
  /** Content types being reindexed (in-memory lock, per process). */
  const running = new Set<UID.ContentType>();
  /** Alias → index being built by a reindex. The real-time sync writes there too. */
  const builds = new Map<string, Build>();
  /** Content types waiting for their turn in a `reindexAll`. */
  const queued = new Set<UID.ContentType>();
  /** Last report per content type (this process, since startup). */
  const lastReports = new Map<UID.ContentType, ReindexReport>();

  /**
   * Alias of the target, created on first use if missing (cluster down at startup). Writes always
   * go through `require_alias`, so a missing alias never turns into an auto-created plain index.
   */
  const ensureAlias = async (uid: UID.ContentType, locale: string | null): Promise<string> => {
    const alias: string = indexManager().getAliasName(uid, locale);
    if (!readyAliases.has(alias)) {
      const { created, index } = await indexManager().ensureIndex(uid, locale);
      if (created) strapi.log.info(`[opensearch] created index ${index} (alias ${alias})`);
      readyAliases.add(alias);
    }
    return alias;
  };

  /** Marks the document as handled by the real-time sync for a reindex in progress on `alias`. */
  const touch = (alias: string, documentId: string): Build | undefined => {
    const build = builds.get(alias);
    build?.touched.add(documentId);
    return build;
  };

  const deleteFrom = async (index: string, documentId: string) => {
    try {
      await getClient().delete({ index, id: documentId });
    } catch (error) {
      // Document (or alias) not there: nothing to remove.
      if (!isNotFound(error)) throw error;
    }
  };

  /** Writes the current state of a document (published version or nothing) into `index`. */
  const reconcileInto = async (uid: UID.ContentType, index: string, documentId: string, locale: string | null) => {
    const document = await documentBuilder().loadAndBuild(uid, documentId, locale);
    if (document) await getClient().index({ index, id: documentId, body: document });
    else await deleteFrom(index, documentId);
  };

  const reindexLocale = async (uid: UID.ContentType, locale: string | null): Promise<ReindexLocaleReport> => {
    const client = getClient();
    const { populate } = getConfig('contentTypes')[uid];
    const bulkSize = getConfig('bulkSize');
    const alias: string = indexManager().getAliasName(uid, locale);
    const where = `${uid}${locale ? ` (${locale})` : ''}`;
    const report: ReindexLocaleReport = {
      locale,
      alias,
      index: null,
      read: 0,
      indexed: 0,
      filtered: 0,
      superseded: 0,
      reconciled: 0,
      failed: 0,
      errors: [],
      count: null,
      dropped: [],
    };
    const fail = (error: BulkItemError) => {
      report.failed += 1;
      if (report.errors.length < MAX_REPORTED_ERRORS) {
        report.errors.push(error);
        strapi.log.warn(`[opensearch] reindex ${where}: ${error.id} not indexed (${error.status}) ${error.reason}`);
      }
    };

    let build: Build | undefined;
    let swapped = false;
    try {
      const index: string = await indexManager().createVersionedIndex(uid, locale);
      report.index = index;
      // Registered before the first read: any change committed from now on is also written to the
      // new index by the sync, and reconciled again below.
      build = { index, touched: new Set() };
      builds.set(alias, build);

      // Keyset pagination on the row id: entries unpublished meanwhile do not shift the pages.
      let lastId = 0;
      for (;;) {
        const entries = (await strapi.documents(uid).findMany({
          status: 'published',
          ...(locale ? { locale } : {}),
          ...(populate !== undefined ? { populate: populate as never } : {}),
          filters: { id: { $gt: lastId } } as never,
          sort: 'id:asc' as never,
          limit: bulkSize,
        })) as unknown as ({ id: number; documentId: string } & Record<string, unknown>)[];
        if (entries.length === 0) break;
        lastId = entries[entries.length - 1].id;
        report.read += entries.length;

        const documents: IndexDocument[] = [];
        for (const entry of entries) {
          try {
            const document: IndexDocument | null = await documentBuilder().build(uid, entry, locale);
            if (document) documents.push(document);
            else report.filtered += 1;
          } catch (error) {
            // Already logged by the builder with uid and documentId.
            fail({ id: entry.documentId, status: 0, reason: `build failed: ${(error as Error).message}` });
          }
        }

        // Documents handled by the sync meanwhile are newer than this page.
        const fresh = documents.filter((document) => !build!.touched.has(document.documentId));
        report.superseded += documents.length - fresh.length;
        if (fresh.length > 0) {
          const { body } = await client.bulk({ body: buildBulkBody(index, fresh) });
          const summary = summarizeBulkResponse(body as never);
          report.indexed += summary.indexed;
          summary.failed.forEach(fail);
        }
        if (entries.length < bulkSize) break;
      }

      // A page may have been read before a sync write and sent after it: the sync is authoritative,
      // so the documents it touched are written again from their current state.
      for (const documentId of [...build.touched]) {
        await reconcileInto(uid, index, documentId, locale);
        report.reconciled += 1;
      }

      await client.indices.refresh({ index });
      report.count = (await client.count({ index })).body.count;

      await indexManager().swapAlias(alias, index);
      swapped = true;
      readyAliases.add(alias);
      builds.delete(alias);
      report.dropped = await indexManager().dropOldVersions(alias);

      strapi.log.info(
        `[opensearch] reindexed ${where} into ${index}: ${report.indexed} indexed, ${report.filtered} filtered, ` +
          `${report.reconciled} reconciled after sync, ${report.failed} failed, ${report.count} in index`,
      );
    } catch (error) {
      report.error = (error as Error).message;
      strapi.log.error(
        swapped
          ? `[opensearch] reindex ${where}: alias ${alias} moved to ${report.index}, cleanup failed: ${report.error}`
          : `[opensearch] reindex ${where} aborted, alias ${alias} unchanged: ${report.error}`,
      );
      if (report.index && builds.get(alias)?.index === report.index) {
        builds.delete(alias);
        await client.indices.delete({ index: report.index }).catch((cleanupError: Error) => {
          strapi.log.warn(`[opensearch] cannot delete ${report.index}: ${cleanupError.message}`);
        });
      }
    } finally {
      if (build && builds.get(alias) === build) builds.delete(alias);
    }
    return report;
  };

  return {
    /**
     * Aligns one document in one locale (`null` without i18n) with Strapi: indexes the published
     * version, or removes it when not published or excluded by `filter`. During a reindex of the
     * same alias the new index is updated as well.
     */
    async indexOne(uid: UID.ContentType, documentId: string, locale: string | null): Promise<IndexOneResult> {
      const build = touch(indexManager().getAliasName(uid, locale), documentId);

      const document = await documentBuilder().loadAndBuild(uid, documentId, locale);
      if (!document) {
        await this.removeOne(uid, documentId, locale);
        return 'removed';
      }

      const alias = await ensureAlias(uid, locale);
      try {
        await getClient().index({ index: alias, id: documentId, body: document, require_alias: true });
      } catch (error) {
        // The alias may have been deleted behind our back: check it again next time.
        readyAliases.delete(alias);
        throw error;
      }
      if (build) await getClient().index({ index: build.index, id: documentId, body: document });
      return 'indexed';
    },

    /** Deletes the document from the alias of the locale (and from a reindex in progress). */
    async removeOne(uid: UID.ContentType, documentId: string, locale: string | null): Promise<void> {
      const alias: string = indexManager().getAliasName(uid, locale);
      const build = touch(alias, documentId);
      await deleteFrom(alias, documentId);
      if (build) await deleteFrom(build.index, documentId);
    },

    /** Forgets the cached aliases (after a manual change on the cluster). */
    resetAliasCache() {
      readyAliases.clear();
    },

    /** Content types with a reindex in progress in this process. */
    getRunning(): UID.ContentType[] {
      return [...running];
    },

    /** Content types waiting in a `reindexAll` in progress. */
    getQueued(): UID.ContentType[] {
      return [...queued];
    },

    isReindexing(uid: UID.ContentType): boolean {
      return running.has(uid);
    },

    /** Last reindex report of the content type in this process, `null` if none since startup. */
    getLastReport(uid: UID.ContentType): ReindexReport | null {
      return lastReports.get(uid) ?? null;
    },

    /**
     * Rebuilds every locale of a content type without downtime: new versioned index → published
     * entries in pages of `bulkSize` → `_bulk` → refresh → atomic alias swap → old versions dropped.
     * A locale that fails (cluster error) is aborted and keeps its previous index; item errors are
     * counted and reported but do not stop the swap. Throws {@link ReindexInProgressError} when the
     * same content type is already being reindexed.
     */
    async reindex(uid: UID.ContentType): Promise<ReindexReport> {
      if (running.has(uid)) throw new ReindexInProgressError(uid);
      running.add(uid);

      const started = Date.now();
      const report: ReindexReport = {
        uid,
        ok: true,
        startedAt: new Date(started).toISOString(),
        durationMs: 0,
        locales: [],
      };
      try {
        const locales: (string | null)[] = await indexManager().getLocales(uid);
        for (const locale of locales) {
          report.locales.push(await reindexLocale(uid, locale));
        }
        report.ok = report.locales.every((locale) => !locale.error);
      } catch (error) {
        report.ok = false;
        report.error = (error as Error).message;
        strapi.log.error(`[opensearch] reindex ${uid} failed: ${report.error}`);
      } finally {
        running.delete(uid);
        report.durationMs = Date.now() - started;
        lastReports.set(uid, report);
      }
      return report;
    },

    /** `reindex` of every configured content type, one after the other. Never throws. */
    async reindexAll(): Promise<ReindexReport[]> {
      const reports: ReindexReport[] = [];
      const uids = Object.keys(getConfig('contentTypes')) as UID.ContentType[];
      uids.forEach((uid) => queued.add(uid));
      for (const uid of uids) {
        queued.delete(uid);
        try {
          reports.push(await this.reindex(uid));
        } catch (error) {
          reports.push({
            uid,
            ok: false,
            startedAt: new Date().toISOString(),
            durationMs: 0,
            locales: [],
            error: (error as Error).message,
          });
        }
      }
      return reports;
    },
  };
};

export default indexer;
