/**
 * Search endpoint: validation of the query string, OpenSearch request body and response shape.
 * Pure functions, no Strapi or client dependency.
 */

type PlainObject = Record<string, unknown>;

/** 400: a query parameter is not allowed or has an invalid value. */
export class SearchParamsError extends Error {
  details: PlainObject;
  constructor(message: string, details: PlainObject = {}) {
    super(message);
    this.name = 'SearchParamsError';
    this.details = details;
  }
}

/** 404: `:index` is not the `indexName` of a configured content type. */
export class UnknownIndexError extends Error {
  constructor(index: string) {
    super(`Unknown search index "${index}"`);
    this.name = 'UnknownIndexError';
  }
}

export const ALLOWED_PARAMS = ['q', 'locale', 'filters', 'sort', 'page', 'pageSize', 'highlight'] as const;
export const MAX_QUERY_LENGTH = 500;
/** OpenSearch default `index.max_result_window`: `from + size` beyond it is rejected by the cluster. */
export const MAX_RESULT_WINDOW = 10_000;

export type SortOrder = 'asc' | 'desc';

export interface SearchParams {
  q: string;
  locale?: string;
  /** Configured field name → accepted values (one value = `term`, more = `terms`). */
  filters: Record<string, string[]>;
  sort: { field: string; order: SortOrder }[];
  page: number;
  pageSize: number;
  highlight: boolean;
}

export interface SearchLimits {
  filterable: string[];
  sortable: string[];
  defaultPageSize: number;
  maxPageSize: number;
}

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const singleString = (name: string, value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new SearchParamsError(`"${name}" must be a single string value`);
  return value;
};

const positiveInt = (name: string, value: unknown, fallback: number): number => {
  const raw = singleString(name, value);
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new SearchParamsError(`"${name}" must be a positive integer`);
  return Number(raw);
};

/**
 * `filters` as parsed by qs: `filters[category.slug]=x` and `filters[category][slug]=x` both become
 * `category.slug`; `filters[tags][]=a&filters[tags][]=b` (or the key repeated) becomes a list.
 */
const flattenFilters = (value: unknown, path: string[] = [], out: Record<string, string[]> = {}) => {
  const field = path.join('.');
  if (typeof value === 'string') {
    out[field] = [value];
  } else if (Array.isArray(value)) {
    if (value.length === 0 || !value.every((v) => typeof v === 'string')) {
      throw new SearchParamsError(`filters[${field}] must be one or more string values`);
    }
    out[field] = [...new Set(value as string[])];
  } else if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, nested] of Object.entries(value)) flattenFilters(nested, [...path, key], out);
  } else {
    throw new SearchParamsError(path.length ? `filters[${field}] must have a value` : '"filters" must be an object');
  }
  return out;
};

const parseFilters = (value: unknown, filterable: string[]): Record<string, string[]> => {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new SearchParamsError('"filters" must be an object');
  const filters = flattenFilters(value);
  const rejected = Object.keys(filters).filter((field) => !filterable.includes(field));
  if (rejected.length > 0) {
    throw new SearchParamsError(`Filter not allowed: ${rejected.join(', ')}`, { allowed: filterable });
  }
  for (const [field, values] of Object.entries(filters)) {
    if (values.some((v) => v === '')) throw new SearchParamsError(`filters[${field}] must not be empty`);
  }
  return filters;
};

/** `sort=publishedAt:desc,title.keyword` or `sort[]=…`. Direction defaults to `asc`; `_score` is always allowed. */
const parseSort = (value: unknown, sortable: string[]): SearchParams['sort'] => {
  if (value === undefined || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  if (!items.every((item) => typeof item === 'string')) {
    throw new SearchParamsError('"sort" must be "field:asc|desc" values');
  }

  const sort: SearchParams['sort'] = [];
  for (const item of (items as string[]).flatMap((s) => s.split(','))) {
    const [field, order = 'asc', ...rest] = item.trim().split(':');
    if (!field || rest.length > 0 || (order !== 'asc' && order !== 'desc')) {
      throw new SearchParamsError(`Invalid sort "${item}": use "field:asc" or "field:desc"`);
    }
    if (field !== '_score' && !sortable.includes(field)) {
      throw new SearchParamsError(`Sort not allowed on "${field}"`, { allowed: ['_score', ...sortable] });
    }
    if (sort.some((s) => s.field === field)) throw new SearchParamsError(`Sort field "${field}" is repeated`);
    sort.push({ field, order });
  }
  return sort;
};

const parseHighlight = (value: unknown): boolean => {
  // `?highlight` with no value is `null` (Strapi parses the query string with strictNullHandling).
  if (value === undefined) return false;
  if (value === null || value === 'true') return true;
  if (value === 'false') return false;
  throw new SearchParamsError('"highlight" must be "true" or "false"');
};

/** Validates the query string against the content type whitelist. Throws `SearchParamsError`. */
export const parseSearchParams = (query: unknown, limits: SearchLimits): SearchParams => {
  const params = isPlainObject(query) ? query : {};

  const unknown = Object.keys(params).filter((key) => !(ALLOWED_PARAMS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new SearchParamsError(`Parameter not allowed: ${unknown.join(', ')}`, { allowed: [...ALLOWED_PARAMS] });
  }

  const q = (singleString('q', params.q) ?? '').trim();
  if (q.length > MAX_QUERY_LENGTH) throw new SearchParamsError(`"q" must be at most ${MAX_QUERY_LENGTH} characters`);

  const locale = singleString('locale', params.locale) || undefined;

  const page = positiveInt('page', params.page, 1);
  const pageSize = positiveInt('pageSize', params.pageSize, limits.defaultPageSize);
  if (pageSize > limits.maxPageSize) {
    throw new SearchParamsError(`"pageSize" must be at most ${limits.maxPageSize}`);
  }
  if (page * pageSize > MAX_RESULT_WINDOW) {
    throw new SearchParamsError(`page * pageSize must be at most ${MAX_RESULT_WINDOW}`);
  }

  return {
    q,
    locale,
    filters: parseFilters(params.filters, limits.filterable),
    sort: parseSort(params.sort, limits.sortable),
    page,
    pageSize,
    highlight: parseHighlight(params.highlight),
  };
};

/** `fields` entries of the config may carry a boost (`title^3`); highlight wants the bare name. */
export const stripBoost = (field: string): string => field.replace(/\^[\d.]+$/, '');

/** `fields` of a `field_caps` response: field name → { type → capabilities }. */
export type FieldCaps = Record<string, Record<string, unknown>>;

/**
 * Field to use in `term`/`sort` for a configured name. With dynamic mapping a string becomes
 * `text` with a `.keyword` sub-field: filters and sort must use the keyword one. Unknown fields
 * (no document has them yet) are used as they are.
 */
export const resolveKeywordField = (field: string, caps: FieldCaps): string => {
  const types = Object.keys(caps[field] ?? {});
  const keyword = `${field}.keyword`;
  if (types.includes('text') && caps[keyword]?.keyword) return keyword;
  return field;
};

export interface SearchBodyInput {
  params: SearchParams;
  /** `search.fields` of the content type, with boosts. */
  fields: string[];
  /** Configured field name → field actually queried (see `resolveKeywordField`). */
  resolveField?: (field: string) => string;
}

export const buildSearchBody = ({ params, fields, resolveField = (f) => f }: SearchBodyInput): PlainObject => {
  const must = params.q
    ? [{ multi_match: { query: params.q, fields, type: 'best_fields', lenient: true } }]
    : [{ match_all: {} }];

  const filter = Object.entries(params.filters).map(([field, values]) =>
    values.length === 1 ? { term: { [resolveField(field)]: values[0] } } : { terms: { [resolveField(field)]: values } },
  );

  const body: PlainObject = {
    query: { bool: { must, filter } },
    from: (params.page - 1) * params.pageSize,
    size: params.pageSize,
    track_total_hits: true,
  };

  if (params.sort.length > 0) {
    body.sort = params.sort.map(({ field, order }) =>
      field === '_score'
        ? { _score: { order } }
        : // `unmapped_type`: no error on an index where no document has the field yet.
          { [resolveField(field)]: { order, unmapped_type: 'keyword' } },
    );
    // Sorting by a field drops `_score` unless asked for.
    if (params.q) body.track_scores = true;
  }

  if (params.highlight) {
    body.highlight = {
      // Escapes the source text: highlights are safe to render as HTML (only <em> is markup).
      encoder: 'html',
      fields: Object.fromEntries(fields.map((f) => [stripBoost(f), {}])),
    };
  }

  return body;
};

interface SearchHit {
  _source?: PlainObject;
  _score?: number | null;
  highlight?: Record<string, string[]>;
}

interface SearchResponseBody {
  hits: { total?: number | { value: number }; hits: SearchHit[] };
}

export interface SearchResult {
  data: PlainObject[];
  meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } };
}

export const formatSearchResponse = (body: SearchResponseBody, params: SearchParams): SearchResult => {
  const rawTotal = body.hits.total;
  const total = typeof rawTotal === 'number' ? rawTotal : (rawTotal?.value ?? 0);
  return {
    data: body.hits.hits.map((hit) => ({
      ...(hit._source ?? {}),
      _score: hit._score ?? null,
      ...(params.highlight ? { _highlight: hit.highlight ?? {} } : {}),
    })),
    meta: {
      pagination: {
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.ceil(total / params.pageSize),
        total,
      },
    },
  };
};
