import { describe, expect, it, vi } from 'vitest';
import search from './search';
import { SearchParamsError, UnknownIndexError } from '../utils/search-query';

const ARTICLE = 'api::article.article';
const CATEGORY = 'api::category.category';

const PAGE = 'api::page.page';

const setup = ({ articleLocales = ['en', 'it'] as (string | null)[], defaultLocale = 'en' } = {}) => {
  const config: Record<string, unknown> = {
    contentTypes: {
      [ARTICLE]: {
        search: { fields: ['title^3', 'body'], filterable: ['tags'], sortable: ['publishedAt'] },
      },
      [CATEGORY]: { indexName: 'categories', search: { fields: ['name'] } },
      [PAGE]: {
        search: { fields: ['title^2', 'content'], filterable: ['tags', 'slug'], sortable: ['publishedAt'] },
      },
    },
    search: { defaultPageSize: 10, maxPageSize: 50 },
  };
  const client = {
    fieldCaps: vi.fn(async () => ({ body: { fields: { tags: { text: {} }, 'tags.keyword': { keyword: {} } } } })),
    search: vi.fn(async () => ({
      body: {
        hits: {
          total: { value: 1 },
          hits: [{ _index: 'strapi_article_en_v1', _source: { documentId: 'x' }, _score: 2 }],
        },
      },
    })),
    msearch: vi.fn(async ({ body }: { body: unknown[] }) => ({
      body: {
        responses: Array.from({ length: body.length / 2 }, (_, i) => ({
          hits: { total: { value: i + 1 }, hits: [{ _source: { documentId: `d${i}` }, _score: 1 }] },
        })),
      },
    })),
  };
  const names: Record<string, string> = { [ARTICLE]: 'article', [CATEGORY]: 'categories', [PAGE]: 'page' };
  const indexManager = {
    getLocales: vi.fn(async (uid: string) => (uid === ARTICLE ? articleLocales : [null])),
    getAliasName: vi.fn((uid: string, locale: string | null) =>
      ['strapi', names[uid], locale].filter(Boolean).join('_'),
    ),
  };
  const services: Record<string, unknown> = {
    client: { getClient: () => client },
    'index-manager': indexManager,
  };
  const strapi = {
    plugin: (name: string) =>
      name === 'i18n'
        ? { service: () => ({ getDefaultLocale: async () => defaultLocale }) }
        : { service: (s: string) => services[s], config: (key: string) => config[key] },
    contentType: (uid: string) => ({ info: { singularName: uid === CATEGORY ? 'category' : names[uid] } }),
  };
  return { service: search({ strapi } as never), client, indexManager };
};

describe('search service', () => {
  it('maps the configured index name to its alias, never a physical name', async () => {
    const { service, client } = setup();
    const result = await service.search('article', { q: 'hi', locale: 'it' });
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ index: 'strapi_article_it' }));
    expect(result).toEqual({
      data: [{ documentId: 'x', _score: 2 }],
      meta: { pagination: { page: 1, pageSize: 10, pageCount: 1, total: 1 } },
    });
  });

  it('uses the custom indexName and rejects the singularName or a physical index', async () => {
    const { service, client } = setup();
    await service.search('categories', {});
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ index: 'strapi_categories' }));
    await expect(service.search('category', {})).rejects.toBeInstanceOf(UnknownIndexError);
    await expect(service.search('strapi_article_it', {})).rejects.toBeInstanceOf(UnknownIndexError);
  });

  it('defaults to the Strapi default locale', async () => {
    const { service, client } = setup();
    await service.search('article', {});
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ index: 'strapi_article_en' }));
  });

  it('rejects a locale that is not indexed, or any locale on a non localized index', async () => {
    const { service } = setup();
    await expect(service.search('article', { locale: 'fr' })).rejects.toThrow(/Locale not available: fr/);
    await expect(service.search('categories', { locale: 'en' })).rejects.toBeInstanceOf(SearchParamsError);
  });

  it('asks for a locale when the default one is not indexed', async () => {
    const { service } = setup({ articleLocales: ['it'], defaultLocale: 'en' });
    await expect(service.search('article', {})).rejects.toThrow(/"locale" is required/);
  });

  it('resolves filters to the keyword sub-field and caches field caps', async () => {
    const { service, client } = setup();
    await service.search('article', { filters: { tags: 'x' } });
    await service.search('article', { filters: { tags: 'y' } });
    expect(client.fieldCaps).toHaveBeenCalledTimes(1);
    expect(client.fieldCaps).toHaveBeenCalledWith({ index: 'strapi_article_en', fields: ['tags', 'tags.keyword'] });
    const calls = client.search.mock.calls as unknown as [{ body: { query: { bool: { filter: unknown[] } } } }][];
    expect(calls[1][0].body.query.bool.filter).toEqual([{ term: { 'tags.keyword': 'y' } }]);
  });

  it('skips field caps without filters or field sort', async () => {
    const { service, client } = setup();
    await service.search('article', { q: 'x', sort: '_score:desc' });
    expect(client.fieldCaps).not.toHaveBeenCalled();
  });

  it('validates parameters before touching the cluster', async () => {
    const { service, client, indexManager } = setup();
    await expect(service.search('article', { filters: { body: 'x' } })).rejects.toBeInstanceOf(SearchParamsError);
    await expect(service.search('article', { pageSize: '51' })).rejects.toThrow(/at most 50/);
    expect(indexManager.getLocales).not.toHaveBeenCalled();
    expect(client.search).not.toHaveBeenCalled();
  });
});

describe('multi-index search', () => {
  type SearchCall = [{ index: string[]; body: { query: { bool: { should: { bool: { filter: unknown[] } }[] } } } }];

  it('runs one query on the aliases and tags each hit with its index name', async () => {
    const { service, client } = setup();
    const result = await service.multiSearch({ indices: 'article,categories', q: 'hi' });
    const [[call]] = client.search.mock.calls as unknown as SearchCall[];
    // locale: default on the localized index, ignored on the other one.
    expect(call.index).toEqual(['strapi_article_en', 'strapi_categories']);
    expect(call.body.query.bool.should).toHaveLength(2);
    expect(result).toEqual({
      data: [{ documentId: 'x', _index: 'article', _score: 2 }],
      meta: { pagination: { page: 1, pageSize: 10, pageCount: 1, total: 1 } },
    });
  });

  it('applies locale only to localized indices', async () => {
    const { service, client } = setup();
    await service.multiSearch({ indices: 'article,categories', locale: 'it' });
    const [[call]] = client.search.mock.calls as unknown as SearchCall[];
    expect(call.index).toEqual(['strapi_article_it', 'strapi_categories']);
    await expect(service.multiSearch({ indices: 'article,page', locale: 'fr' })).rejects.toThrow(
      /Locale not available on "article": fr/,
    );
  });

  it('requires indices and rejects unknown ones', async () => {
    const { service, client } = setup();
    await expect(service.multiSearch({ q: 'x' })).rejects.toThrow(/"indices" is required/);
    await expect(service.multiSearch({ indices: 'article,nope' })).rejects.toBeInstanceOf(UnknownIndexError);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('allows only filters and sort shared by every requested index', async () => {
    const { service, client } = setup();
    await service.multiSearch({ indices: 'article,page', filters: { tags: 'x' }, sort: 'publishedAt:desc' });
    const [[call]] = client.search.mock.calls as unknown as SearchCall[];
    expect(call.body.query.bool.should[0].bool.filter).toEqual([
      { term: { _index: 'strapi_article_en' } },
      { term: { 'tags.keyword': 'x' } },
    ]);

    const error = await service.multiSearch({ indices: 'article,page', filters: { slug: 'x' } }).catch((e) => e);
    expect(error).toBeInstanceOf(SearchParamsError);
    expect(error.details).toEqual({ allowed: ['tags'] });
    await expect(service.multiSearch({ indices: 'article,categories', sort: 'publishedAt' })).rejects.toThrow(
      /Sort not allowed/,
    );
  });

  it('rejects a sort field mapped differently on the requested indices', async () => {
    const { service, client } = setup();
    client.fieldCaps.mockImplementation((async ({ index }: { index: string }) => ({
      body: {
        fields:
          index === 'strapi_page'
            ? { publishedAt: { date: {} } }
            : { publishedAt: { text: {} }, 'publishedAt.keyword': { keyword: {} } },
      },
    })) as never);
    await expect(service.multiSearch({ indices: 'article,page', sort: 'publishedAt' })).rejects.toThrow(
      /mapped differently/,
    );
  });

  it('group=true runs one msearch and returns one result set per index, in order', async () => {
    const { service, client } = setup();
    const result = await service.multiSearch({ indices: 'page,article', group: 'true', q: 'x', pageSize: '3' });
    expect(client.search).not.toHaveBeenCalled();
    const [[{ body }]] = client.msearch.mock.calls as unknown as [{ body: Record<string, unknown>[] }][];
    expect(body.filter((_, i) => i % 2 === 0)).toEqual([{ index: 'strapi_page' }, { index: 'strapi_article_en' }]);
    expect(body[1]).toMatchObject({ size: 3 });
    expect(Object.keys((result as { data: object }).data)).toEqual(['page', 'article']);
    expect(result).toMatchObject({
      data: {
        page: { data: [{ documentId: 'd0', _score: 1 }], meta: { pagination: { total: 1, pageSize: 3 } } },
        article: { meta: { pagination: { total: 2 } } },
      },
    });
  });

  it('group=true fails when one index fails (the controller answers 503)', async () => {
    const { service, client } = setup();
    client.msearch.mockResolvedValueOnce({
      body: { responses: [{ hits: { total: 0, hits: [] } }, { error: { type: 'index_not_found_exception' } }] },
    } as never);
    await expect(service.multiSearch({ indices: 'page,article', group: 'true' })).rejects.toThrow(
      /index_not_found_exception/,
    );
  });
});
