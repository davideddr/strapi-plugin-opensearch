import type { Core } from '@strapi/strapi';
import type { PluginConfig } from './types';
import { PLUGIN_ID } from './types';

const assertContentTypes = (strapi: Core.Strapi) => {
  const configured = Object.keys(strapi.plugin(PLUGIN_ID).config<PluginConfig['contentTypes']>('contentTypes'));
  const missing = configured.filter((uid) => !(uid in strapi.contentTypes));
  if (missing.length > 0) {
    throw new Error(
      `[opensearch] invalid plugin config: unknown content type(s) in contentTypes: ${missing.join(', ')}`,
    );
  }
};

/** Settings → Administration panel → Roles → Plugins → OpenSearch. */
const registerPermissions = async (strapi: Core.Strapi) => {
  await strapi.service('admin::permission').actionProvider.registerMany([
    { section: 'plugins', displayName: 'Read status', uid: 'read', pluginName: PLUGIN_ID },
    { section: 'plugins', displayName: 'Reindex', uid: 'reindex', pluginName: PLUGIN_ID },
  ]);
};

const bootstrap = async ({ strapi }: { strapi: Core.Strapi }) => {
  assertContentTypes(strapi);
  // Before the ping: the permissions must exist even when the cluster is down.
  await registerPermissions(strapi);

  try {
    const info = await strapi.plugin(PLUGIN_ID).service('client').ping();
    strapi.log.info(
      `[opensearch] connected to ${info.distribution ?? 'cluster'} ${info.version} (${info.clusterName})`,
    );
  } catch (error) {
    // Never block Strapi: indexing errors are logged and a reindex realigns later.
    strapi.log.warn(
      `[opensearch] cluster unreachable, indexing disabled until it is back: ${(error as Error).message}`,
    );
    return;
  }

  // Logs its own errors per index, never throws.
  await strapi.plugin(PLUGIN_ID).service('index-manager').ensureIndices();
};

export default bootstrap;
