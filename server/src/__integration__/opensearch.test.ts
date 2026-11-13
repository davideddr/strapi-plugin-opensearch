/**
 * Integration tests against a real OpenSearch (the `dev/docker-compose.yml` container).
 *
 * The plugin services run for real (client, index-manager, document-builder, indexer, search,
 * status); only Strapi is replaced by an in-memory store of entries. Every run uses its own
 * `indexPrefix` and deletes its indices at the end.
 *
 * Connection: `OPENSEARCH_TEST_NODE` (default `https://localhost:9200`), `OPENSEARCH_TEST_USER`
 * (default `admin`), `OPENSEARCH_TEST_PASSWORD` (default: `OPENSEARCH_INITIAL_ADMIN_PASSWORD` from
 * `dev/.env`). When the cluster is unreachable the suite is skipped, unless
 * `OPENSEARCH_TEST_REQUIRED=1` (`npm run test:integration`), which makes it fail instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@opensearch-project/opensearch';
import services from '../services';
import type { PluginConfig } from '../types';
import { SearchParamsError, UnknownIndexError } from '../utils/search-query';

const ARTICLE = 'api::article.article';
const PAGE = 'api::page.page';

const readDevPassword = (): string | undefined => {
  const file = resolve(__dirname, '../../../dev/.env');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('OPENSEARCH_INITIAL_ADMIN_PASSWORD='));
  return line?.slice(line.indexOf('=') + 1).trim();
};

const connection = {
  node: process.env.OPENSEARCH_TEST_NODE ?? 'https://localhost:9200',
  auth: {
    type: 'basic' as const,
    username: process.env.OPENSEARCH_TEST_USER ?? 'admin',
    password: process.env.OPENSEARCH_TEST_PASSWORD ?? readDevPassword() ?? '',
  },
  // The dev container uses a self-signed certificate.
  ssl: { rejectUnauthorized: false },
  requestTimeout: 10_000,
  maxRetries: 0,
};

const prefix = `itest${Date.now()}`;

// ---------------------------------------------------------------------------------------------
// In-memory Strapi
// ---------------------------------------------------------------------------------------------

interface Row {
  id: number;
  documentId: string;
  locale: string | null;
  publishedAt: string | null;
  updatedAt: string;
  [field: string]: unknown;
}

const createStrapi = () => {
  const rows = new Map<string, Row[]>([
    [ARTICLE, []],
    [PAGE, []],
  ]);
  let nextId = 1;
  /** Called by `findMany` before returning a page (used to simulate writes during a reindex). */
  let onFindMany: ((call: number) => Promise<void>) | null = null;
  let findManyCalls = 0;

  const config: PluginConfig = {
    connection,
    indexPrefix: prefix,
    bulkSize: 3,
    contentTypes: {
      [ARTICLE]: {
        locales: 'all',
        filter: (entry) => entry.hidden !== true,
        transform: (entry) => {
          const { id: _id, hidden: _hidden, internalNote: _note, ...rest } = entry;
          return rest;
        },
        search: {
          fields: ['title^3', 'body'],
          filterable: ['category.slug', 'tags'],
          sortable: ['publishedAt', 'title'],
        },
      },
      [PAGE]: { indexName: 'pages', search: { fields: ['title'] } },
    },
    search: { defaultPageSize: 10, maxPageSize: 50 },
  };

  const contentTypes: Record<string, unknown> = {
    [ARTICLE]: {
      info: { singularName: 'article', displayName: 'Article' },
      pluginOptions: { i18n: { localized: true } },
    },
    [PAGE]: { info: { singularName: 'page', displayName: 'Page' }, pluginOptions: {} },
  };

  const instances: Record<string, unknown> = {};
  const strapi: Record<string, unknown> = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    contentType: (uid: string) => contentTypes[uid],
    getModel: (uid: string) => contentTypes[uid],
    contentAPI: { sanitize: { output: async (entry: unknown) => structuredClone(entry) } },
    plugin: (name: string) => {
      if (name === 'i18n') {
        return {
          service: () => ({
            find: async () => [{ code: 'it' }, { code: 'en' }],
            getDefaultLocale: async () => 'it',
          }),
        };
      }
      return {
        config: (key: keyof PluginConfig) => config[key],
        service: (service: keyof typeof services) => {
          instances[service] ??= services[service]({ strapi } as never);
          return instances[service];
        },
      };
    },
    documents: (uid: string) => {
      const published = (locale?: string) =>
        rows.get(uid)!.filter((r) => r.publishedAt !== null && (locale === undefined || r.locale === locale));
      return {
        findOne: async ({ documentId, locale }: { documentId: string; locale?: string }) =>
          published(locale).find((r) => r.documentId === documentId) ?? null,
        findMany: async ({
          locale,
          filters,
          limit,
        }: {
          locale?: string;
          filters: { id: { $gt: number } };
          limit: number;
        }) => {
          const page = published(locale)
            .filter((r) => r.id > filters.id.$gt)
            .sort((a, b) => a.id - b.id)
            .slice(0, limit)
            .map((r) => structuredClone(r));
          findManyCalls += 1;
          if (onFindMany) await onFindMany(findManyCalls);
          return page;
        },
        count: async ({ locale }: { locale?: string }) => published(locale).length,
      };
    },
  };

  // Services are untyped in Strapi's registry: tests read their results loosely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = <T = any>(name: keyof typeof services): T =>
    (strapi.plugin as (n: string) => { service: (s: string) => T })('opensearch').service(name);

  return {
    strapi,
    service,
    /** Upserts the published (or draft, `publishedAt: null`) version of a document in one locale. */
    save(uid: string, documentId: string, locale: string | null, fields: Record<string, unknown>, publish = true) {
      const list = rows.get(uid)!;
      const existing = list.find((r) => r.documentId === documentId && r.locale === locale);
      const row: Row = {
        id: existing?.id ?? nextId++,
        documentId,
        locale,
        publishedAt: publish ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
        ...fields,
      };
      if (existing) list.splice(list.indexOf(existing), 1, row);
      else list.push(row);
    },
    remove(uid: string, documentId: string, locale: string | null) {
      const list = rows.get(uid)!;
      const index = list.findIndex((r) => r.documentId === documentId && r.locale === locale);
      if (index >= 0) list.splice(index, 1);
    },
    setOnFindMany(hook: typeof onFindMany) {
      onFindMany = hook;
      findManyCalls = 0;
    },
  };
};

// ---------------------------------------------------------------------------------------------

const env = createStrapi();
const client = (): Client => env.service('client').getClient();
const alias = (name: string) => `${prefix}_${name}`;

const reachable = await (async () => {
  try {
    await env.service('client').ping();
    return true;
  } catch (error) {
    if (process.env.OPENSEARCH_TEST_REQUIRED === '1') {
      // eslint-disable-next-line preserve-caught-error -- the server tsconfig lib has no ErrorOptions
      throw new Error(`OpenSearch not reachable at ${connection.node}: ${(error as Error).message}`);
    }
    console.warn(
      `[integration] OpenSearch not reachable at ${connection.node}, suite skipped ` +
        `(docker-compose -f dev/docker-compose.yml up -d)`,
    );
    return false;
  }
})();

const refresh = (index: string) => client().indices.refresh({ index });
const getDoc = async (index: string, id: string) => {
  try {
    return (await client().get({ index, id })).body._source as Record<string, unknown>;
  } catch (error) {
    if ((error as { meta?: { statusCode?: number } }).meta?.statusCode === 404) return null;
    throw error;
  }
};
const aliasIndices = async (name: string): Promise<string[]> => env.service('index-manager').getAliasIndices(name);

describe.skipIf(!reachable)('integration — OpenSearch', () => {
  beforeAll(async () => {
    await env.service('index-manager').ensureIndices();
  });

  afterAll(async () => {
    await client()
      .indices.delete({ index: `${prefix}_*` })
      .catch(() => {});
    await env.service('client').close();
  });

  describe('index manager', () => {
    it('creates one versioned index per content type × locale behind an alias', async () => {
      for (const name of ['article_it', 'article_en', 'pages']) {
        const indices = await aliasIndices(alias(name));
        expect(indices).toHaveLength(1);
        expect(indices[0]).toMatch(new RegExp(`^${alias(name)}_v\\d+$`));
      }
    });

    it('applies the language analyzer of the locale and the fixed base mapping', async () => {
      const [index] = await aliasIndices(alias('article_it'));
      const { body } = await client().indices.get({ index });
      const { settings, mappings } = body[index];
      expect(settings.index?.analysis?.analyzer?.default?.type).toBe('italian');
      expect(mappings.properties?.documentId?.type).toBe('keyword');
      expect(mappings.properties?.publishedAt?.type).toBe('date');
    });

    it('is idempotent', async () => {
      const before = await aliasIndices(alias('pages'));
      await env.service('index-manager').ensureIndices();
      expect(await aliasIndices(alias('pages'))).toEqual(before);
    });
  });

  describe('real-time index / remove', () => {
    it('indexes the published version with _id = documentId and the base fields', async () => {
      env.save(ARTICLE, 'a1', 'it', { title: 'Ciao mondo', body: 'primo articolo', internalNote: 'x' });
      expect(await env.service('indexer').indexOne(ARTICLE, 'a1', 'it')).toBe('indexed');

      const doc = await getDoc(alias('article_it'), 'a1');
      expect(doc).toMatchObject({ documentId: 'a1', locale: 'it', title: 'Ciao mondo' });
      expect(doc).not.toHaveProperty('internalNote');
      expect(doc).not.toHaveProperty('id');
      expect(typeof doc?.publishedAt).toBe('string');
      // Other locales untouched.
      expect(await getDoc(alias('article_en'), 'a1')).toBeNull();
    });

    it('updates the document in place', async () => {
      env.save(ARTICLE, 'a1', 'it', { title: 'Ciao mondo aggiornato', body: 'primo articolo' });
      await env.service('indexer').indexOne(ARTICLE, 'a1', 'it');
      expect((await getDoc(alias('article_it'), 'a1'))?.title).toBe('Ciao mondo aggiornato');
    });

    it('removes the document when it is no longer published or is filtered out', async () => {
      env.save(ARTICLE, 'a2', 'it', { title: 'Nascosto', body: 'x' });
      await env.service('indexer').indexOne(ARTICLE, 'a2', 'it');
      expect(await getDoc(alias('article_it'), 'a2')).not.toBeNull();

      env.save(ARTICLE, 'a2', 'it', { title: 'Nascosto', body: 'x', hidden: true });
      expect(await env.service('indexer').indexOne(ARTICLE, 'a2', 'it')).toBe('removed');
      expect(await getDoc(alias('article_it'), 'a2')).toBeNull();

      env.save(ARTICLE, 'a3', 'it', { title: 'Bozza', body: 'x' }, false);
      expect(await env.service('indexer').indexOne(ARTICLE, 'a3', 'it')).toBe('removed');
      expect(await getDoc(alias('article_it'), 'a3')).toBeNull();
    });

    it('removeOne deletes the document and ignores a missing one', async () => {
      env.save(ARTICLE, 'a4', 'it', { title: 'Da cancellare', body: 'x' });
      await env.service('indexer').indexOne(ARTICLE, 'a4', 'it');
      env.remove(ARTICLE, 'a4', 'it');
      await env.service('indexer').removeOne(ARTICLE, 'a4', 'it');
      expect(await getDoc(alias('article_it'), 'a4')).toBeNull();
      await expect(env.service('indexer').removeOne(ARTICLE, 'never-indexed', 'it')).resolves.toBeUndefined();
    });

    it('indexes a non-localized content type without locale', async () => {
      env.save(PAGE, 'p1', null, { title: 'Chi siamo' });
      await env.service('indexer').indexOne(PAGE, 'p1', null);
      expect(await getDoc(alias('pages'), 'p1')).toMatchObject({ documentId: 'p1', locale: null });
    });
  });

  describe('reindex', () => {
    it('rebuilds every locale in a new version, swaps the alias and drops the old index', async () => {
      // 7 articles in it (one hidden), 2 in en: several pages with bulkSize 3.
      for (let i = 1; i <= 7; i++) {
        env.save(ARTICLE, `r${i}`, 'it', {
          title: `Articolo ${i}`,
          body: i % 2 ? 'notizia sportiva' : 'ricetta di cucina',
          tags: i % 2 ? ['sport'] : ['cucina', 'ricette'],
          category: { slug: i % 2 ? 'news' : 'food' },
          hidden: i === 7,
        });
      }
      env.save(ARTICLE, 'r1', 'en', { title: 'Article one', body: 'sport news', category: { slug: 'news' } });
      env.save(ARTICLE, 'r2', 'en', { title: 'Article two', body: 'cooking', category: { slug: 'food' } });

      const before = await aliasIndices(alias('article_it'));
      const report = await env.service('indexer').reindex(ARTICLE);

      expect(report.ok).toBe(true);
      const it = report.locales.find((l: { locale: string }) => l.locale === 'it');
      // a1, a2 (hidden), r1..r7 (r7 hidden) published in it.
      expect(it).toMatchObject({ read: 9, indexed: 7, filtered: 2, failed: 0, count: 7, dropped: before });
      const after = await aliasIndices(alias('article_it'));
      expect(after).toEqual([it.index]);
      expect(after[0]).not.toBe(before[0]);
      const { body } = await client().indices.exists({ index: before[0] });
      expect(body).toBe(false);

      const en = report.locales.find((l: { locale: string }) => l.locale === 'en');
      expect(en).toMatchObject({ indexed: 2, count: 2 });
    });

    it('keeps the writes of the real-time sync made during the reindex', async () => {
      env.setOnFindMany(async (call) => {
        if (call !== 1) return;
        // Published after the first page was read: must end up in the new index.
        env.save(ARTICLE, 'live1', 'it', { title: 'Pubblicato durante il reindex', body: 'x' });
        await env.service('indexer').indexOne(ARTICLE, 'live1', 'it');
        // Unpublished after being read in the first page: must not come back.
        env.remove(ARTICLE, 'a1', 'it');
        await env.service('indexer').removeOne(ARTICLE, 'a1', 'it');
      });
      try {
        const report = await env.service('indexer').reindex(ARTICLE);
        expect(report.ok).toBe(true);
      } finally {
        env.setOnFindMany(null);
      }
      await refresh(alias('article_it'));
      expect(await getDoc(alias('article_it'), 'live1')).not.toBeNull();
      expect(await getDoc(alias('article_it'), 'a1')).toBeNull();
    });

    it('rejects a second reindex of the same content type while one is running', async () => {
      const first = env.service('indexer').reindex(PAGE);
      await expect(env.service('indexer').reindex(PAGE)).rejects.toMatchObject({ code: 'REINDEX_IN_PROGRESS' });
      expect((await first).ok).toBe(true);
    });

    it('status reports the same counts as Strapi', async () => {
      const status = await env.service('status').getStatus();
      expect(status.cluster.ok).toBe(true);
      const article = status.contentTypes.find((ct: { uid: string }) => ct.uid === ARTICLE);
      const it = article.locales.find((l: { locale: string }) => l.locale === 'it');
      // a2 and r7 are published but filtered out.
      expect(it.count).toBe(it.published - 2);
    });
  });

  describe('search', () => {
    beforeAll(async () => {
      await env.service('indexer').reindex(ARTICLE);
    });

    const search = (index: string, query: Record<string, unknown>) => env.service('search').search(index, query);

    it('finds documents with the language analyzer and paginates', async () => {
      // "notizie" matches "notizia" only through the italian stemmer.
      const result = await search('article', { q: 'notizie', pageSize: '2', page: '1' });
      expect(result.meta.pagination).toMatchObject({ page: 1, pageSize: 2, total: 3, pageCount: 2 });
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toHaveProperty('_score');

      const page2 = await search('article', { q: 'notizie', pageSize: '2', page: '2' });
      expect(page2.data).toHaveLength(1);
    });

    it('defaults to the default locale and searches the requested one', async () => {
      expect((await search('article', {})).meta.pagination.total).toBe(7);
      const en = await search('article', { locale: 'en', q: 'cooking' });
      expect(en.data.map((d: { documentId: string }) => d.documentId)).toEqual(['r2']);
    });

    it('filters on text fields through their .keyword sub-field', async () => {
      const news = await search('article', { filters: { category: { slug: 'news' } } });
      expect(news.meta.pagination.total).toBe(3);

      const tags = await search('article', { filters: { tags: ['cucina', 'sport'] } });
      // r1..r6 (r7 hidden): every one has one of the two tags.
      expect(tags.meta.pagination.total).toBe(6);
      expect((await search('article', { filters: { tags: 'ricette' } })).meta.pagination.total).toBe(3);
    });

    it('sorts on a text field through .keyword', async () => {
      const result = await search('article', { sort: 'title:desc', filters: { category: { slug: 'food' } } });
      expect(result.data.map((d: { title: string }) => d.title)).toEqual(['Articolo 6', 'Articolo 4', 'Articolo 2']);
    });

    it('returns HTML-escaped highlights', async () => {
      env.save(ARTICLE, 'x1', 'it', { title: '<b>Calcio</b> e sport', body: 'x' });
      await env.service('indexer').indexOne(ARTICLE, 'x1', 'it');
      await refresh(alias('article_it'));
      const result = await search('article', { q: 'calcio', highlight: 'true' });
      expect(result.data[0]._highlight.title[0]).toBe('&lt;b&gt;<em>Calcio</em>&lt;&#x2F;b&gt; e sport');
    });

    it('rejects parameters outside the whitelist', async () => {
      await expect(search('article', { filters: { title: 'x' } })).rejects.toBeInstanceOf(SearchParamsError);
      await expect(search('article', { sort: 'body:asc' })).rejects.toBeInstanceOf(SearchParamsError);
      await expect(search('article', { locale: 'de' })).rejects.toBeInstanceOf(SearchParamsError);
      await expect(search('article', { query: '{}' })).rejects.toBeInstanceOf(SearchParamsError);
      await expect(search('pages', { locale: 'it' })).rejects.toBeInstanceOf(SearchParamsError);
      await expect(search('missing', {})).rejects.toBeInstanceOf(UnknownIndexError);
    });

    it('searches a non-localized index by its indexName', async () => {
      const result = await search('pages', { q: 'siamo' });
      expect(result.data.map((d: { documentId: string }) => d.documentId)).toEqual(['p1']);
    });
  });
});
