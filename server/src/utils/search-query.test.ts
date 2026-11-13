import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_LENGTH,
  SearchParamsError,
  buildSearchBody,
  formatSearchResponse,
  parseSearchParams,
  resolveKeywordField,
  stripBoost,
} from './search-query';

const limits = {
  filterable: ['category.slug', 'tags'],
  sortable: ['publishedAt', 'title.keyword'],
  defaultPageSize: 10,
  maxPageSize: 100,
};

const parse = (query: unknown) => parseSearchParams(query, limits);
const rejects = (query: unknown, message: RegExp) => {
  expect(() => parse(query)).toThrow(SearchParamsError);
  expect(() => parse(query)).toThrow(message);
};

describe('parseSearchParams', () => {
  it('applies the defaults on an empty query', () => {
    expect(parse({})).toEqual({
      q: '',
      locale: undefined,
      filters: {},
      sort: [],
      page: 1,
      pageSize: 10,
      highlight: false,
    });
    expect(parse(undefined).pageSize).toBe(10);
  });

  it('reads every allowed parameter', () => {
    expect(
      parse({
        q: '  hello world ',
        locale: 'it',
        filters: { 'category.slug': 'news', tags: ['a', 'b', 'a'] },
        sort: 'publishedAt:desc,title.keyword',
        page: '3',
        pageSize: '5',
        highlight: 'true',
      }),
    ).toEqual({
      q: 'hello world',
      locale: 'it',
      filters: { 'category.slug': ['news'], tags: ['a', 'b'] },
      sort: [
        { field: 'publishedAt', order: 'desc' },
        { field: 'title.keyword', order: 'asc' },
      ],
      page: 3,
      pageSize: 5,
      highlight: true,
    });
  });

  it('rejects parameters outside the whitelist', () => {
    rejects({ q: 'x', query: { match_all: {} } }, /Parameter not allowed: query/);
    rejects({ populate: '*' }, /populate/);
  });

  it('flattens nested filters as qs parses them', () => {
    expect(parse({ filters: { category: { slug: 'news' } } }).filters).toEqual({ 'category.slug': ['news'] });
  });

  it('rejects filters on fields that are not filterable', () => {
    rejects({ filters: { title: 'x' } }, /Filter not allowed: title/);
    rejects({ filters: { category: { name: 'x' } } }, /category\.name/);
    // qs turns arrays over its arrayLimit into objects with numeric keys
    rejects({ filters: { tags: { 0: 'a', 101: 'b' } } }, /Filter not allowed/);
  });

  it('rejects malformed filter values', () => {
    rejects({ filters: 'tags' }, /"filters" must be an object/);
    rejects({ filters: { tags: null } }, /must have a value/);
    rejects({ filters: { tags: '' } }, /must not be empty/);
    rejects({ filters: { tags: [] } }, /string values/);
    rejects({ filters: { tags: [{ $ne: 'x' }] } }, /string values/);
  });

  it('accepts `_score` and sortable fields, with asc as default direction', () => {
    expect(parse({ sort: ['_score:desc', 'publishedAt'] }).sort).toEqual([
      { field: '_score', order: 'desc' },
      { field: 'publishedAt', order: 'asc' },
    ]);
  });

  it('rejects sort on non sortable fields, bad directions and repeats', () => {
    rejects({ sort: 'body:asc' }, /Sort not allowed on "body"/);
    rejects({ sort: 'publishedAt:up' }, /Invalid sort/);
    rejects({ sort: 'publishedAt:asc:x' }, /Invalid sort/);
    rejects({ sort: 'publishedAt,publishedAt:desc' }, /repeated/);
    rejects({ sort: { publishedAt: 'asc' } }, /"sort" must be/);
  });

  it('enforces page and pageSize limits', () => {
    rejects({ page: '0' }, /"page" must be a positive integer/);
    rejects({ page: '1.5' }, /"page"/);
    rejects({ pageSize: '-1' }, /"pageSize"/);
    rejects({ pageSize: '101' }, /at most 100/);
    rejects({ page: '101', pageSize: '100' }, /at most 10000/);
    rejects({ page: ['1', '2'] }, /single string/);
    expect(parse({ page: '100', pageSize: '100' }).page).toBe(100);
    expect(parse({ page: '', pageSize: '' })).toMatchObject({ page: 1, pageSize: 10 });
  });

  it('limits the length of q and requires a string', () => {
    rejects({ q: 'x'.repeat(MAX_QUERY_LENGTH + 1) }, /at most/);
    rejects({ q: ['a', 'b'] }, /single string/);
  });

  it('parses highlight, with the bare flag meaning true', () => {
    expect(parse({ highlight: null }).highlight).toBe(true);
    expect(parse({ highlight: 'false' }).highlight).toBe(false);
    rejects({ highlight: 'yes' }, /"highlight"/);
  });
});

describe('resolveKeywordField', () => {
  const caps = {
    tags: { text: {} },
    'tags.keyword': { keyword: {} },
    'category.slug': { keyword: {} },
    body: { text: {} },
  };

  it('uses the .keyword sub-field of a dynamic text field', () => {
    expect(resolveKeywordField('tags', caps)).toBe('tags.keyword');
  });

  it('keeps keyword, unknown and text-only fields as they are', () => {
    expect(resolveKeywordField('category.slug', caps)).toBe('category.slug');
    expect(resolveKeywordField('missing', caps)).toBe('missing');
    expect(resolveKeywordField('body', caps)).toBe('body');
  });
});

describe('buildSearchBody', () => {
  const fields = ['title^3', 'excerpt^2', 'body'];

  it('uses match_all without q and paginates', () => {
    const body = buildSearchBody({ params: parse({ page: '3', pageSize: '5' }), fields });
    expect(body).toEqual({
      query: { bool: { must: [{ match_all: {} }], filter: [] } },
      from: 10,
      size: 5,
      track_total_hits: true,
    });
  });

  it('uses multi_match on the configured fields and term/terms filters', () => {
    const body = buildSearchBody({
      params: parse({ q: 'ciao', filters: { 'category.slug': 'news', tags: ['a', 'b'] } }),
      fields,
      resolveField: (f) => (f === 'tags' ? 'tags.keyword' : f),
    });
    expect(body.query).toEqual({
      bool: {
        must: [{ multi_match: { query: 'ciao', fields, type: 'best_fields', lenient: true } }],
        filter: [{ term: { 'category.slug': 'news' } }, { terms: { 'tags.keyword': ['a', 'b'] } }],
      },
    });
  });

  it('sorts on resolved fields, keeps _score with a query', () => {
    const body = buildSearchBody({
      params: parse({ q: 'x', sort: 'title.keyword:desc,_score' }),
      fields,
    });
    expect(body.sort).toEqual([
      { 'title.keyword': { order: 'desc', unmapped_type: 'keyword' } },
      { _score: { order: 'asc' } },
    ]);
    expect(body.track_scores).toBe(true);
    expect(buildSearchBody({ params: parse({ sort: 'publishedAt' }), fields }).track_scores).toBeUndefined();
  });

  it('highlights the search fields without boosts and HTML-encodes them', () => {
    const body = buildSearchBody({ params: parse({ q: 'x', highlight: 'true' }), fields });
    expect(body.highlight).toEqual({ encoder: 'html', fields: { title: {}, excerpt: {}, body: {} } });
    expect(buildSearchBody({ params: parse({ q: 'x' }), fields }).highlight).toBeUndefined();
  });

  it('strips decimal boosts', () => {
    expect(stripBoost('title^1.5')).toBe('title');
    expect(stripBoost('title')).toBe('title');
  });
});

describe('formatSearchResponse', () => {
  const hits = {
    total: { value: 23 },
    hits: [
      { _source: { documentId: 'a', title: 'A' }, _score: 1.2, highlight: { title: ['<em>A</em>'] } },
      { _source: { documentId: 'b', title: 'B' }, _score: null },
    ],
  };

  it('returns sources with score and pagination', () => {
    expect(formatSearchResponse({ hits }, parse({ pageSize: '5', page: '2' }))).toEqual({
      data: [
        { documentId: 'a', title: 'A', _score: 1.2 },
        { documentId: 'b', title: 'B', _score: null },
      ],
      meta: { pagination: { page: 2, pageSize: 5, pageCount: 5, total: 23 } },
    });
  });

  it('adds _highlight only when asked', () => {
    const { data } = formatSearchResponse({ hits }, parse({ highlight: 'true' }));
    expect(data[0]._highlight).toEqual({ title: ['<em>A</em>'] });
    expect(data[1]._highlight).toEqual({});
  });

  it('handles a numeric total and no hits', () => {
    expect(formatSearchResponse({ hits: { total: 0, hits: [] } }, parse({})).meta.pagination).toEqual({
      page: 1,
      pageSize: 10,
      pageCount: 0,
      total: 0,
    });
  });
});
