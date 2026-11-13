import { describe, expect, it, vi } from 'vitest';
import admin from './admin';
import routes, { ACTIONS } from '../routes/admin';

const ARTICLE = 'api::article.article';
const CATEGORY = 'api::category.category';

const setup = ({ running = [] as string[], queued = [] as string[] } = {}) => {
  const indexer = {
    getRunning: vi.fn(() => running),
    getQueued: vi.fn(() => queued),
    reindex: vi.fn(async (uid: string) => ({ uid, ok: true })),
    reindexAll: vi.fn(async () => []),
  };
  const statusService = { getStatus: vi.fn(async () => ({ cluster: { ok: true } })) };
  const services: Record<string, unknown> = { indexer, status: statusService };
  const strapi = {
    plugin: () => ({
      service: (name: string) => services[name],
      config: () => ({ [ARTICLE]: {}, [CATEGORY]: {} }),
    }),
    log: { error: vi.fn() },
  };
  const controller = admin({ strapi } as never);
  const ctx = (params: Record<string, string> = {}) => ({
    params,
    status: 200,
    body: undefined as unknown,
    notFound: vi.fn(),
    conflict: vi.fn(),
  });
  return { controller, indexer, statusService, strapi, ctx };
};

describe('admin controller', () => {
  it('returns the status from the status service', async () => {
    const { controller, ctx } = setup();
    const c = ctx();
    await controller.status(c);
    expect(c.body).toEqual({ cluster: { ok: true } });
  });

  it('starts a reindex of a configured content type in background with 202', async () => {
    const { controller, indexer, ctx } = setup();
    const c = ctx({ uid: ARTICLE });
    await controller.reindex(c);
    expect(indexer.reindex).toHaveBeenCalledWith(ARTICLE);
    expect(c.status).toBe(202);
    expect(c.body).toEqual({ started: [ARTICLE] });
  });

  it('rejects a content type that is not in the config with 404', async () => {
    const { controller, indexer, ctx } = setup();
    const c = ctx({ uid: 'api::secret.secret' });
    await controller.reindex(c);
    expect(c.notFound).toHaveBeenCalled();
    expect(indexer.reindex).not.toHaveBeenCalled();
  });

  it('answers 409 when the content type is running or queued', async () => {
    for (const state of [{ running: [ARTICLE] }, { queued: [ARTICLE] }]) {
      const { controller, indexer, ctx } = setup(state);
      const c = ctx({ uid: ARTICLE });
      await controller.reindex(c);
      expect(c.conflict).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'REINDEX_IN_PROGRESS' }),
      );
      expect(indexer.reindex).not.toHaveBeenCalled();
    }
  });

  it('reindexes another content type while one is running', async () => {
    const { controller, indexer, ctx } = setup({ running: [CATEGORY] });
    await controller.reindex(ctx({ uid: ARTICLE }));
    expect(indexer.reindex).toHaveBeenCalledWith(ARTICLE);
  });

  it('starts reindexAll with 202, or 409 when anything is busy', async () => {
    const idle = setup();
    const c = idle.ctx();
    await idle.controller.reindexAll(c);
    expect(idle.indexer.reindexAll).toHaveBeenCalled();
    expect(c.status).toBe(202);
    expect(c.body).toEqual({ started: [ARTICLE, CATEGORY] });

    const busy = setup({ running: [CATEGORY] });
    const b = busy.ctx();
    await busy.controller.reindexAll(b);
    expect(b.conflict).toHaveBeenCalled();
    expect(busy.indexer.reindexAll).not.toHaveBeenCalled();
  });

  it('logs a background failure instead of leaving an unhandled rejection', async () => {
    const { controller, indexer, strapi, ctx } = setup();
    indexer.reindex.mockRejectedValueOnce(new Error('boom'));
    await controller.reindex(ctx({ uid: ARTICLE }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(strapi.log.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('admin routes', () => {
  it('protects every route with admin auth and the matching permission', () => {
    const { type, routes: list } = routes();
    expect(type).toBe('admin');
    const byPath = Object.fromEntries(list.map((route) => [`${route.method} ${route.path}`, route]));
    expect(Object.keys(byPath)).toEqual(['GET /status', 'POST /reindex', 'POST /reindex/:uid']);
    const actionOf = (key: string) => byPath[key].config.policies;
    expect(actionOf('GET /status')).toEqual([
      'admin::isAuthenticatedAdmin',
      { name: 'admin::hasPermissions', config: { actions: [ACTIONS.read] } },
    ]);
    for (const key of ['POST /reindex', 'POST /reindex/:uid']) {
      expect(actionOf(key)[1]).toEqual({ name: 'admin::hasPermissions', config: { actions: [ACTIONS.reindex] } });
    }
    expect(ACTIONS).toEqual({ read: 'plugin::opensearch.read', reindex: 'plugin::opensearch.reindex' });
  });
});
