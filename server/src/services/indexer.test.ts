import { describe, expect, it, vi } from 'vitest';
import indexer, { ReindexInProgressError } from './indexer';

const ARTICLE = 'api::article.article';
const CATEGORY = 'api::category.category';

const notFound = () => Object.assign(new Error('not found'), { meta: { statusCode: 404 } });

type Row = { id: number; documentId: string; title?: string; hidden?: boolean; broken?: boolean };

interface SetupOptions {
  document?: Record<string, unknown> | null;
  rows?: Row[];
  locales?: (string | null)[];
  bulkSize?: number;
}

const setup = ({ document = null, rows = [], locales = ['it'], bulkSize = 500 }: SetupOptions = {}) => {
  const client = {
    index: vi.fn(async (_params: Record<string, unknown>) => ({ body: { result: 'created' } })),
    delete: vi.fn(async (_params: Record<string, unknown>): Promise<unknown> => ({ body: { result: 'deleted' } })),
    bulk: vi.fn(async ({ body }: { body: Record<string, { _id: string }>[] }) => ({
      body: {
        errors: false,
        items: body.filter((line) => 'index' in line).map((line) => ({ index: { _id: line.index._id, status: 201 } })),
      },
    })),
    count: vi.fn(async () => ({ body: { count: 42 } })),
    indices: {
      refresh: vi.fn(async () => ({ body: {} })),
      delete: vi.fn(async () => ({ body: { acknowledged: true } })),
    },
  };
  const aliasOf = (_uid: string, locale: string | null) => `strapi_article${locale ? `_${locale}` : ''}`;
  const indexManager = {
    getAliasName: vi.fn(aliasOf),
    ensureIndex: vi.fn(async () => ({ created: false, index: 'strapi_article_it_v1' })),
    getLocales: vi.fn(async () => locales),
    createVersionedIndex: vi.fn(async (uid: string, locale: string | null) => `${aliasOf(uid, locale)}_v2`),
    swapAlias: vi.fn(async (alias: string, index: string) => ({ alias, index, previous: [`${alias}_v1`] })),
    dropOldVersions: vi.fn(async (alias: string) => [`${alias}_v1`]),
  };
  const documentBuilder = {
    loadAndBuild: vi.fn(async (..._args: unknown[]) => document),
    build: vi.fn(async (_uid: string, entry: Row, locale: string | null) => {
      if (entry.broken) throw new Error('transform exploded');
      if (entry.hidden) return null;
      return { documentId: entry.documentId, title: entry.title, locale };
    }),
  };
  const findMany = vi.fn(async ({ filters, limit }: { filters: { id: { $gt: number } }; limit: number }) =>
    rows.filter((row) => row.id > filters.id.$gt).slice(0, limit),
  );
  const config: Record<string, unknown> = {
    bulkSize,
    contentTypes: { [ARTICLE]: { populate: { category: true } }, [CATEGORY]: {} },
  };
  const services: Record<string, unknown> = {
    client: { getClient: () => client },
    'index-manager': indexManager,
    'document-builder': documentBuilder,
  };
  const strapi = {
    plugin: () => ({ service: (name: string) => services[name], config: (key: string) => config[key] }),
    documents: () => ({ findMany }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const service = indexer({ strapi } as never);
  return { service, client, indexManager, documentBuilder, findMany, strapi };
};

const rows = (count: number, from = 1): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: from + i, documentId: `doc${from + i}`, title: `T${from + i}` }));

/** Ids sent to `_bulk`, in order. */
const bulkIds = (client: ReturnType<typeof setup>['client']) =>
  client.bulk.mock.calls.flatMap(([{ body }]) => body.filter((line) => 'index' in line).map((line) => line.index._id));

describe('indexer — real-time', () => {
  it('indexes the published document with _id = documentId through the alias', async () => {
    const { service, client, indexManager } = setup({ document: { documentId: 'doc1', title: 'Ciao' } });

    await expect(service.indexOne(ARTICLE, 'doc1', 'it')).resolves.toBe('indexed');
    expect(client.index).toHaveBeenCalledWith({
      index: 'strapi_article_it',
      id: 'doc1',
      body: { documentId: 'doc1', title: 'Ciao' },
      require_alias: true,
    });

    // The alias is ensured once, then cached.
    await service.indexOne(ARTICLE, 'doc1', 'it');
    expect(indexManager.ensureIndex).toHaveBeenCalledTimes(1);
  });

  it('removes the document when it is not published or filtered out', async () => {
    const { service, client } = setup();

    await expect(service.indexOne(ARTICLE, 'doc1', 'en')).resolves.toBe('removed');
    expect(client.index).not.toHaveBeenCalled();
    expect(client.delete).toHaveBeenCalledWith({ index: 'strapi_article_en', id: 'doc1' });
  });

  it('removeOne ignores documents that are not indexed', async () => {
    const { service, client } = setup();
    client.delete.mockRejectedValueOnce(notFound());
    await expect(service.removeOne(ARTICLE, 'doc1', null)).resolves.toBeUndefined();

    client.delete.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(service.removeOne(ARTICLE, 'doc1', null)).rejects.toThrow('ECONNREFUSED');
  });

  it('checks the alias again after a failed write', async () => {
    const { service, client, indexManager } = setup({ document: { documentId: 'doc1' } });
    client.index.mockRejectedValueOnce(new Error('no such alias'));

    await expect(service.indexOne(ARTICLE, 'doc1', 'it')).rejects.toThrow('no such alias');
    await service.indexOne(ARTICLE, 'doc1', 'it');
    expect(indexManager.ensureIndex).toHaveBeenCalledTimes(2);
  });
});

describe('indexer — reindex', () => {
  it('pages through the published entries with keyset pagination, then swaps and drops', async () => {
    const { service, client, indexManager, findMany } = setup({ rows: rows(5), bulkSize: 2 });

    const report = await service.reindex(ARTICLE);

    expect(findMany.mock.calls.map(([params]) => params)).toEqual([
      expect.objectContaining({
        status: 'published',
        locale: 'it',
        populate: { category: true },
        limit: 2,
        sort: 'id:asc',
        filters: { id: { $gt: 0 } },
      }),
      expect.objectContaining({ filters: { id: { $gt: 2 } } }),
      expect.objectContaining({ filters: { id: { $gt: 4 } } }),
    ]);
    expect(bulkIds(client)).toEqual(['doc1', 'doc2', 'doc3', 'doc4', 'doc5']);
    expect(client.bulk.mock.calls[0][0].body[0]).toEqual({ index: { _index: 'strapi_article_it_v2', _id: 'doc1' } });
    expect(client.indices.refresh).toHaveBeenCalledWith({ index: 'strapi_article_it_v2' });
    expect(indexManager.swapAlias).toHaveBeenCalledWith('strapi_article_it', 'strapi_article_it_v2');
    expect(indexManager.dropOldVersions).toHaveBeenCalledWith('strapi_article_it');
    expect(report).toMatchObject({
      uid: ARTICLE,
      ok: true,
      locales: [
        {
          locale: 'it',
          alias: 'strapi_article_it',
          index: 'strapi_article_it_v2',
          read: 5,
          indexed: 5,
          filtered: 0,
          failed: 0,
          count: 42,
          dropped: ['strapi_article_it_v1'],
        },
      ],
    });
  });

  it('reindexes every locale, and omits the locale without i18n', async () => {
    const localized = setup({ rows: rows(1), locales: ['it', 'en'] });
    const report = await localized.service.reindex(ARTICLE);
    expect(report.locales.map((l) => l.alias)).toEqual(['strapi_article_it', 'strapi_article_en']);
    expect(localized.findMany.mock.calls.map(([params]) => (params as { locale?: string }).locale)).toEqual([
      'it',
      'en',
    ]);

    const plain = setup({ rows: rows(1), locales: [null] });
    await plain.service.reindex(CATEGORY);
    expect(plain.findMany.mock.calls[0][0]).not.toHaveProperty('locale');
    expect(plain.findMany.mock.calls[0][0]).not.toHaveProperty('populate');
  });

  it('counts filtered entries, build errors and bulk item errors without stopping', async () => {
    const data = rows(4);
    data[1].hidden = true;
    data[2].broken = true;
    const { service, client, indexManager, strapi } = setup({ rows: data });
    client.bulk.mockResolvedValueOnce({
      body: {
        errors: true,
        items: [
          { index: { _id: 'doc1', status: 201 } },
          {
            index: {
              _id: 'doc4',
              status: 400,
              error: { type: 'mapper_parsing_exception', reason: 'bad date' },
            } as never,
          },
        ],
      },
    });

    const [locale] = (await service.reindex(ARTICLE)).locales;

    expect(locale).toMatchObject({ read: 4, indexed: 1, filtered: 1, failed: 2 });
    expect(locale.errors).toEqual([
      { id: 'doc3', status: 0, reason: 'build failed: transform exploded' },
      { id: 'doc4', status: 400, reason: 'mapper_parsing_exception: bad date' },
    ]);
    expect(strapi.log.warn).toHaveBeenCalledTimes(2);
    // Item failures do not prevent the swap.
    expect(indexManager.swapAlias).toHaveBeenCalled();
  });

  it('keeps the previous index and deletes the new one when the bulk request fails', async () => {
    const { service, client, indexManager } = setup({ rows: rows(3) });
    client.bulk.mockRejectedValueOnce(new Error('Connection Error'));

    const report = await service.reindex(ARTICLE);

    expect(report.ok).toBe(false);
    expect(report.locales[0].error).toBe('Connection Error');
    expect(indexManager.swapAlias).not.toHaveBeenCalled();
    expect(client.indices.delete).toHaveBeenCalledWith({ index: 'strapi_article_it_v2' });
    expect(service.isReindexing(ARTICLE)).toBe(false);
  });

  it('refuses a second reindex of the same content type while one is running', async () => {
    const { service, findMany } = setup({ rows: rows(1) });
    let release!: () => void;
    findMany.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(rows(1) as never))));

    const first = service.reindex(ARTICLE);
    await vi.waitFor(() => expect(findMany).toHaveBeenCalled());
    expect(service.isReindexing(ARTICLE)).toBe(true);
    expect(service.getRunning()).toEqual([ARTICLE]);
    await expect(service.reindex(ARTICLE)).rejects.toBeInstanceOf(ReindexInProgressError);

    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(service.reindex(ARTICLE)).resolves.toMatchObject({ ok: true });
  });

  it('writes real-time changes to the new index too, and lets them win over the bulk', async () => {
    const { service, client, documentBuilder, findMany } = setup({ rows: rows(3) });
    let release!: () => void;
    findMany.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(rows(3) as never))));

    const running = service.reindex(ARTICLE);
    await vi.waitFor(() => expect(findMany).toHaveBeenCalled());

    // doc2 republished, doc3 unpublished while the first page is being read.
    documentBuilder.loadAndBuild.mockImplementation(async (_uid, documentId) =>
      documentId === 'doc2' ? { documentId: 'doc2', title: 'Updated' } : null,
    );
    await service.indexOne(ARTICLE, 'doc2', 'it');
    await service.indexOne(ARTICLE, 'doc3', 'it');

    expect(client.index).toHaveBeenCalledWith({
      index: 'strapi_article_it_v2',
      id: 'doc2',
      body: { documentId: 'doc2', title: 'Updated' },
    });
    expect(client.delete).toHaveBeenCalledWith({ index: 'strapi_article_it', id: 'doc3' });
    expect(client.delete).toHaveBeenCalledWith({ index: 'strapi_article_it_v2', id: 'doc3' });

    client.index.mockClear();
    client.delete.mockClear();
    release();
    const [locale] = (await running).locales;

    // The stale page copies of doc2/doc3 are not bulk-written; both are reconciled from Strapi.
    expect(bulkIds(client)).toEqual(['doc1']);
    expect(locale).toMatchObject({ read: 3, indexed: 1, superseded: 2, reconciled: 2 });
    expect(client.index).toHaveBeenCalledWith({
      index: 'strapi_article_it_v2',
      id: 'doc2',
      body: { documentId: 'doc2', title: 'Updated' },
    });
    expect(client.delete).toHaveBeenCalledWith({ index: 'strapi_article_it_v2', id: 'doc3' });

    // After the swap the sync writes only through the alias.
    client.index.mockClear();
    await service.indexOne(ARTICLE, 'doc2', 'it');
    expect(client.index).toHaveBeenCalledTimes(1);
  });

  it('reindexAll runs the content types one after the other and never throws', async () => {
    const { service, indexManager } = setup({ rows: rows(1) });
    indexManager.getLocales.mockRejectedValueOnce(new Error('i18n down'));

    const reports = await service.reindexAll();

    expect(reports.map((r) => [r.uid, r.ok, r.error])).toEqual([
      [ARTICLE, false, 'i18n down'],
      [CATEGORY, true, undefined],
    ]);
  });

  it('exposes queued content types during reindexAll and keeps the last report', async () => {
    const { service } = setup({ rows: rows(2) });
    expect(service.getLastReport(ARTICLE)).toBeNull();

    const pending = service.reindexAll();
    // Synchronously after the call: first one running, the others queued.
    expect(service.getRunning()).toEqual([ARTICLE]);
    expect(service.getQueued()).toEqual([CATEGORY]);

    await pending;
    expect(service.getRunning()).toEqual([]);
    expect(service.getQueued()).toEqual([]);
    expect(service.getLastReport(ARTICLE)).toMatchObject({ uid: ARTICLE, ok: true });
    expect(service.getLastReport(CATEGORY)).toMatchObject({ uid: CATEGORY });
  });
});
