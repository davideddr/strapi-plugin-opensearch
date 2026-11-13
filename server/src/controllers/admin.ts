import type { Core, UID } from '@strapi/strapi';
import type { PluginConfig } from '../types';
import { PLUGIN_ID } from '../types';

/** The subset of the Koa context used here (Strapi adds `notFound`/`conflict` helpers). */
export interface AdminContext {
  params: Record<string, string>;
  status: number;
  body: unknown;
  notFound: (message?: string) => void;
  conflict: (message?: string, details?: unknown) => void;
}

const admin = ({ strapi }: { strapi: Core.Strapi }) => {
  const service = (name: string) => strapi.plugin(PLUGIN_ID).service(name);
  const configuredUids = () =>
    Object.keys(strapi.plugin(PLUGIN_ID).config<PluginConfig['contentTypes']>('contentTypes')) as UID.ContentType[];

  /** Busy content types: being reindexed or waiting in a `reindexAll`. */
  const busy = (): UID.ContentType[] => {
    const indexer = service('indexer');
    return [...indexer.getRunning(), ...indexer.getQueued()];
  };

  /** The reindex runs after the response; its outcome is read from `/status` (`lastReindex`). */
  const runInBackground = (label: string, work: Promise<unknown>) => {
    work.catch((error: Error) => strapi.log.error(`[opensearch] background ${label} failed: ${error.message}`));
  };

  return {
    async status(ctx: AdminContext) {
      ctx.body = await service('status').getStatus();
    },

    async reindexAll(ctx: AdminContext) {
      const current = busy();
      if (current.length > 0) {
        return ctx.conflict('A reindex is already running', { code: 'REINDEX_IN_PROGRESS', running: current });
      }
      const uids = configuredUids();
      runInBackground('reindex of all content types', service('indexer').reindexAll());
      ctx.status = 202;
      ctx.body = { started: uids };
    },

    async reindex(ctx: AdminContext) {
      const uid = ctx.params.uid as UID.ContentType;
      if (!configuredUids().includes(uid)) {
        return ctx.notFound(`Content type ${uid} is not configured for OpenSearch`);
      }
      if (busy().includes(uid)) {
        return ctx.conflict(`A reindex of ${uid} is already running or queued`, {
          code: 'REINDEX_IN_PROGRESS',
          running: busy(),
        });
      }
      // `reindex` takes the lock synchronously, so a second request now gets 409.
      runInBackground(`reindex of ${uid}`, service('indexer').reindex(uid));
      ctx.status = 202;
      ctx.body = { started: [uid] };
    },
  };
};

export default admin;
