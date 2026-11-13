/**
 * Index and alias naming. Pure functions, no Strapi or client dependency.
 *
 * - alias:    `{prefix}_{indexName}_{locale}`, or `{prefix}_{indexName}` when the content type is not localized
 * - physical: `{alias}_v{timestamp}`
 */

/** Lowercases and replaces every character OpenSearch rejects (or that we do not want) with `_`. */
export const sanitizeNamePart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_');

export const buildAliasName = (prefix: string, indexName: string, locale: string | null): string =>
  [prefix, indexName, locale]
    .filter((part): part is string => !!part)
    .map(sanitizeNamePart)
    .join('_');

export const buildVersionedIndexName = (alias: string, timestamp: number): string => `${alias}_v${timestamp}`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when `index` is a physical version of `alias`. Exact match on `{alias}_v{digits}`, so the
 * alias `x_article` does not claim `x_article_vi_v123` (the `vi` locale of the same index name).
 */
export const isVersionOf = (alias: string, index: string): boolean =>
  new RegExp(`^${escapeRegExp(alias)}_v\\d+$`).test(index);

/** Wildcard that lists the candidate versions of an alias; filter the result with `isVersionOf`. */
export const versionPattern = (alias: string): string => `${alias}_v*`;
