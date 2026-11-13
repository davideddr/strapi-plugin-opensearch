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
  async search(ctx: SearchContext) {
    const { index } = ctx.params;
    try {
      ctx.body = await strapi.plugin(PLUGIN_ID).service('search').search(index, ctx.query);
    } catch (error) {
      if (error instanceof SearchParamsError) return ctx.badRequest(error.message, error.details);
      if (error instanceof UnknownIndexError) return ctx.notFound(error.message);
      // Never forward OpenSearch errors: they expose index names, mappings and cluster details.
      // (Rethrowing would not help: Strapi exposes the message of any error with a 4xx `statusCode`.)
      strapi.log.error(`[opensearch] search on "${index}" failed: ${(error as Error).message}`);
      return ctx.serviceUnavailable('Search is temporarily unavailable');
    }
  },
});

export default search;
