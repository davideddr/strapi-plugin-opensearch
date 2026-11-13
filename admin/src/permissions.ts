import { PLUGIN_ID } from './pluginId';

/** Admin RBAC actions; same ids registered by the server in `bootstrap`. */
export const PERMISSIONS = {
  read: [{ action: `plugin::${PLUGIN_ID}.read`, subject: null }],
  reindex: [{ action: `plugin::${PLUGIN_ID}.reindex`, subject: null }],
};
