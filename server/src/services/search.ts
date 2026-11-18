import type { Core, UID } from '@strapi/strapi';
import type { Client } from '@opensearch-project/opensearch';
import type { PluginConfig } from '../types';
import { PLUGIN_ID } from '../types';
import {
  type FieldCaps,
  type SearchParams,
  type SearchResult,
  SearchParamsError,
  UnknownIndexError,
  buildMultiSearchBody,
  buildSearchBody,
  formatSearchResponse,
  intersect,
  parseMultiSearchQuery,
  parseSearchParams,
  resolveKeywordField,
} from '../utils/search-query';
import { isVersionOf } from '../utils/naming';

/** `group=true`: one result set per index, keyed by its public name, in the requested order. */
export interface GroupedSearchResult {
  data: Record<string, SearchResult>;
}

/** Field capabilities change only when a new field is mapped: a short cache saves one request per search. */
const FIELD_CAPS_TTL_MS = 60_000;

const search = ({ strapi }: { strapi: Core.Strapi }) => {
  const getConfig = <K extends keyof PluginConfig>(key: K): PluginConfig[K] => strapi.plugin(PLUGIN_ID).config(key);
  const getClient = (): Client => strapi.plugin(PLUGIN_ID).service('client').getClient();
  const indexManager = () => strapi.plugin(PLUGIN_ID).service('index-manager');

  const fieldCapsCache = new Map<string, { expires: number; caps: FieldCaps }>();

  const indexNameOf = (uid: UID.ContentType): string =>
    getConfig('contentTypes')[uid].indexName ?? strapi.contentType(uid)?.info.singularName ?? uid;

  /** `:index` is the configured `indexName` (default: singularName), never the physical index. */
  const resolveContentType = (index: string): UID.ContentType => {
    const contentTypes = getConfig('contentTypes');
    const uid = (Object.keys(contentTypes) as UID.ContentType[]).find((current) => indexNameOf(current) === index);
    if (!uid) throw new UnknownIndexError(index);
    return uid;
  };

  /**
   * The requested locale, or the default Strapi locale when absent. Must be one of the indexed locales.
   * A non-localized index rejects `locale`, unless `ignoreOnNonLocalized` (multi-index search, where
   * the locale applies only to the localized indices).
   */
  const resolveLocale = async (
    uid: UID.ContentType,
    requested: string | undefined,
    { ignoreOnNonLocalized = false } = {},
  ): Promise<string | null> => {
    const locales: (string | null)[] = await indexManager().getLocales(uid);
    if (locales.length === 1 && locales[0] === null) {
      if (requested && !ignoreOnNonLocalized) {
        throw new SearchParamsError('"locale" is not allowed: this index is not localized');
      }
      return null;
    }
    const locale = requested ?? (await strapi.plugin('i18n').service('locales').getDefaultLocale());
    if (!locales.includes(locale)) {
      throw new SearchParamsError(
        requested
          ? `Locale not available${ignoreOnNonLocalized ? ` on "${indexNameOf(uid)}"` : ''}: ${requested}`
          : '"locale" is required for this index',
        { allowed: locales },
      );
    }
    return locale;
  };

  const getFieldCaps = async (alias: string, fields: string[]): Promise<FieldCaps> => {
    if (fields.length === 0) return {};
    const key = `${alias}|${fields.join(',')}`;
    const cached = fieldCapsCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.caps;

    const { body } = await getClient().fieldCaps({
      index: alias,
      fields: fields.flatMap((field) => [field, `${field}.keyword`]),
    });
    const caps = (body.fields ?? {}) as FieldCaps;
    fieldCapsCache.set(key, { expires: Date.now() + FIELD_CAPS_TTL_MS, caps });
    return caps;
  };

  /** Fields used in `term` / `sort`, which may need their `.keyword` sub-field. */
  const keywordCandidates = (params: SearchParams): string[] =>
    [...new Set([...Object.keys(params.filters), ...params.sort.map((s) => s.field)])]
      .filter((field) => field !== '_score')
      .sort();

  return {
    /**
     * Runs a whitelisted search on one configured index. Throws `UnknownIndexError` (404),
     * `SearchParamsError` (400) or the client error when the cluster fails.
     */
    async search(index: string, query: unknown): Promise<SearchResult> {
      const uid = resolveContentType(index);
      const { search: ctSearch } = getConfig('contentTypes')[uid];
      const { defaultPageSize, maxPageSize } = getConfig('search');

      const params = parseSearchParams(query, {
        filterable: ctSearch.filterable ?? [],
        sortable: ctSearch.sortable ?? [],
        defaultPageSize,
        maxPageSize,
      });

      const locale = await resolveLocale(uid, params.locale);
      const alias: string = indexManager().getAliasName(uid, locale);

      const caps = await getFieldCaps(alias, keywordCandidates(params));

      const body = buildSearchBody({
        params,
        fields: ctSearch.fields,
        resolveField: (field) => resolveKeywordField(field, caps),
      });
      const response = await getClient().search({ index: alias, body: body as never });
      return formatSearchResponse(response.body as never, params);
    },

    /**
     * Searches several configured indices at once (`indices` is required). Filters and sort must be
     * allowed on every requested index; `locale` applies to the localized ones. Default: a single
     * list ranked by score, each hit tagged with `_index`; `group=true`: one result set per index.
     */
    async multiSearch(query: unknown): Promise<SearchResult | GroupedSearchResult> {
      const { indices, group, query: rest } = parseMultiSearchQuery(query);
      const uids = indices.map(resolveContentType);
      const configs = uids.map((uid) => getConfig('contentTypes')[uid].search);
      const { defaultPageSize, maxPageSize } = getConfig('search');

      const params = parseSearchParams(rest, {
        filterable: intersect(configs.map((c) => c.filterable ?? [])),
        sortable: intersect(configs.map((c) => c.sortable ?? [])),
        defaultPageSize,
        maxPageSize,
      });

      const candidates = keywordCandidates(params);
      const targets = await Promise.all(
        uids.map(async (uid, i) => {
          const locale = await resolveLocale(uid, params.locale, { ignoreOnNonLocalized: true });
          const alias: string = indexManager().getAliasName(uid, locale);
          const caps = await getFieldCaps(alias, candidates);
          return {
            name: indices[i],
            alias,
            fields: configs[i].fields,
            resolveField: (field: string) => resolveKeywordField(field, caps),
          };
        }),
      );

      if (group) {
        const body = targets.flatMap(({ alias, fields, resolveField }) => [
          { index: alias },
          buildSearchBody({ params, fields, resolveField }),
        ]);
        const { body: response } = await getClient().msearch({ body: body as never });
        const responses = (response as { responses: { error?: { type?: string; reason?: string } }[] }).responses;
        const data: Record<string, SearchResult> = {};
        targets.forEach(({ name, alias }, i) => {
          const item = responses[i];
          if (!item || item.error) {
            throw new Error(
              `msearch failed on ${alias}: ${item?.error?.type ?? 'no response'} ${item?.error?.reason ?? ''}`,
            );
          }
          data[name] = formatSearchResponse(item as never, params);
        });
        return { data };
      }

      // The sort is shared by every alias: a field must resolve to the same name on all of them.
      const resolveSortField = (field: string): string => {
        const resolved = [...new Set(targets.map((t) => t.resolveField(field)))];
        if (resolved.length > 1) {
          throw new SearchParamsError(`Sort on "${field}" is not possible: it is mapped differently on these indices`);
        }
        return resolved[0];
      };
      const body = buildMultiSearchBody({ params, targets, resolveSortField });
      const response = await getClient().search({ index: targets.map((t) => t.alias), body: body as never });
      return formatSearchResponse(
        response.body as never,
        params,
        (physical) => targets.find((t) => isVersionOf(t.alias, physical) || t.alias === physical)?.name,
      );
    },
  };
};

export default search;
