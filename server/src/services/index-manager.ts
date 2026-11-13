import type { Core, UID } from '@strapi/strapi';
import type { Client } from '@opensearch-project/opensearch';
import type { ContentTypeConfig, PluginConfig } from '../types';
import { PLUGIN_ID } from '../types';
import { buildIndexBody } from '../utils/index-body';
import { buildAliasName, buildVersionedIndexName, isVersionOf, versionPattern } from '../utils/naming';

/** One alias: a content type in one locale (`locale: null` when i18n is off for it). */
export interface IndexTarget {
  uid: UID.ContentType;
  locale: string | null;
  alias: string;
}

export interface IndexStats extends IndexTarget {
  exists: boolean;
  /** Physical indices behind the alias (normally one). */
  indices: string[];
  /** Documents reachable through the alias, `null` when it does not exist. */
  count: number | null;
}

const isNotFound = (error: unknown) => (error as { meta?: { statusCode?: number } })?.meta?.statusCode === 404;

const indexManager = ({ strapi }: { strapi: Core.Strapi }) => {
  const getConfig = <K extends keyof PluginConfig>(key: K): PluginConfig[K] => strapi.plugin(PLUGIN_ID).config(key);
  const getClient = (): Client => strapi.plugin(PLUGIN_ID).service('client').getClient();

  const getContentTypeConfig = (uid: UID.ContentType): ContentTypeConfig => {
    const ctConfig = getConfig('contentTypes')[uid];
    if (!ctConfig) throw new Error(`[opensearch] content type ${uid} is not configured`);
    return ctConfig;
  };

  const isLocalized = (uid: UID.ContentType) => {
    const pluginOptions = strapi.contentType(uid)?.pluginOptions as { i18n?: { localized?: boolean } } | undefined;
    return pluginOptions?.i18n?.localized === true && !!strapi.plugin('i18n');
  };

  /** Physical indices currently behind `alias` (empty when the alias does not exist). */
  const getAliasIndices = async (alias: string): Promise<string[]> => {
    try {
      const { body } = await getClient().indices.getAlias({ name: alias });
      return Object.keys(body);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  };

  return {
    getAliasName(uid: UID.ContentType, locale: string | null): string {
      const indexName = getContentTypeConfig(uid).indexName ?? strapi.contentType(uid).info.singularName;
      return buildAliasName(getConfig('indexPrefix'), indexName, locale);
    },

    /**
     * Locales indexed for a content type: `[null]` without i18n, otherwise the Strapi locales
     * filtered by `locales` in the config (unknown codes are ignored with a warning).
     */
    async getLocales(uid: UID.ContentType): Promise<(string | null)[]> {
      if (!isLocalized(uid)) return [null];

      const available: string[] = (await strapi.plugin('i18n').service('locales').find()).map(
        (locale: { code: string }) => locale.code,
      );
      const wanted = getContentTypeConfig(uid).locales ?? 'all';
      if (wanted === 'all') return available;

      const unknown = wanted.filter((code) => !available.includes(code));
      if (unknown.length > 0) {
        strapi.log.warn(`[opensearch] ${uid}: locale(s) not defined in Strapi, skipped: ${unknown.join(', ')}`);
      }
      return wanted.filter((code) => available.includes(code));
    },

    async getTargets(uid?: UID.ContentType): Promise<IndexTarget[]> {
      const uids = uid ? [uid] : (Object.keys(getConfig('contentTypes')) as UID.ContentType[]);
      const targets: IndexTarget[] = [];
      for (const current of uids) {
        for (const locale of await this.getLocales(current)) {
          targets.push({ uid: current, locale, alias: this.getAliasName(current, locale) });
        }
      }
      return targets;
    },

    getAliasIndices,

    /**
     * Creates a new `{alias}_v{timestamp}` index with the settings/mappings of the content type.
     * With `attachAlias` the alias is added in the same request (first creation); otherwise the
     * caller moves it later with `swapAlias` (reindex).
     */
    async createVersionedIndex(
      uid: UID.ContentType,
      locale: string | null,
      { attachAlias = false }: { attachAlias?: boolean } = {},
    ): Promise<string> {
      const client = getClient();
      const alias = this.getAliasName(uid, locale);
      const { settings, mappings } = getContentTypeConfig(uid);

      let timestamp = Date.now();
      let index = buildVersionedIndexName(alias, timestamp);
      while ((await client.indices.exists({ index })).body) {
        index = buildVersionedIndexName(alias, ++timestamp);
      }

      await client.indices.create({
        index,
        // Config values are user-provided JSON; OpenSearch validates them.
        body: {
          ...(buildIndexBody({ locale, settings, mappings }) as object),
          ...(attachAlias ? { aliases: { [alias]: {} } } : {}),
        },
      });
      return index;
    },

    /** Creates the first versioned index and its alias if the alias does not exist yet. Idempotent. */
    async ensureIndex(uid: UID.ContentType, locale: string | null) {
      const alias = this.getAliasName(uid, locale);
      const existing = await getAliasIndices(alias);
      if (existing.length > 0) return { alias, index: existing[0], created: false };

      if ((await getClient().indices.exists({ index: alias })).body) {
        throw new Error(
          `an index named "${alias}" already exists and is not an alias: delete it or change indexPrefix`,
        );
      }

      const index = await this.createVersionedIndex(uid, locale, { attachAlias: true });
      return { alias, index, created: true };
    },

    /** Runs `ensureIndex` for every configured target. Errors are logged per target, never thrown. */
    async ensureIndices() {
      let targets: IndexTarget[];
      try {
        targets = await this.getTargets();
      } catch (error) {
        strapi.log.error(`[opensearch] cannot resolve the indices to create: ${(error as Error).message}`);
        return;
      }

      for (const { uid, locale, alias } of targets) {
        try {
          const result = await this.ensureIndex(uid, locale);
          if (result.created) strapi.log.info(`[opensearch] created index ${result.index} (alias ${alias})`);
        } catch (error) {
          strapi.log.error(`[opensearch] cannot ensure index ${alias}: ${(error as Error).message}`);
        }
      }
    },

    /** Points `alias` to `index` only, removing every other index from it in one atomic request. */
    async swapAlias(alias: string, index: string) {
      const current = await getAliasIndices(alias);
      await getClient().indices.updateAliases({
        body: {
          actions: [
            ...current.filter((name) => name !== index).map((name) => ({ remove: { index: name, alias } })),
            { add: { index, alias } },
          ],
        },
      });
      return { alias, index, previous: current.filter((name) => name !== index) };
    },

    /** Deletes the `{alias}_v*` indices not attached to the alias. Returns the deleted names. */
    async dropOldVersions(alias: string): Promise<string[]> {
      const client = getClient();
      const { body } = await client.indices.getAlias({ index: versionPattern(alias) });
      const stale = Object.entries(body)
        .filter(([name, info]) => isVersionOf(alias, name) && !(alias in (info.aliases ?? {})))
        .map(([name]) => name);

      if (stale.length > 0) await client.indices.delete({ index: stale.join(',') });
      return stale;
    },

    /** Per alias: physical indices and document count. */
    async stats(uid?: UID.ContentType): Promise<IndexStats[]> {
      const client = getClient();
      const result: IndexStats[] = [];
      for (const target of await this.getTargets(uid)) {
        const indices = await getAliasIndices(target.alias);
        const count = indices.length > 0 ? (await client.count({ index: target.alias })).body.count : null;
        result.push({ ...target, exists: indices.length > 0, indices, count });
      }
      return result;
    },
  };
};

export default indexManager;
