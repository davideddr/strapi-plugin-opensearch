import type { Core } from '@strapi/strapi';
import { waitForPendingSync } from './middlewares/sync';
import { PLUGIN_ID } from './types';

/** Upper bound for the sync tasks still queued at shutdown. */
const SHUTDOWN_SYNC_TIMEOUT_MS = 10_000;

const destroy = async ({ strapi }: { strapi: Core.Strapi }) => {
  // Runs before the database is closed (plugin destroy lifecycles come first in Strapi.destroy).
  const left = await waitForPendingSync(SHUTDOWN_SYNC_TIMEOUT_MS);
  if (left > 0) {
    strapi.log.warn(`[opensearch] ${left} sync task(s) still pending at shutdown: run a reindex to realign`);
  }
  await strapi.plugin(PLUGIN_ID).service('client').close();
};

export default destroy;
