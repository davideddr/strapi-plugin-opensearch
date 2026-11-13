import { describe, expect, it } from 'vitest';
import { buildAliasName, buildVersionedIndexName, isVersionOf, sanitizeNamePart, versionPattern } from './naming';

describe('sanitizeNamePart', () => {
  it('lowercases and replaces invalid characters', () => {
    expect(sanitizeNamePart('pt-BR')).toBe('pt-br');
    expect(sanitizeNamePart(' My Index ')).toBe('my_index');
    expect(sanitizeNamePart('a/b*c?d,e#f:g')).toBe('a_b_c_d_e_f_g');
    expect(sanitizeNamePart('zh-Hans')).toBe('zh-hans');
  });
});

describe('buildAliasName', () => {
  it('joins prefix, index name and locale', () => {
    expect(buildAliasName('playground', 'article', 'it')).toBe('playground_article_it');
    expect(buildAliasName('playground', 'article', 'en-GB')).toBe('playground_article_en-gb');
  });

  it('omits the locale when the content type is not localized', () => {
    expect(buildAliasName('playground', 'category', null)).toBe('playground_category');
  });
});

describe('versioned names', () => {
  it('appends _v{timestamp}', () => {
    expect(buildVersionedIndexName('playground_article_it', 1762790400000)).toBe(
      'playground_article_it_v1762790400000',
    );
    expect(versionPattern('playground_article_it')).toBe('playground_article_it_v*');
  });

  it('recognises only exact versions of the alias', () => {
    expect(isVersionOf('p_article', 'p_article_v123')).toBe(true);
    expect(isVersionOf('p_article', 'p_article_vi_v123')).toBe(false);
    expect(isVersionOf('p_article', 'p_article_v123_old')).toBe(false);
    expect(isVersionOf('p_article', 'p_article')).toBe(false);
    expect(isVersionOf('p.article', 'pxarticle_v1')).toBe(false);
  });
});
