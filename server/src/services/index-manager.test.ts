import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexManager from './index-manager';

/** In-memory stand-in for the OpenSearch indices/alias APIs used by the index manager. */
const createFakeClient = () => {
  const indices = new Map<string, { aliases: Set<string>; body: unknown }>();
  const notFound = () => Object.assign(new Error('not found'), { meta: { statusCode: 404 } });
  const matches = (pattern: string, name: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name);

  const client = {
    indices: {
      exists: vi.fn(async ({ index }: { index: string }) => ({ body: indices.has(index) })),
      create: vi.fn(async ({ index, body }: { index: string; body: { aliases?: Record<string, unknown> } }) => {
        indices.set(index, { aliases: new Set(Object.keys(body.aliases ?? {})), body });
        return { body: { acknowledged: true } };
      }),
      getAlias: vi.fn(async ({ name, index }: { name?: string; index?: string }) => {
        const result: Record<string, { aliases: Record<string, object> }> = {};
        for (const [indexName, info] of indices) {
          if (index && !matches(index, indexName)) continue;
          if (name && !info.aliases.has(name)) continue;
          result[indexName] = { aliases: Object.fromEntries([...info.aliases].map((a) => [a, {}])) };
        }
        if (name && Object.keys(result).length === 0) throw notFound();
        return { body: result };
      }),
      updateAliases: vi.fn(
        async ({
          body,
        }: {
          body: { actions: { add?: { index: string; alias: string }; remove?: { index: string; alias: string } }[] };
        }) => {
          for (const action of body.actions) {
            if (action.remove) indices.get(action.remove.index)?.aliases.delete(action.remove.alias);
            if (action.add) indices.get(action.add.index)?.aliases.add(action.add.alias);
          }
          return { body: { acknowledged: true } };
        },
      ),
      delete: vi.fn(async ({ index }: { index: string }) => {
        for (const name of index.split(',')) indices.delete(name);
        return { body: { acknowledged: true } };
      }),
    },
    count: vi.fn(async () => ({ body: { count: 7 } })),
  };
  return { client, indices };
};

const createFakeStrapi = (client: unknown, contentTypes: Record<string, unknown>) => {
  const config = { indexPrefix: 'playground', contentTypes };
  const schemas: Record<string, unknown> = {
    'api::article.article': { info: { singularName: 'article' }, pluginOptions: { i18n: { localized: true } } },
    'api::category.category': { info: { singularName: 'category' } },
  };
  const plugins: Record<string, unknown> = {
    opensearch: {
      config: (key: keyof typeof config) => config[key],
      service: (name: string) => (name === 'client' ? { getClient: () => client } : undefined),
    },
    i18n: { service: () => ({ find: async () => [{ code: 'it' }, { code: 'en' }] }) },
  };
  return {
    plugin: (name: string) => plugins[name],
    contentType: (uid: string) => schemas[uid],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
};

const ARTICLE = 'api::article.article';
const CATEGORY = 'api::category.category';

describe('index manager', () => {
  let fake: ReturnType<typeof createFakeClient>;
  let strapi: ReturnType<typeof createFakeStrapi>;
  let manager: ReturnType<typeof indexManager>;

  const setup = (contentTypes: Record<string, unknown>) => {
    fake = createFakeClient();
    strapi = createFakeStrapi(fake.client, contentTypes);
    manager = indexManager({ strapi: strapi as never });
  };

  beforeEach(() => setup({ [ARTICLE]: { locales: 'all' }, [CATEGORY]: { indexName: 'cat' } }));

  it('resolves one target per locale, none for non-localized content types', async () => {
    expect(await manager.getTargets()).toEqual([
      { uid: ARTICLE, locale: 'it', alias: 'playground_article_it' },
      { uid: ARTICLE, locale: 'en', alias: 'playground_article_en' },
      { uid: CATEGORY, locale: null, alias: 'playground_cat' },
    ]);
  });

  it('filters locales by config and warns about unknown ones', async () => {
    setup({ [ARTICLE]: { locales: ['en', 'fr'] } });
    expect(await manager.getLocales(ARTICLE)).toEqual(['en']);
    expect(strapi.log.warn).toHaveBeenCalledOnce();
  });

  it('ensureIndices creates versioned indices behind aliases and is idempotent', async () => {
    await manager.ensureIndices();
    await manager.ensureIndices();

    const names = [...fake.indices.keys()];
    expect(names).toHaveLength(3);
    expect(names.every((name) => /_v\d+$/.test(name))).toBe(true);
    expect(await manager.getAliasIndices('playground_article_it')).toEqual([
      names.find((n) => n.startsWith('playground_article_it_v')),
    ]);

    const itBody = fake.indices.get(names[0])!.body as { settings: unknown };
    expect(itBody.settings).toEqual({ analysis: { analyzer: { default: { type: 'italian' } } } });
    expect(strapi.log.error).not.toHaveBeenCalled();
  });

  it('refuses to shadow a concrete index with the alias name', async () => {
    fake.indices.set('playground_cat', { aliases: new Set(), body: {} });
    await expect(manager.ensureIndex(CATEGORY, null)).rejects.toThrow(/not an alias/);
  });

  it('swaps the alias atomically and drops old versions only', async () => {
    const { index: first } = await manager.ensureIndex(CATEGORY, null);
    const second = await manager.createVersionedIndex(CATEGORY, null);
    expect(second).not.toBe(first);

    const swap = await manager.swapAlias('playground_cat', second);
    expect(swap.previous).toEqual([first]);
    expect(fake.client.indices.updateAliases).toHaveBeenCalledOnce();
    expect(await manager.getAliasIndices('playground_cat')).toEqual([second]);

    fake.indices.set('playground_cat_vi_v1', { aliases: new Set(), body: {} });
    expect(await manager.dropOldVersions('playground_cat')).toEqual([first]);
    expect(fake.indices.has('playground_cat_vi_v1')).toBe(true);
  });

  it('reports stats per alias', async () => {
    await manager.ensureIndex(CATEGORY, null);
    const stats = await manager.stats();
    expect(stats.find((s) => s.alias === 'playground_cat')).toMatchObject({ exists: true, count: 7 });
    expect(stats.find((s) => s.alias === 'playground_article_it')).toMatchObject({
      exists: false,
      indices: [],
      count: null,
    });
  });
});
