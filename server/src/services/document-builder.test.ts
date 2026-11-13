import { sanitize } from '@strapi/utils';
import { describe, expect, it, vi } from 'vitest';
import type { ContentTypeConfig } from '../types';
import documentBuilder from './document-builder';

const ARTICLE = 'api::article.article';

/** Minimal schemas: enough for the real Strapi output sanitizer to traverse relations and components. */
const models: Record<string, Record<string, unknown>> = {
  [ARTICLE]: {
    uid: ARTICLE,
    modelType: 'contentType',
    kind: 'collectionType',
    info: { singularName: 'article' },
    options: { draftAndPublish: true },
    attributes: {
      title: { type: 'string' },
      body: { type: 'richtext' },
      internalNotes: { type: 'text', private: true },
      secret: { type: 'password' },
      category: { type: 'relation', relation: 'manyToOne', target: 'api::category.category' },
      seo: { type: 'component', component: 'shared.seo', repeatable: false },
      publishedAt: { type: 'datetime' },
      updatedAt: { type: 'datetime' },
    },
  },
  'api::category.category': {
    uid: 'api::category.category',
    modelType: 'contentType',
    kind: 'collectionType',
    info: { singularName: 'category' },
    options: {},
    attributes: {
      name: { type: 'string' },
      slug: { type: 'uid' },
      budget: { type: 'integer', private: true },
    },
  },
  'shared.seo': {
    uid: 'shared.seo',
    modelType: 'component',
    attributes: {
      metaTitle: { type: 'string' },
      trackingId: { type: 'string', private: true },
    },
  },
};

const entry = () => ({
  id: 12,
  documentId: 'abc123',
  title: 'Ciao mondo',
  body: 'Testo',
  internalNotes: 'non indicizzare',
  secret: 'hunter2',
  category: { id: 3, documentId: 'cat1', name: 'News', slug: 'news', budget: 1000 },
  seo: { id: 5, metaTitle: 'Ciao', trackingId: 'UA-1' },
  locale: 'it',
  publishedAt: '2026-11-10T10:00:00.000Z',
  updatedAt: new Date('2026-11-10T09:00:00.000Z'),
});

const setup = (ctConfig: Partial<ContentTypeConfig> = {}, found: unknown = entry()) => {
  const getModel = (uid: string) => models[uid];
  const findOne = vi.fn(async () => found);
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const config = { contentTypes: { [ARTICLE]: { search: { fields: ['title'] }, ...ctConfig } } };
  const strapi = {
    plugin: () => ({ config: (key: keyof typeof config) => config[key] }),
    getModel,
    contentAPI: { sanitize: sanitize.createAPISanitizers({ getModel: getModel as never }) },
    documents: vi.fn(() => ({ findOne })),
    // Read by @strapi/utils (`isPrivateAttribute` → `strapi.config.get('api.responses.privateAttributes')`).
    config: { get: (_key: string, fallback?: unknown) => fallback },
    log,
  };
  vi.stubGlobal('strapi', strapi);
  return { builder: documentBuilder({ strapi: strapi as never }), strapi, findOne, log };
};

describe('document-builder load', () => {
  it('reads the published version with locale and populate from the config', async () => {
    const { builder, strapi, findOne } = setup({ populate: { category: true, seo: true } });
    await builder.load(ARTICLE, 'abc123', 'it');
    expect(strapi.documents).toHaveBeenCalledWith(ARTICLE);
    expect(findOne).toHaveBeenCalledWith({
      documentId: 'abc123',
      status: 'published',
      locale: 'it',
      populate: { category: true, seo: true },
    });
  });

  it('omits locale when i18n is off and returns null when not published', async () => {
    const { builder, findOne } = setup({}, null);
    expect(await builder.load(ARTICLE, 'abc123', null)).toBeNull();
    expect(findOne).toHaveBeenCalledWith({ documentId: 'abc123', status: 'published' });
  });
});

describe('document-builder build', () => {
  it('default: sanitized entry with populated relations/components, no private fields or db id', async () => {
    const { builder } = setup();
    const doc = await builder.build(ARTICLE, entry(), 'it');
    expect(doc).toEqual({
      documentId: 'abc123',
      title: 'Ciao mondo',
      body: 'Testo',
      category: { id: 3, documentId: 'cat1', name: 'News', slug: 'news' },
      seo: { id: 5, metaTitle: 'Ciao' },
      locale: 'it',
      publishedAt: '2026-11-10T10:00:00.000Z',
      updatedAt: '2026-11-10T09:00:00.000Z',
    });
  });

  it('returns null when filter is false (sync or async) and passes the sanitized entry', async () => {
    const filter = vi.fn(async (e: Record<string, unknown>, _ctx: unknown) => e.title !== 'Ciao mondo');
    const { builder } = setup({ filter });
    expect(await builder.build(ARTICLE, entry(), 'it')).toBeNull();
    expect(filter.mock.calls[0][0]).not.toHaveProperty('internalNotes');
    expect(filter.mock.calls[0][1]).toEqual({ uid: ARTICLE, locale: 'it' });

    const { builder: syncBuilder } = setup({ filter: () => false });
    expect(await syncBuilder.build(ARTICLE, entry(), 'it')).toBeNull();
  });

  it('uses a custom async transform and always adds the base fields', async () => {
    const transform = vi.fn(async (e: Record<string, unknown>, { locale }: { locale: string | null }) => ({
      title: e.title,
      category: (e.category as { slug: string }).slug,
      lang: locale,
      documentId: 'overridden',
    }));
    const { builder } = setup({ transform });
    expect(await builder.build(ARTICLE, entry(), 'it')).toEqual({
      title: 'Ciao mondo',
      category: 'news',
      lang: 'it',
      documentId: 'abc123',
      locale: 'it',
      publishedAt: '2026-11-10T10:00:00.000Z',
      updatedAt: '2026-11-10T09:00:00.000Z',
    });
    expect(transform.mock.calls[0][0]).not.toHaveProperty('secret');
  });

  it('sets locale to null when i18n is off', async () => {
    const { builder } = setup();
    expect((await builder.build(ARTICLE, entry(), null))?.locale).toBeNull();
  });

  it('logs uid and documentId when transform throws, then rethrows', async () => {
    const { builder, log } = setup({
      transform: () => {
        throw new Error('boom');
      },
    });
    await expect(builder.build(ARTICLE, entry(), 'it')).rejects.toThrow('boom');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(`${ARTICLE} abc123: boom`));
  });

  it('rejects a transform that does not return an object', async () => {
    const { builder, log } = setup({ transform: (() => 'nope') as never });
    await expect(builder.build(ARTICLE, entry(), 'it')).rejects.toThrow('plain object');
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('loadAndBuild returns null for an unpublished document', async () => {
    const { builder } = setup({}, null);
    expect(await builder.loadAndBuild(ARTICLE, 'abc123', 'it')).toBeNull();
  });
});
