import type { Core, Modules, UID } from '@strapi/strapi';
import type { PluginConfig } from '../types';
import { PLUGIN_ID } from '../types';
import { buildSyncPlan, type LocaleSelector, type SyncPlan } from '../utils/sync-plan';

/*
 * Document Service middleware (registered with `strapi.documents.use` in `register`), not a Koa
 * middleware: that is why it is not exported from `middlewares/index.ts`.
 */

type DocumentMiddleware = Modules.Documents.Middleware.Middleware;

/** Sync tasks scheduled or running (module level: one Strapi instance per process). */
const pending = new Set<Promise<void>>();

/**
 * Sync tasks running at the same time. A bulk publish of the Content Manager commits hundreds of
 * documents at once: without a limit they would all hit the cluster together (connection errors).
 */
export const MAX_CONCURRENT_SYNC = 4;
const queue: (() => Promise<void>)[] = [];
let active = 0;

const drain = () => {
  while (active < MAX_CONCURRENT_SYNC && queue.length > 0) {
    const next = queue.shift()!;
    active += 1;
    void next().finally(() => {
      active -= 1;
      drain();
    });
  }
};

/**
 * Runs `task` once the data is committed and outside the request: after the commit of the
 * enclosing transaction when there is one (Content Manager publish and bulk actions wrap the
 * Document Service calls in `strapi.db.transaction`), so the published version is readable and a
 * rollback indexes nothing. Errors are logged, never thrown back to the editor.
 */
const scheduleAfterCommit = (strapi: Core.Strapi, task: () => Promise<void>) => {
  // Tracked from now on, so `waitForPendingSync` also covers tasks not started yet.
  let settle!: () => void;
  const tracked = new Promise<void>((resolve) => (settle = resolve)).finally(() => pending.delete(tracked));
  pending.add(tracked);

  const run = () =>
    setImmediate(() => {
      queue.push(() =>
        task()
          .catch((error) => {
            strapi.log.error(`[opensearch] sync failed: ${(error as Error).message}`);
          })
          .finally(settle),
      );
      drain();
    });

  if (!strapi.db.inTransaction()) {
    run();
    return;
  }
  // Nested call: joins the current transaction and queues the callback on its commit.
  strapi.db
    .transaction(async ({ onCommit, onRollback }) => {
      onCommit(run);
      onRollback(settle);
    })
    .catch((error: Error) => {
      settle();
      strapi.log.error(`[opensearch] cannot schedule sync: ${error.message}`);
    });
};

/**
 * Resolves when every scheduled sync task has finished, or after `timeoutMs`. Used by `destroy`:
 * tasks still queued at shutdown would otherwise run after the database is closed.
 * Returns the number of tasks still pending at the timeout.
 */
export const waitForPendingSync = async (timeoutMs: number): Promise<number> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
  // Tasks may schedule other tasks while we wait: loop until the set is empty.
  let timedOut = false;
  void timeout.then(() => (timedOut = true));
  while (pending.size > 0 && !timedOut) {
    await Promise.race([Promise.all([...pending]), timeout]);
  }
  clearTimeout(timer);
  return pending.size;
};

const resolveLocales = async (strapi: Core.Strapi, uid: UID.ContentType, selector: LocaleSelector) => {
  const configured: (string | null)[] = await strapi.plugin(PLUGIN_ID).service('index-manager').getLocales(uid);
  if (selector === 'all') return configured;

  const wanted = selector === 'default' ? [await strapi.localization.getDefaultLocale()] : selector;
  // Locales excluded by `locales` in the config are not indexed.
  return configured.filter((locale) => wanted.includes(locale));
};

const runPlan = async (strapi: Core.Strapi, uid: UID.ContentType, { action, documentId, locales }: SyncPlan) => {
  const indexer = strapi.plugin(PLUGIN_ID).service('indexer');
  for (const locale of await resolveLocales(strapi, uid, locales)) {
    const where = `${uid} ${documentId}${locale ? ` (${locale})` : ''}`;
    try {
      if (action === 'index') {
        strapi.log.debug(`[opensearch] ${await indexer.indexOne(uid, documentId, locale)} ${where}`);
      } else {
        await indexer.removeOne(uid, documentId, locale);
        strapi.log.debug(`[opensearch] removed ${where}`);
      }
    } catch (error) {
      // One locale failing must not stop the others.
      strapi.log.error(`[opensearch] cannot ${action} ${where}: ${(error as Error).message}`);
    }
  }
};

export const createSyncMiddleware =
  (strapi: Core.Strapi): DocumentMiddleware =>
  async (context, next) => {
    const result = await next();

    const uid = context.uid as UID.ContentType;
    const contentTypes = strapi.plugin(PLUGIN_ID).config<PluginConfig['contentTypes']>('contentTypes');
    if (!(uid in contentTypes)) return result;

    try {
      const plans = buildSyncPlan({
        action: context.action,
        params: context.params as Record<string, unknown>,
        result,
        draftAndPublish: context.contentType.options?.draftAndPublish === true,
        localized: strapi.localization.isLocalizedContentType(context.contentType),
      });
      if (plans.length > 0) {
        scheduleAfterCommit(strapi, async () => {
          for (const plan of plans) await runPlan(strapi, uid, plan);
        });
      }
    } catch (error) {
      strapi.log.error(`[opensearch] cannot plan sync for ${uid} ${context.action}: ${(error as Error).message}`);
    }

    return result;
  };
