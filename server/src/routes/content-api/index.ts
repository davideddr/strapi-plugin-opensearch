/**
 * Public API, prefix `/api/opensearch`. The action (`plugin::opensearch.search.search`) is
 * granted per role in Users & Permissions: enable it for Public to make search anonymous.
 */
export default () => ({
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/search/:index',
      handler: 'search.search',
      config: { policies: [] },
    },
  ],
});
