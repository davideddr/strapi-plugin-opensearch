/**
 * Settings and mappings of a new physical index. Pure functions, no Strapi or client dependency.
 */

type PlainObject = Record<string, unknown>;

/**
 * Built-in OpenSearch language analyzers by base language code. Anything else falls back to the
 * `standard` analyzer (no explicit setting).
 */
const LANGUAGE_ANALYZERS: Record<string, string> = {
  ar: 'arabic',
  bg: 'bulgarian',
  ca: 'catalan',
  cs: 'czech',
  da: 'danish',
  de: 'german',
  el: 'greek',
  en: 'english',
  es: 'spanish',
  eu: 'basque',
  fa: 'persian',
  fi: 'finnish',
  fr: 'french',
  ga: 'irish',
  gl: 'galician',
  hi: 'hindi',
  hu: 'hungarian',
  hy: 'armenian',
  id: 'indonesian',
  it: 'italian',
  lt: 'lithuanian',
  lv: 'latvian',
  nb: 'norwegian',
  nl: 'dutch',
  no: 'norwegian',
  pt: 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  sv: 'swedish',
  th: 'thai',
  tr: 'turkish',
};

/** `it` → `italian`, `en-GB` → `english`, `pt-BR` → `brazilian`, unknown or null → `standard`. */
export const analyzerForLocale = (locale: string | null): string => {
  if (!locale) return 'standard';
  const normalized = locale.toLowerCase().replace('_', '-');
  if (normalized === 'pt-br') return 'brazilian';
  return LANGUAGE_ANALYZERS[normalized.split('-')[0]] ?? 'standard';
};

/** Fields every document carries (see ARCHITECTURE "Modello degli indici"). */
export const BASE_MAPPINGS: PlainObject = {
  properties: {
    documentId: { type: 'keyword' },
    locale: { type: 'keyword' },
    publishedAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
};

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Recursive merge where `override` wins; arrays and scalars are replaced, not concatenated. */
export const deepMerge = (base: PlainObject, override: PlainObject): PlainObject => {
  const result: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
};

export const defaultSettings = (locale: string | null): PlainObject => {
  const analyzer = analyzerForLocale(locale);
  return analyzer === 'standard' ? {} : { analysis: { analyzer: { default: { type: analyzer } } } };
};

export interface IndexBodyInput {
  locale: string | null;
  settings?: PlainObject;
  mappings?: PlainObject;
}

/** Defaults (language analyzer + base fields) with the content type config merged on top. */
export const buildIndexBody = ({ locale, settings, mappings }: IndexBodyInput) => ({
  settings: deepMerge(defaultSettings(locale), settings ?? {}),
  mappings: deepMerge(BASE_MAPPINGS, mappings ?? {}),
});
