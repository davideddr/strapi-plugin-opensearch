import { describe, expect, it, vi } from 'vitest';
import search from './search';
import routes from '../routes/content-api';
import { SearchParamsError, UnknownIndexError } from '../utils/search-query';

const setup = (impl: () => Promise<unknown>) => {
  const searchService = { search: vi.fn(impl) };
  const strapi = {
    plugin: () => ({ service: () => searchService }),
    log: { error: vi.fn() },
  };
  const ctx = {
    params: { index: 'article' },
    query: { q: 'x' },
    body: undefined as unknown,
    badRequest: vi.fn(),
    notFound: vi.fn(),
    serviceUnavailable: vi.fn(),
  };
  return { controller: search({ strapi } as never), searchService, strapi, ctx };
};

describe('search controller', () => {
  it('returns the service result', async () => {
    const result = { data: [], meta: {} };
    const { controller, searchService, ctx } = setup(async () => result);
    await controller.search(ctx);
    expect(searchService.search).toHaveBeenCalledWith('article', { q: 'x' });
    expect(ctx.body).toBe(result);
  });

  it('answers 400 with details on invalid parameters', async () => {
    const { controller, ctx } = setup(async () => {
      throw new SearchParamsError('Filter not allowed: x', { allowed: ['tags'] });
    });
    await controller.search(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith('Filter not allowed: x', { allowed: ['tags'] });
  });

  it('answers 404 on an unknown index', async () => {
    const { controller, ctx } = setup(async () => {
      throw new UnknownIndexError('article');
    });
    await controller.search(ctx);
    expect(ctx.notFound).toHaveBeenCalled();
  });

  it('hides cluster errors behind a generic 503 and logs them', async () => {
    const { controller, ctx, strapi } = setup(async () => {
      throw Object.assign(new Error('index_not_found_exception: strapi_article_it_v123'), { statusCode: 404 });
    });
    await controller.search(ctx);
    expect(ctx.serviceUnavailable).toHaveBeenCalledWith('Search is temporarily unavailable');
    expect(strapi.log.error).toHaveBeenCalledWith(expect.stringContaining('index_not_found_exception'));
    expect(ctx.body).toBeUndefined();
  });
});

describe('content-api routes', () => {
  it('exposes GET /search/:index with the default auth (Users & Permissions)', () => {
    const { type, routes: list } = routes();
    expect(type).toBe('content-api');
    expect(list).toEqual([
      { method: 'GET', path: '/search/:index', handler: 'search.search', config: { policies: [] } },
    ]);
  });
});
