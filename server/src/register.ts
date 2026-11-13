import type { Core } from '@strapi/strapi';
import { createSyncMiddleware } from './middlewares/sync';

const register = ({ strapi }: { strapi: Core.Strapi }) => {
  // Real-time sync: publish/unpublish/delete keep the indices aligned (see middlewares/sync.ts).
  strapi.documents.use(createSyncMiddleware(strapi));
};

export default register;
