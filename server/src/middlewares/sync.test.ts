import { describe, expect, it, vi } from 'vitest';
import { createSyncMiddleware, MAX_CONCURRENT_SYNC, waitForPendingSync } from './sync';

const ARTICLE = 'api::article.article';

const setup = () => {
  let active = 0;
  let maxActive = 0;
  const releases: (() => void)[] = [];
  const indexer = {
    indexOne: vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return 'indexed';
    }),
    removeOne: vi.fn(),
  };
  const services: Record<string, unknown> = {
    indexer,
    'index-manager': { getLocales: async () => ['it', 'en'] },
  };
  const strapi = {
    plugin: () => ({
      service: (name: string) => services[name],
      config: () => ({ [ARTICLE]: { search: { fields: ['title'] } } }),
    }),
    db: { inTransaction: () => false },
    localization: { isLocalizedContentType: () => true, getDefaultLocale: async () => 'it' },
    log: { error: vi.fn(), debug: vi.fn() },
  };
  const middleware = createSyncMiddleware(strapi as never);
  const publish = (documentId: string) =>
    middleware(
      {
        uid: ARTICLE,
        action: 'publish',
        params: { documentId, locale: 'it' },
        contentType: { options: { draftAndPublish: true } },
      } as never,
      async () => ({ documentId }) as never,
    );
  return { indexer, publish, releases, maxActive: () => maxActive };
};

describe('sync middleware scheduling', () => {
  it('limits the concurrent sync tasks and lets destroy wait for all of them', async () => {
    const { indexer, publish, releases, maxActive } = setup();

    for (let i = 0; i < 10; i++) await publish(`doc${i}`);
    await vi.waitFor(() => expect(indexer.indexOne).toHaveBeenCalledTimes(MAX_CONCURRENT_SYNC));

    // Nothing finishes yet: the wait times out and reports what is left.
    await expect(waitForPendingSync(20)).resolves.toBe(10);

    const waiting = waitForPendingSync(5_000);
    // Release tasks as they start, until all ten have run.
    await vi.waitFor(() => {
      releases.splice(0).forEach((release) => release());
      expect(indexer.indexOne).toHaveBeenCalledTimes(10);
    });
    releases.splice(0).forEach((release) => release());
    await expect(waiting).resolves.toBe(0);
    expect(maxActive()).toBe(MAX_CONCURRENT_SYNC);
  });
});
