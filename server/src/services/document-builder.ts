import type { Core, UID } from '@strapi/strapi';
import type { ContentTypeConfig, Entry, PluginConfig, TransformContext } from '../types';
import { PLUGIN_ID } from '../types';

/** Fields every indexed document carries, whatever `transform` returns. */
export const BASE_FIELDS = ['documentId', 'locale', 'publishedAt', 'updatedAt'] as const;

export interface IndexDocument extends Entry {
  documentId: string;
  locale: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
}

const isPlainObject = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Default document: the sanitized entry (scalars plus populated relations, components and
 * dynamic zones) without the database `id`, which differs between the draft and published rows.
 */
export const defaultTransform = (entry: Entry): Entry => {
  const { id: _id, ...rest } = entry;
  return rest;
};

const toIsoOrNull = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
};

const documentBuilder = ({ strapi }: { strapi: Core.Strapi }) => {
  const getContentTypeConfig = (uid: UID.ContentType): ContentTypeConfig => {
    const ctConfig = strapi.plugin(PLUGIN_ID).config<PluginConfig['contentTypes']>('contentTypes')[uid];
    if (!ctConfig) throw new Error(`[opensearch] content type ${uid} is not configured`);
    return ctConfig;
  };

  return {
    /**
     * Published version of a document in one locale (`locale: null` when i18n is off), with the
     * configured `populate`. `null` when it does not exist or is not published.
     */
    async load(uid: UID.ContentType, documentId: string, locale: string | null): Promise<Entry | null> {
      const { populate } = getContentTypeConfig(uid);
      const entry = await strapi.documents(uid).findOne({
        documentId,
        status: 'published',
        ...(locale ? { locale } : {}),
        ...(populate !== undefined ? { populate: populate as never } : {}),
      });
      return (entry as Entry | null) ?? null;
    },

    /**
     * Turns a loaded entry into the document to index: sanitize (private fields and passwords
     * removed) → `filter` → `transform` (or {@link defaultTransform}) → base fields.
     * Returns `null` when `filter` excludes the entry, meaning it must be removed from the index.
     * Errors from `filter`/`transform` are logged with uid and documentId, then rethrown.
     */
    async build(uid: UID.ContentType, entry: Entry, locale: string | null): Promise<IndexDocument | null> {
      const { filter, transform } = getContentTypeConfig(uid);
      const documentId = String(entry.documentId);
      const ctx: TransformContext = { uid, locale };

      try {
        const sanitized = await strapi.contentAPI.sanitize.output(entry, strapi.getModel(uid));
        if (!isPlainObject(sanitized)) throw new Error('sanitized entry is not an object');

        if (filter && !(await filter(sanitized, ctx))) return null;

        const body = transform ? await transform(sanitized, ctx) : defaultTransform(sanitized);
        if (!isPlainObject(body)) throw new Error('transform must return a plain object');

        return {
          ...body,
          documentId,
          locale: locale ?? null,
          publishedAt: toIsoOrNull(entry.publishedAt),
          updatedAt: toIsoOrNull(entry.updatedAt),
        };
      } catch (error) {
        strapi.log.error(`[opensearch] cannot build document ${uid} ${documentId}: ${(error as Error).message}`);
        throw error;
      }
    },

    /** `load` + `build`. `null` when the entry is not published or is filtered out. */
    async loadAndBuild(uid: UID.ContentType, documentId: string, locale: string | null) {
      const entry = await this.load(uid, documentId, locale);
      return entry ? this.build(uid, entry, locale) : null;
    },
  };
};

export default documentBuilder;
