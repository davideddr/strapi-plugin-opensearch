import { z } from 'zod';

// OpenSearch index names: lowercase, no spaces or reserved characters, not starting with - _ +
const indexNamePart = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters, digits, "-" or "_"');

const fn = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === 'function', {
  message: 'must be a function',
});

const plainObject = z.record(z.string(), z.unknown());

const authSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('basic'),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal('aws-sigv4'),
    region: z.string().min(1),
    service: z.enum(['es', 'aoss']).default('es'),
  }),
]);

const connectionSchema = z.object({
  node: z.url({ protocol: /^https?$/ }),
  auth: authSchema,
  ssl: z
    .object({
      rejectUnauthorized: z.boolean().optional(),
      ca: z.string().min(1).optional(),
    })
    .optional(),
  requestTimeout: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
});

const contentTypeSchema = z.object({
  indexName: indexNamePart.optional(),
  locales: z.union([z.literal('all'), z.array(z.string().min(1)).min(1)]).optional(),
  populate: z.unknown().optional(),
  transform: fn.optional(),
  filter: fn.optional(),
  mappings: plainObject.optional(),
  settings: plainObject.optional(),
  search: z.object({
    fields: z.array(z.string().min(1)).min(1),
    filterable: z.array(z.string().min(1)).optional(),
    sortable: z.array(z.string().min(1)).optional(),
  }),
});

export const configSchema = z
  .object({
    connection: connectionSchema,
    indexPrefix: indexNamePart,
    bulkSize: z.number().int().positive(),
    contentTypes: z.record(z.string().regex(/^[a-z]+::[\w-]+\.[\w-]+$/, 'not a content type uid'), contentTypeSchema),
    search: z.object({
      defaultPageSize: z.number().int().positive(),
      maxPageSize: z.number().int().positive(),
    }),
  })
  .refine((c) => c.search.defaultPageSize <= c.search.maxPageSize, {
    message: 'must be <= search.maxPageSize',
    path: ['search', 'defaultPageSize'],
  });

const formatIssues = (error: z.ZodError) =>
  error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');

export default {
  default: {
    indexPrefix: 'strapi',
    bulkSize: 500,
    contentTypes: {},
    search: { defaultPageSize: 10, maxPageSize: 100 },
  },
  validator(config: unknown) {
    const result = configSchema.safeParse(config);
    if (!result.success) {
      throw new Error(`invalid values:\n${formatIssues(result.error)}`);
    }
  },
};
