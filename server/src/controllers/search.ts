import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../types';
import { SearchParamsError, UnknownIndexError } from '../utils/search-query';

/** The subset of the Koa context used here (Strapi adds the error helpers). */
export interface SearchContext {
  params: Record<string, string>;
  query: unknown;
  body: unknown;
  badRequest: (message?: string, details?: unknown) => void;
  notFound: (message?: string) => void;
  serviceUnavailable: (message?: string) => void;
}

const search = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * `GET /search/:index` searches one index, `GET /search?indices=a,b` several: same action, so
   * one Users & Permissions permission covers both.
   */
  async search(ctx: SearchContext) {
    const { index } = ctx.params;
    const service = strapi.plugin(PLUGIN_ID).service('search');
    try {
      ctx.body = index ? await service.search(index, ctx.query) : await service.multiSearch(ctx.query);
    } catch (error) {
      if (error instanceof SearchParamsError) return ctx.badRequest(error.message, error.details);
      if (error instanceof UnknownIndexError) return ctx.notFound(error.message);
      // Never forward OpenSearch errors: they expose index names, mappings and cluster details.
      // (Rethrowing would not help: Strapi exposes the message of any error with a 4xx `statusCode`.)
      const target = index ? `"${index}"` : 'multiple indices';
      strapi.log.error(`[opensearch] search on ${target} failed: ${(error as Error).message}`);
      return ctx.serviceUnavailable('Search is temporarily unavailable');
    }
  },
});

export default search;
