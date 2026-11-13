import { describe, expect, it, vi } from 'vitest';
import search from './search';
import { SearchParamsError, UnknownIndexError } from '../utils/search-query';

const ARTICLE = 'api::article.article';
const CATEGORY = 'api::category.category';

const setup = ({ articleLocales = ['en', 'it'] as (string | null)[], defaultLocale = 'en' } = {}) => {
  const config: Record<string, unknown> = {
    contentTypes: {
      [ARTICLE]: {
        search: { fields: ['title^3', 'body'], filterable: ['tags'], sortable: ['publishedAt'] },
      },
      [CATEGORY]: { indexName: 'categories', search: { fields: ['name'] } },
    },
    search: { defaultPageSize: 10, maxPageSize: 50 },
  };
  const client = {
    fieldCaps: vi.fn(async () => ({ body: { fields: { tags: { text: {} }, 'tags.keyword': { keyword: {} } } } })),
    search: vi.fn(async () => ({
      body: { hits: { total: { value: 1 }, hits: [{ _source: { documentId: 'x' }, _score: 2 }] } },
    })),
  };
  const indexManager = {
    getLocales: vi.fn(async (uid: string) => (uid === ARTICLE ? articleLocales : [null])),
    getAliasName: vi.fn((uid: string, locale: string | null) =>
      ['strapi', uid === ARTICLE ? 'article' : 'categories', locale].filter(Boolean).join('_'),
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
    contentType: (uid: string) => ({ info: { singularName: uid === ARTICLE ? 'article' : 'category' } }),
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
