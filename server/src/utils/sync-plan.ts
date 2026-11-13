/**
 * Maps a Document Service call to the indexing work it implies. Pure, no Strapi dependency.
 *
 * Verified on Strapi 5.61.1 (core `document-service/repository.js`, middleware-manager):
 * `context.action` is the repository method name (`create`, `update`, `delete`, `publish`,
 * `unpublish`, `discardDraft`, `clone`, plus the read methods), `context.params` is the object
 * passed to it. `params.locale` is a code, `'*'` (all locales), an array (Content Manager bulk
 * actions) or absent, which the Document Service resolves to the default locale.
 */

export type SyncAction = 'index' | 'remove';

/**
 * Locales to touch: `'all'` (every configured locale), `'default'` (the Strapi default locale),
 * or an explicit list (`[null]` for content types without i18n).
 */
export type LocaleSelector = 'all' | 'default' | (string | null)[];

export interface SyncPlan {
  /** `index` loads the published version and indexes it, or removes it when absent/filtered. */
  action: SyncAction;
  documentId: string;
  locales: LocaleSelector;
}

export interface SyncPlanInput {
  action: string;
  params: Record<string, unknown> | undefined;
  result: unknown;
  draftAndPublish: boolean;
  localized: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

const localesFromParams = (locale: unknown): LocaleSelector => {
  if (locale === '*') return 'all';
  if (Array.isArray(locale)) return locale.filter((code): code is string => typeof code === 'string');
  const code = asString(locale);
  return code ? [code] : 'default';
};

/** Locales of the entries a write returned (an entry, or `{ documentId, entries }`). */
const localesFromResult = (result: unknown): string[] => {
  if (!isObject(result)) return [];
  const entries = Array.isArray(result.entries) ? result.entries : [result];
  return [...new Set(entries.map((entry) => (isObject(entry) ? asString(entry.locale) : null)))].filter(
    (code): code is string => code !== null,
  );
};

export const buildSyncPlan = ({
  action,
  params = {},
  result,
  draftAndPublish,
  localized,
}: SyncPlanInput): SyncPlan[] => {
  const resultDocumentId = isObject(result) ? asString(result.documentId) : null;
  const paramsDocumentId = asString(params.documentId);

  const locales = (fromResult: boolean): LocaleSelector => {
    if (!localized) return [null];
    if (fromResult) {
      const found = localesFromResult(result);
      if (found.length > 0) return found;
    }
    return localesFromParams(params.locale);
  };

  const plan = (syncAction: SyncAction, documentId: string | null, fromResult = false): SyncPlan[] =>
    documentId ? [{ action: syncAction, documentId, locales: locales(fromResult) }] : [];

  switch (action) {
    case 'publish':
      return plan('index', paramsDocumentId);
    case 'unpublish':
    case 'delete':
      return plan('remove', paramsDocumentId);
    case 'create':
    case 'update':
      // A draft save does not change the published version.
      if (draftAndPublish && params.status !== 'published') return [];
      return plan('index', resultDocumentId ?? paramsDocumentId, true);
    case 'clone':
      // With D&P a clone is always a new draft.
      return draftAndPublish ? [] : plan('index', resultDocumentId, true);
    default:
      // discardDraft (published version untouched) and the read methods.
      return [];
  }
};
