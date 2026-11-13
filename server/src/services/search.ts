import type { Core, UID } from '@strapi/strapi';
import type { Client } from '@opensearch-project/opensearch';
import type { PluginConfig } from '../types';
import { PLUGIN_ID } from '../types';
import {
  type FieldCaps,
  type SearchResult,
  SearchParamsError,
  UnknownIndexError,
  buildSearchBody,
  formatSearchResponse,
  parseSearchParams,
  resolveKeywordField,
} from '../utils/search-query';

/** Field capabilities change only when a new field is mapped: a short cache saves one request per search. */
const FIELD_CAPS_TTL_MS = 60_000;

const search = ({ strapi }: { strapi: Core.Strapi }) => {
  const getConfig = <K extends keyof PluginConfig>(key: K): PluginConfig[K] => strapi.plugin(PLUGIN_ID).config(key);
  const getClient = (): Client => strapi.plugin(PLUGIN_ID).service('client').getClient();
  const indexManager = () => strapi.plugin(PLUGIN_ID).service('index-manager');

  const fieldCapsCache = new Map<string, { expires: number; caps: FieldCaps }>();

  /** `:index` is the configured `indexName` (default: singularName), never the physical index. */
  const resolveContentType = (index: string): UID.ContentType => {
    const contentTypes = getConfig('contentTypes');
    const uid = (Object.keys(contentTypes) as UID.ContentType[]).find(
      (current) => (contentTypes[current].indexName ?? strapi.contentType(current)?.info.singularName) === index,
    );
    if (!uid) throw new UnknownIndexError(index);
    return uid;
  };

  /** The requested locale, or the default Strapi locale when absent. Must be one of the indexed locales. */
  const resolveLocale = async (uid: UID.ContentType, requested: string | undefined): Promise<string | null> => {
    const locales: (string | null)[] = await indexManager().getLocales(uid);
    if (locales.length === 1 && locales[0] === null) {
      if (requested) throw new SearchParamsError('"locale" is not allowed: this index is not localized');
      return null;
    }
    const locale = requested ?? (await strapi.plugin('i18n').service('locales').getDefaultLocale());
    if (!locales.includes(locale)) {
      throw new SearchParamsError(
        requested ? `Locale not available: ${requested}` : '"locale" is required for this index',
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

      const keywordCandidates = [...Object.keys(params.filters), ...params.sort.map((s) => s.field)].filter(
        (field) => field !== '_score',
      );
      const caps = await getFieldCaps(alias, [...new Set(keywordCandidates)].sort());

      const body = buildSearchBody({
        params,
        fields: ctSearch.fields,
        resolveField: (field) => resolveKeywordField(field, caps),
      });
      const response = await getClient().search({ index: alias, body: body as never });
      return formatSearchResponse(response.body as never, params);
    },
  };
};

export default search;
