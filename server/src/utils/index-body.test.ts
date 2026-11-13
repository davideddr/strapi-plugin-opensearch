import { describe, expect, it } from 'vitest';
import { analyzerForLocale, BASE_MAPPINGS, buildIndexBody, deepMerge } from './index-body';

describe('analyzerForLocale', () => {
  it('maps locales to built-in language analyzers', () => {
    expect(analyzerForLocale('it')).toBe('italian');
    expect(analyzerForLocale('en')).toBe('english');
    expect(analyzerForLocale('en-GB')).toBe('english');
    expect(analyzerForLocale('de_DE')).toBe('german');
    expect(analyzerForLocale('pt-BR')).toBe('brazilian');
    expect(analyzerForLocale('pt-PT')).toBe('portuguese');
  });

  it('falls back to standard', () => {
    expect(analyzerForLocale(null)).toBe('standard');
    expect(analyzerForLocale('ja')).toBe('standard');
  });
});

describe('deepMerge', () => {
  it('merges nested objects and lets the override win', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1, 2] }, { a: { c: 3 }, d: [3] })).toEqual({
      a: { b: 1, c: 3 },
      d: [3],
    });
  });

  it('does not mutate its inputs', () => {
    const base = { a: { b: 1 } };
    deepMerge(base, { a: { b: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });
});

describe('buildIndexBody', () => {
  it('sets the language analyzer as default and the base mappings', () => {
    expect(buildIndexBody({ locale: 'it' })).toEqual({
      settings: { analysis: { analyzer: { default: { type: 'italian' } } } },
      mappings: BASE_MAPPINGS,
    });
  });

  it('adds no analyzer setting for standard', () => {
    expect(buildIndexBody({ locale: null }).settings).toEqual({});
  });

  it('lets the content type config override the defaults', () => {
    const body = buildIndexBody({
      locale: 'en',
      settings: {
        number_of_replicas: 0,
        analysis: { analyzer: { default: { type: 'custom', tokenizer: 'standard', filter: ['lowercase'] } } },
      },
      mappings: { properties: { title: { type: 'text' }, documentId: { type: 'keyword', store: true } } },
    });
    expect(body.settings).toEqual({
      number_of_replicas: 0,
      analysis: { analyzer: { default: { type: 'custom', tokenizer: 'standard', filter: ['lowercase'] } } },
    });
    expect(body.mappings).toEqual({
      properties: {
        documentId: { type: 'keyword', store: true },
        locale: { type: 'keyword' },
        publishedAt: { type: 'date' },
        updatedAt: { type: 'date' },
        title: { type: 'text' },
      },
    });
  });
});
