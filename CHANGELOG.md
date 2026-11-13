# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-11

First release.

### Added

- Validated plugin configuration (`config/plugins.ts`): connection with basic auth or AWS SigV4,
  `indexPrefix`, `bulkSize`, per content type `indexName`, `locales`, `populate`, `filter`,
  `transform`, `mappings`, `settings` and search whitelist.
- One index per content type × locale behind an alias, versioned physical indices, language
  analyzer by locale, fixed base mapping (`documentId`, `locale`, `publishedAt`, `updatedAt`).
- Real-time sync of published entries through a Document Service middleware, after the
  transaction commit, with bounded concurrency; OpenSearch errors never block the editor.
- Zero-downtime reindex per content type and locale (keyset pagination, `_bulk`, atomic alias
  swap, old versions dropped) with live dual-write during the rebuild.
- Admin routes `GET /status`, `POST /reindex`, `POST /reindex/:uid` with RBAC actions
  `plugin::opensearch.read` and `plugin::opensearch.reindex`.
- Public search endpoint `GET /api/opensearch/search/:index` with whitelisted parameters,
  filters and sort, automatic `.keyword` resolution, pagination and HTML-safe highlighting.
- Admin settings page (Settings → OpenSearch → Indices) with cluster status, counts, reindex and
  last result, in English and Italian.
- Unit tests and integration tests against a real OpenSearch container.

[1.0.0]: https://github.com/davideddr/strapi-plugin-opensearch/releases/tag/v1.0.0
