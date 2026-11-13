import type { UID } from '@strapi/strapi';

export const PLUGIN_ID = 'opensearch';

export interface BasicAuthConfig {
  type: 'basic';
  username: string;
  password: string;
}

export interface AwsSigv4AuthConfig {
  type: 'aws-sigv4';
  region: string;
  /** `es` for OpenSearch Service, `aoss` for OpenSearch Serverless. */
  service: 'es' | 'aoss';
}

export type AuthConfig = BasicAuthConfig | AwsSigv4AuthConfig;

export interface SslConfig {
  rejectUnauthorized?: boolean;
  /** PEM content or path to a PEM file. */
  ca?: string;
}

export interface ConnectionConfig {
  node: string;
  auth: AuthConfig;
  ssl?: SslConfig;
  requestTimeout?: number;
  maxRetries?: number;
}

export type Entry = Record<string, unknown>;

export interface TransformContext {
  uid: UID.ContentType;
  locale: string | null;
}

export interface ContentTypeSearchConfig {
  fields: string[];
  filterable?: string[];
  sortable?: string[];
}

export interface ContentTypeConfig {
  /** Default: the content type singularName. */
  indexName?: string;
  /** `'all'` or a list of locale codes. Ignored when i18n is off for the content type. */
  locales?: 'all' | string[];
  populate?: unknown;
  transform?: (entry: Entry, ctx: TransformContext) => Entry | Promise<Entry>;
  filter?: (entry: Entry, ctx: TransformContext) => boolean | Promise<boolean>;
  mappings?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  search: ContentTypeSearchConfig;
}

export interface SearchConfig {
  defaultPageSize: number;
  maxPageSize: number;
}

export interface PluginConfig {
  connection: ConnectionConfig;
  indexPrefix: string;
  bulkSize: number;
  contentTypes: Record<string, ContentTypeConfig>;
  search: SearchConfig;
}
