import { describe, expect, it, vi } from 'vitest';
import status from './status';

const ARTICLE = 'api::article.article';
const CATEGORY = 'api::category.category';

const setup = ({
  pingError = null as Error | null,
  aliasIndices = { strapi_article_it: ['strapi_article_it_v1'] } as Record<string, string[]>,
} = {}) => {
  const client = { count: vi.fn(async ({ index }: { index: string }) => ({ body: { count: index.length } })) };
  const services: Record<string, unknown> = {
    client: {
      ping: vi.fn(async () => {
        if (pingError) throw pingError;
        return { clusterName: 'dev', version: '3.9.0', distribution: 'opensearch' };
      }),
      getClient: () => client,
    },
    'index-manager': {
      getTargets: vi.fn(async (uid: string) =>
        uid === ARTICLE
          ? [
              { uid, locale: 'it', alias: 'strapi_article_it' },
              { uid, locale: 'en', alias: 'strapi_article_en' },
            ]
          : [{ uid, locale: null, alias: 'strapi_category' }],
      ),
      getAliasIndices: vi.fn(async (alias: string) => aliasIndices[alias] ?? []),
    },
    indexer: {
      getRunning: () => [CATEGORY],
      getQueued: () => [],
      getLastReport: (uid: string) => (uid === ARTICLE ? { uid, ok: true } : null),
    },
  };
  const count = vi.fn(async (params: { status: string; locale?: string }) => (params.locale === 'it' ? 7 : 3));
  const strapi = {
    plugin: () => ({ service: (name: string) => services[name], config: () => ({ [ARTICLE]: {}, [CATEGORY]: {} }) }),
    contentType: (uid: string) => ({ info: { displayName: uid === ARTICLE ? 'Article' : 'Category' } }),
    documents: () => ({ count }),
  };
  return { service: status({ strapi } as never), client, count, services };
};

describe('status service', () => {
  it('reports cluster, indices, counts and reindex state per content type and locale', async () => {
    const { service, count } = setup();
    const result = await service.getStatus();

    expect(result.cluster).toEqual({ ok: true, clusterName: 'dev', version: '3.9.0', distribution: 'opensearch' });
    expect(result.running).toEqual([CATEGORY]);
    expect(result.contentTypes.map((ct) => [ct.uid, ct.displayName, ct.reindexing])).toEqual([
      [ARTICLE, 'Article', false],
      [CATEGORY, 'Category', true],
    ]);
    expect(result.contentTypes[0].lastReindex).toEqual({ uid: ARTICLE, ok: true });
    expect(result.contentTypes[0].locales).toEqual([
      {
        locale: 'it',
        alias: 'strapi_article_it',
        indices: ['strapi_article_it_v1'],
        count: 'strapi_article_it'.length,
        published: 7,
      },
      { locale: 'en', alias: 'strapi_article_en', indices: [], count: null, published: 3 },
    ]);
    expect(count).toHaveBeenCalledWith({ status: 'published', locale: 'it' });
    // No locale key at all for content types without i18n.
    expect(count).toHaveBeenCalledWith({ status: 'published' });
  });

  it('still reports Strapi counts when the cluster is down', async () => {
    const { service, client } = setup({ pingError: new Error('ECONNREFUSED') });
    const result = await service.getStatus();
    expect(result.cluster).toEqual({ ok: false, error: 'ECONNREFUSED' });
    expect(result.contentTypes[0].locales[0]).toMatchObject({ indices: null, count: null, published: 7 });
    expect(client.count).not.toHaveBeenCalled();
  });

  it('reports per-locale errors without failing the whole status', async () => {
    const { service, client } = setup();
    client.count.mockRejectedValueOnce(new Error('index_closed'));
    const result = await service.getStatus();
    expect(result.contentTypes[0].locales[0]).toMatchObject({
      count: null,
      published: 7,
      error: 'opensearch: index_closed',
    });
    expect(result.contentTypes[0].locales[1].error).toBeUndefined();
  });
});
