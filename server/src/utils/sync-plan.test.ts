import { describe, expect, it } from 'vitest';
import { buildSyncPlan, type SyncPlanInput } from './sync-plan';

const input = (overrides: Partial<SyncPlanInput>): SyncPlanInput => ({
  action: 'publish',
  params: { documentId: 'doc1' },
  result: undefined,
  draftAndPublish: true,
  localized: true,
  ...overrides,
});

describe('buildSyncPlan', () => {
  it('publish indexes the locale of the params', () => {
    expect(buildSyncPlan(input({ params: { documentId: 'doc1', locale: 'it' } }))).toEqual([
      { action: 'index', documentId: 'doc1', locales: ['it'] },
    ]);
  });

  it("maps locale '*' to all locales, an array to the list and no locale to the default", () => {
    const locales = (locale: unknown) => buildSyncPlan(input({ params: { documentId: 'doc1', locale } }))[0]?.locales;
    expect(locales('*')).toBe('all');
    expect(locales(['it', 'en'])).toEqual(['it', 'en']);
    expect(locales(undefined)).toBe('default');
  });

  it('unpublish and delete remove', () => {
    for (const action of ['unpublish', 'delete']) {
      expect(buildSyncPlan(input({ action, params: { documentId: 'doc1', locale: '*' } }))).toEqual([
        { action: 'remove', documentId: 'doc1', locales: 'all' },
      ]);
    }
  });

  it('ignores draft saves, discardDraft and reads with D&P', () => {
    for (const action of ['create', 'update', 'discardDraft', 'clone', 'findOne', 'findMany', 'count']) {
      expect(buildSyncPlan(input({ action, result: { documentId: 'doc1', locale: 'it' } }))).toEqual([]);
    }
  });

  it('create/update with status published index the locale of the result', () => {
    const result = { documentId: 'new1', locale: 'en' };
    expect(buildSyncPlan(input({ action: 'create', params: { status: 'published' }, result }))).toEqual([
      { action: 'index', documentId: 'new1', locales: ['en'] },
    ]);
  });

  it('without D&P create/update/clone always index and delete removes', () => {
    const base = { draftAndPublish: false, localized: false };
    expect(buildSyncPlan(input({ ...base, action: 'create', params: {}, result: { documentId: 'c1' } }))).toEqual([
      { action: 'index', documentId: 'c1', locales: [null] },
    ]);
    expect(
      buildSyncPlan(input({ ...base, action: 'update', params: { documentId: 'c1' }, result: { documentId: 'c1' } })),
    ).toEqual([{ action: 'index', documentId: 'c1', locales: [null] }]);
    expect(
      buildSyncPlan(
        input({ ...base, action: 'clone', params: { documentId: 'c1' }, result: { documentId: 'c2', entries: [{}] } }),
      ),
    ).toEqual([{ action: 'index', documentId: 'c2', locales: [null] }]);
    expect(buildSyncPlan(input({ ...base, action: 'delete', params: { documentId: 'c1' } }))).toEqual([
      { action: 'remove', documentId: 'c1', locales: [null] },
    ]);
  });

  it('skips calls without a documentId', () => {
    expect(buildSyncPlan(input({ action: 'publish', params: {} }))).toEqual([]);
    expect(buildSyncPlan(input({ action: 'create', params: { status: 'published' }, result: null }))).toEqual([]);
  });
});
