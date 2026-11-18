/**
 * Public API, prefix `/api/opensearch`. The action (`plugin::opensearch.search.search`) is
 * granted per role in Users & Permissions: enable it for Public to make search anonymous.
 */
export default () => ({
  type: 'content-api',
  routes: [
    {
      // Multi-index search: `?indices=article,page` (required), same action as `/search/:index`.
      method: 'GET',
      path: '/search',
      handler: 'search.search',
      config: { policies: [] },
    },
    {
      method: 'GET',
      path: '/search/:index',
      handler: 'search.search',
      config: { policies: [] },
    },
  ],
});
