import { PLUGIN_ID } from '../../types';

/** Admin RBAC actions, registered in `bootstrap` (ids `plugin::opensearch.<uid>`). */
export const ACTIONS = {
  read: `plugin::${PLUGIN_ID}.read`,
  reindex: `plugin::${PLUGIN_ID}.reindex`,
} as const;

const policies = (action: string) => [
  'admin::isAuthenticatedAdmin',
  { name: 'admin::hasPermissions', config: { actions: [action] } },
];

export default () => ({
  type: 'admin',
  routes: [
    {
      method: 'GET',
      path: '/status',
      handler: 'admin.status',
      config: { policies: policies(ACTIONS.read) },
    },
    {
      method: 'POST',
      path: '/reindex',
      handler: 'admin.reindexAll',
      config: { policies: policies(ACTIONS.reindex) },
    },
    {
      method: 'POST',
      path: '/reindex/:uid',
      handler: 'admin.reindex',
      config: { policies: policies(ACTIONS.reindex) },
    },
  ],
});
