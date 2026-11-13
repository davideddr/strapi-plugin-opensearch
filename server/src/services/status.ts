import type { Core, UID } from '@strapi/strapi';
import type { PluginConfig } from '../types';
import { PLUGIN_ID } from '../types';
import type { IndexTarget } from './index-manager';
import type { ReindexReport } from './indexer';

export type ClusterStatus =
  { ok: true; clusterName: string; version: string; distribution?: string } | { ok: false; error: string };

export interface LocaleStatus {
  locale: string | null;
  alias: string;
  /** Physical indices behind the alias; `null` when the cluster could not be read. */
  indices: string[] | null;
  /** Documents in the index; `null` when the alias is missing or the cluster could not be read. */
  count: number | null;
  /** Published entries in Strapi (before `filter`); `null` when the count failed. */
  published: number | null;
  error?: string;
}

export interface ContentTypeStatus {
  uid: UID.ContentType;
  displayName: string;
  reindexing: boolean;
  queued: boolean;
  lastReindex: ReindexReport | null;
  locales: LocaleStatus[];
  error?: string;
}

export interface PluginStatus {
  cluster: ClusterStatus;
  running: UID.ContentType[];
  queued: UID.ContentType[];
  contentTypes: ContentTypeStatus[];
}

const message = (error: unknown) => (error as Error)?.message ?? String(error);

const status = ({ strapi }: { strapi: Core.Strapi }) => {
  const service = (name: string) => strapi.plugin(PLUGIN_ID).service(name);

  const countPublished = async (uid: UID.ContentType, locale: string | null): Promise<number> =>
    strapi.documents(uid).count({ status: 'published', ...(locale ? { locale } : {}) } as never);

  const localeStatus = async (target: IndexTarget, clusterOk: boolean): Promise<LocaleStatus> => {
    const result: LocaleStatus = {
      locale: target.locale,
      alias: target.alias,
      indices: null,
      count: null,
      published: null,
    };
    const errors: string[] = [];

    try {
      result.published = await countPublished(target.uid, target.locale);
    } catch (error) {
      errors.push(`strapi count: ${message(error)}`);
    }

    if (clusterOk) {
      try {
        const indices: string[] = await service('index-manager').getAliasIndices(target.alias);
        result.indices = indices;
        if (indices.length > 0) {
          result.count = (await service('client').getClient().count({ index: target.alias })).body.count;
        }
      } catch (error) {
        errors.push(`opensearch: ${message(error)}`);
      }
    }

    if (errors.length > 0) result.error = errors.join('; ');
    return result;
  };

  return {
    /**
     * Cluster ping, then per configured content type × locale: alias, physical indices, documents
     * in the index and published entries in Strapi, plus the reindex state. Never throws: failures
     * are reported in the `error` fields, so the admin page can always render.
     */
    async getStatus(): Promise<PluginStatus> {
      const indexer = service('indexer');

      let cluster: ClusterStatus;
      try {
        cluster = { ok: true, ...(await service('client').ping()) };
      } catch (error) {
        cluster = { ok: false, error: message(error) };
      }

      const running: UID.ContentType[] = indexer.getRunning();
      const queued: UID.ContentType[] = indexer.getQueued();
      const uids = Object.keys(
        strapi.plugin(PLUGIN_ID).config<PluginConfig['contentTypes']>('contentTypes'),
      ) as UID.ContentType[];

      const contentTypes: ContentTypeStatus[] = [];
      for (const uid of uids) {
        const entry: ContentTypeStatus = {
          uid,
          displayName: strapi.contentType(uid)?.info?.displayName ?? uid,
          reindexing: running.includes(uid),
          queued: queued.includes(uid),
          lastReindex: indexer.getLastReport(uid),
          locales: [],
        };
        try {
          const targets: IndexTarget[] = await service('index-manager').getTargets(uid);
          for (const target of targets) entry.locales.push(await localeStatus(target, cluster.ok));
        } catch (error) {
          entry.error = message(error);
        }
        contentTypes.push(entry);
      }

      return { cluster, running, queued, contentTypes };
    },
  };
};

export default status;
