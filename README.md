# strapi-plugin-opensearch

OpenSearch integration for **Strapi 5**: published content is indexed in real time, and searched
through a controlled, whitelisted API endpoint. OpenSearch stays private: clients never send raw
query DSL.

- Real-time sync of **published** entries via a Document Service middleware (publish, unpublish,
  update, delete, bulk actions of the Content Manager, i18n locales).
- One index per content type × locale, with the language analyzer of the locale (`italian`,
  `english`, …).
- Zero-downtime reindex: versioned physical indices behind an alias, atomic alias swap.
- Public search endpoint `GET /api/opensearch/search/:index` with whitelisted filters and sort,
  pagination and safe highlighting, permission managed in Users & Permissions.
- Admin settings page (Settings → OpenSearch → Indices): cluster status, document counts per
  index vs published entries in Strapi, Reindex buttons, RBAC permissions.
- Basic auth (self-hosted, Docker, VM) or AWS SigV4 (Amazon OpenSearch Service).

## Requirements

|            | Version                       |
| ---------- | ----------------------------- |
| Strapi     | 5.x (tested with 5.61.1)      |
| Node.js    | 22, 24 or 26                  |
| OpenSearch | 2.x / 3.x (tested with 3.9.0) |

## Installation

```bash
npm install @davideddr/strapi-plugin-opensearch
```

For AWS SigV4 authentication also install the AWS credential provider (optional peer dependency):

```bash
npm install @aws-sdk/credential-provider-node
```

Then configure the plugin in `config/plugins.ts` and restart Strapi. On startup the plugin pings the
cluster and creates the missing indices; a cluster that is down only logs a warning and never stops
Strapi.

## Configuration

`config/plugins.ts`:

```ts
export default ({ env }) => ({
  opensearch: {
    enabled: true,
    config: {
      connection: {
        node: env('OPENSEARCH_NODE'), // e.g. https://localhost:9200
        auth: {
          type: 'basic',
          username: env('OPENSEARCH_USER'),
          password: env('OPENSEARCH_PASSWORD'),
        },
        ssl: { rejectUnauthorized: true, ca: env('OPENSEARCH_CA', undefined) },
      },
      indexPrefix: env('OPENSEARCH_INDEX_PREFIX', 'strapi'),
      contentTypes: {
        'api::article.article': {
          locales: 'all',
          populate: { category: true, cover: true },
          search: {
            fields: ['title^3', 'excerpt^2', 'body'],
            filterable: ['category.slug', 'tags'],
            sortable: ['publishedAt', 'title'],
          },
        },
      },
    },
  },
});
```

The configuration is validated at startup: an invalid value stops Strapi with the list of problems,
and an unknown content type uid stops it in `bootstrap`. Keep secrets in environment variables.

### Global options

| Option                              | Default        | Description                                                                                                                 |
| ----------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `connection.node`                   | — (required)   | Cluster URL, `http://` or `https://`.                                                                                       |
| `connection.auth`                   | — (required)   | `{ type: 'basic', username, password }` or `{ type: 'aws-sigv4', region, service }`.                                        |
| `connection.ssl.rejectUnauthorized` | `true`         | Set to `false` only for local self-signed certificates.                                                                     |
| `connection.ssl.ca`                 | —              | CA certificate: PEM content or path to a PEM file.                                                                          |
| `connection.requestTimeout`         | client default | Request timeout in ms.                                                                                                      |
| `connection.maxRetries`             | client default | Retries on connection errors.                                                                                               |
| `indexPrefix`                       | `'strapi'`     | Prefix of every index and alias. Use one per project/environment on a shared cluster (lowercase letters, digits, `-`, `_`). |
| `bulkSize`                          | `500`          | Entries per page and per `_bulk` request during a reindex.                                                                  |
| `search.defaultPageSize`            | `10`           | Page size when `pageSize` is not given.                                                                                     |
| `search.maxPageSize`                | `100`          | Largest `pageSize` accepted.                                                                                                |

### Self-hosted (basic auth)

```ts
connection: {
  node: env('OPENSEARCH_NODE'),
  auth: { type: 'basic', username: env('OPENSEARCH_USER'), password: env('OPENSEARCH_PASSWORD') },
  ssl: { ca: env('OPENSEARCH_CA', undefined) }, // or rejectUnauthorized: false in local development only
},
```

### Amazon OpenSearch Service (AWS SigV4)

```ts
connection: {
  node: env('OPENSEARCH_NODE'), // https://search-my-domain-xxxx.eu-west-1.es.amazonaws.com
  auth: { type: 'aws-sigv4', region: env('AWS_REGION'), service: 'es' },
},
```

Credentials come from the default AWS provider chain (environment variables, shared profile, ECS/EKS
task role, EC2 instance profile): nothing secret goes in the config. The role needs `es:ESHttp*`
on the domain (or the matching fine-grained access control mapping).

`service: 'aoss'` targets **OpenSearch Serverless**: use a _search_ collection (time-series
collections do not accept custom document ids). Serverless has not been tested with this plugin
yet, and it does not support every API the plugin uses (see [Known limitations](#known-limitations)).

### Content type options

Each key of `contentTypes` is a content type uid. Only configured content types are indexed.

| Option              | Default            | Description                                                                                                           |
| ------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `indexName`         | `singularName`     | Name used in the alias and in the search URL (`/search/:indexName`).                                                  |
| `locales`           | `'all'`            | `'all'` or a list of locale codes (`['it', 'en']`). Ignored when i18n is off for the content type.                    |
| `populate`          | none               | `populate` passed to the Document Service when loading an entry (relations, media, components).                       |
| `filter`            | —                  | `(entry, { uid, locale }) => boolean \| Promise<boolean>`: `false` excludes the entry (it is removed from the index). |
| `transform`         | entry without `id` | `(entry, { uid, locale }) => object \| Promise<object>`: the document to index.                                       |
| `mappings`          | dynamic            | Explicit index mappings, merged with the base mapping.                                                                |
| `settings`          | language analyzer  | Index settings, deep-merged over the defaults (e.g. a custom `analysis`).                                             |
| `search.fields`     | — (required)       | Fields of the full-text query, with optional boosts (`title^3`).                                                      |
| `search.filterable` | `[]`               | Fields accepted in `filters[...]`.                                                                                    |
| `search.sortable`   | `[]`               | Fields accepted in `sort` (`_score` is always allowed).                                                               |

**Index naming.** Alias `{indexPrefix}_{indexName}_{locale}` (or `{indexPrefix}_{indexName}` without
i18n), pointing to a physical index `{alias}_v{timestamp}`. The document `_id` is the Strapi
`documentId`.

**What gets indexed.** Only the **published** version of each entry (every entry for content types
without Draft & Publish), with the configured `populate`. The entry is sanitized with the Content
API output sanitizer first, so private fields and passwords never reach OpenSearch, and
`filter`/`transform` never see them. Every document always carries `documentId`, `locale`,
`publishedAt` and `updatedAt` (mapped as `keyword` / `date`), whatever `transform` returns.

**`filter` and `transform`** are plain functions in your config file, so keep them pure and fast:
they run on every publish and for every entry during a reindex. The entry they receive still has
the database `id`, which differs between the draft and published rows: drop it in a custom
`transform`.

```ts
'api::article.article': {
  populate: { category: true, author: { fields: ['name'] } },
  filter: (entry) => entry.noindex !== true,
  transform: (entry) => ({
    title: entry.title,
    excerpt: entry.excerpt,
    body: entry.body,
    slug: entry.slug,
    tags: entry.tags,
    category: entry.category && { name: entry.category.name, slug: entry.category.slug },
    author: entry.author?.name,
  }),
  search: { fields: ['title^3', 'excerpt^2', 'body'], filterable: ['category.slug', 'tags'], sortable: ['publishedAt', 'title'] },
},
```

**Filterable and sortable fields** are written as in the document (`tags`, `category.slug`). With
dynamic mapping a string becomes a `text` field with a `.keyword` sub-field: the plugin detects it
and filters/sorts on `.keyword` automatically. A `text` field _without_ a `keyword` sub-field (for
example an explicit mapping) cannot be sorted: map it as `keyword` or add a sub-field.

## Search endpoint

```
GET /api/opensearch/search/:index
```

`:index` is the `indexName` of a configured content type (default: its `singularName`).

**Permission.** The action is listed in _Settings → Users & Permissions → Roles → Opensearch →
search_. It is off by default: enable it for **Public** to allow anonymous search, or for
Authenticated only. Without it the endpoint answers 403.

| Parameter              | Description                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`                    | Full-text query (max 500 characters). Empty or absent: all documents.                                                                                                 |
| `locale`               | Locale to search. Default: the Strapi default locale. Not allowed on non-localized content types.                                                                     |
| `filters[field]=value` | Exact match on a `filterable` field. Repeat it, or use `filters[field][]=`, for any of several values. `filters[category][slug]=x` equals `filters[category.slug]=x`. |
| `sort`                 | `field:asc` or `field:desc`, comma separated (`sort=publishedAt:desc,_score:desc`). Only `sortable` fields and `_score`.                                              |
| `page`, `pageSize`     | Pagination, 1-based. `pageSize ≤ search.maxPageSize`, `page × pageSize ≤ 10000`.                                                                                      |
| `highlight`            | `true` adds `_highlight` with HTML fragments (matches in `<em>`, source text escaped).                                                                                |

Any other parameter, filter or sort field returns **400** with the allowed values in
`error.details.allowed`. An unknown `:index` returns **404**. Cluster errors return a generic
**503** (details only in the Strapi log).

```bash
curl -G 'http://localhost:1337/api/opensearch/search/article' \
  --data-urlencode 'q=ricetta' \
  -d locale=it -d 'filters[category.slug]=cucina' -d sort=publishedAt:desc \
  -d page=1 -d pageSize=5 -d highlight=true
```

```json
{
  "data": [
    {
      "documentId": "k2v7…",
      "locale": "it",
      "title": "Ricetta della carbonara",
      "category": { "name": "Cucina", "slug": "cucina" },
      "publishedAt": "2026-11-10T09:12:00.000Z",
      "updatedAt": "2026-11-10T09:12:00.000Z",
      "_score": 7.31,
      "_highlight": { "title": ["<em>Ricetta</em> della carbonara"] }
    }
  ],
  "meta": { "pagination": { "page": 1, "pageSize": 5, "pageCount": 4, "total": 17 } }
}
```

### Example of integration from Nuxt app

```ts
// composables/useArticleSearch.ts
export const useArticleSearch = (q: Ref<string>, page: Ref<number>) => {
  const config = useRuntimeConfig();
  const { locale } = useI18n();

  return useFetch('/api/opensearch/search/article', {
    baseURL: config.public.strapiUrl, // e.g. https://cms.example.com
    query: {
      q,
      locale,
      page,
      pageSize: 10,
      highlight: true,
      'filters[category.slug]': 'cucina',
    },
    watch: [q, page, locale],
  });
};
```

```vue
<script setup lang="ts">
const q = ref('');
const page = ref(1);
const { data, status } = await useArticleSearch(q, page);
</script>

<template>
  <input v-model.trim="q" type="search" aria-label="Search articles" />
  <p v-if="status === 'pending'">Searching…</p>
  <ul v-else>
    <li v-for="hit in data?.data" :key="hit.documentId">
      <!-- safe: highlights are HTML-escaped by OpenSearch, only <em> is markup -->
      <span v-html="hit._highlight?.title?.[0] ?? hit.title" />
    </li>
  </ul>
</template>
```

Debounce `q` in a real search box, and set the query only from fields of your own UI: the endpoint
rejects anything outside the whitelist anyway.

## Admin panel and permissions

_Settings → OpenSearch → Indices_ shows the cluster connection, and for every content type and
locale the alias, the physical index, the documents in the index and the published entries in
Strapi (a configured `filter` can make the first lower), plus the last reindex result.

Two RBAC actions, under _Settings → Administration panel → Roles → Plugins → Opensearch_:

| Action      | Allows                                                                              |
| ----------- | ----------------------------------------------------------------------------------- |
| Read status | Seeing the page, `GET /opensearch/status`                                           |
| Reindex     | The Reindex buttons, `POST /opensearch/reindex` and `POST /opensearch/reindex/:uid` |

Super Admins have both. The admin routes are protected by these permissions even if called directly.

## Reindex

The real-time sync keeps the indices aligned while Strapi runs. Reindex when:

- the plugin is installed on existing content, or a content type is added to the config;
- `populate`, `transform`, `filter`, `mappings` or `settings` change;
- OpenSearch was unreachable while entries were published (the sync logs the error and moves on);
- a related entry changed (see limitations).

Use **Reindex** (one content type) or **Reindex all** in the admin page. A reindex runs in the
background, per locale: new versioned index → published entries in pages of `bulkSize` → `_bulk` →
refresh → atomic alias swap → old versions deleted. Searches keep working on the old index until
the swap, and publishes made during the reindex are written to both indices. A locale that fails
(cluster error) keeps its previous index; single documents that fail are counted and logged
without stopping the swap. Starting a reindex of a content type already being reindexed returns 409.

## Known limitations

- **Relations are not updated in cascade.** When a related entry changes (e.g. a category name),
  the documents that embed it keep the old value until they are published again or reindexed.
- **Reindex lock and last result are in memory, per process.** With several Strapi instances,
  two reindexes of the same content type on different instances are not prevented, and the admin
  page shows the last reindex of the instance that served it. The last result is lost on restart.
- **Real-time sync is best effort.** If OpenSearch is down when an entry is published, the change
  is logged and not retried: run a reindex after the outage.
- **Only published content** is indexed: there is no search on drafts.
- **Sorting on `text` fields** needs a `.keyword` sub-field (present with dynamic mapping).
- **OpenSearch Serverless** (`service: 'aoss'`) is untested; it does not support every API used
  here (e.g. manual `_refresh`), so reindex may not work there. AWS SigV4 on OpenSearch Service is
  implemented with the official client signer but has not been tested against a real domain yet.

See [ROADMAP.md](ROADMAP.md) for the planned work.

## Development

```bash
nvm use                                         # Node 24
npm install
cp dev/.env.example dev/.env                    # set a strong password
docker compose -f dev/docker-compose.yml up -d  # OpenSearch 3.9 on https://localhost:9200

npm test                  # unit + integration (integration skipped if OpenSearch is down)
npm run test:integration  # integration only, fails if OpenSearch is down
npm run test:ts:back && npm run test:ts:front
npm run lint && npm run format:check
npm run build && npm run verify
npm run watch:link        # link into a Strapi app with yalc
```

The integration tests use `https://localhost:9200` with user `admin` and the password of
`dev/.env`; override with `OPENSEARCH_TEST_NODE`, `OPENSEARCH_TEST_USER`, `OPENSEARCH_TEST_PASSWORD`.

## License

[MIT](LICENSE)
