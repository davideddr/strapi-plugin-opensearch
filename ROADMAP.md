# Roadmap

Planned work after `1.0.0`, grouped by target version. Versions and scope may change; the
[Known limitations](README.md#known-limitations) of the current release are the starting point.

## 0.2 — Search analytics

- **Query log**: every call to the search endpoint records the query, index, locale, filters,
  number of results and timestamp in a dedicated `{indexPrefix}_analytics` index, written
  asynchronously so it never slows down the search. No personal data (IP, user) is stored.
- **Admin dashboard**: top queries and queries with no results, per index and locale, over a
  selectable period.
- **Retention**: a configurable retention period, with old entries deleted automatically.
- **Opt-out**: analytics can be disabled from the config.

## 0.3 — Reliability

- **Sync retry**: failed sync operations go to a persistent queue (plugin table or plugin store)
  and are retried with backoff, instead of being only logged. The admin page shows the pending
  count.
- **Multi-instance reindex lock**: a lock document in a `{indexPrefix}_locks` index, created with
  `op_type: create` and an expiry, replaces the in-memory lock, so two Strapi instances cannot
  reindex the same content type at the same time.
- **Persistent last reindex result**: stored outside the process memory, visible from every
  instance and after a restart.
- **Cascade updates for relations (`dependsOn`)**: when a related entry changes (e.g. a category
  name), re-index the documents that embed it, found with a `terms` query on the relation field.

## 0.4 — Richer search

- **Facets**: `facets=category.slug,tags` returns `terms` aggregations with counts, only on
  `filterable` fields.
- **Range filters** on dates and numbers (`filters[publishedAt][$gte]=…`), with a whitelist of
  operators.
- **Typo tolerance**: configurable `fuzziness` (e.g. `AUTO`) on the full-text query.
- **Autocomplete**: `search_as_you_type` on selected fields and a `GET /suggest/:index` endpoint.
- **Multi-index search**: `/search?indices=article,page`, each hit tagged with its index.
- **Field selection**: `fields` to limit the fields returned in each hit.

## 0.5 — Advanced configuration UI

Configure indexing from the admin panel, in the spirit of the Meilisearch plugin, instead of only
from `config/plugins.ts`.

- **Hybrid model**: settings saved in the plugin store and merged with the file config. The file
  stays the source for the connection and for `filter` / `transform` (functions), and can lock
  keys so the UI cannot change them.
- **Per content type**: enable or disable indexing, locales, index name, `populate` picked from
  the content type schema (relations, components, media), searchable fields with boosts and their
  order, filterable and sortable fields.
- **Relevance settings**: synonyms, stop words, language analyzer, typo tolerance, highlighted
  fields.
- **Document preview**: runs the document builder on a chosen entry and shows the JSON that would
  be indexed.
- **Search playground**: a search box on an index with filters, sort, `_score` and highlights, to
  tune the boosts.
- **"Reindex needed" state**: changes that affect mappings, settings or `populate` flag the
  content type, with a reindex button.
- **Export / import** of the settings as JSON, to version them and move them between
  environments.
- **New RBAC action** `settings`, next to `read` and `reindex`.
