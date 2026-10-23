import { z } from 'zod';
import { settingFieldSchema } from './library';

export const CONTENT_CAPABILITY_VERSION = 1 as const;
const id = z.string().min(1).max(4096);
const lease = z.string().min(1).max(256);
const jsonRecord = z.record(z.string().max(256), z.json());
const headers = z.record(z.string().min(1).max(128), z.string().max(8192));
export const sourceUrlSchema = z
  .string()
  .max(16384)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Expected an HTTP(S) URL without embedded credentials');

export const sourceDefinitionSchema = z.strictObject({
  id,
  format: id,
  name: z.string().min(1).max(2048),
  content: z.string().max(4 * 1024 * 1024),
  revision: z.string().min(1).max(512),
  version: z.string().max(256).optional(),
  // Importers may suggest domains. Only the host/user can grant access.
  origins: z.array(sourceUrlSchema).max(128).optional(),
});
export type SourceDefinition = z.infer<typeof sourceDefinitionSchema>;
export const sourceContextSchema = z.strictObject({
  instance: lease,
  providerId: id,
  config: jsonRecord,
  pluginConfig: jsonRecord.optional(),
  pluginSecretNames: z.array(z.string().max(256)).max(128).optional(),
  networkOrigins: z.array(sourceUrlSchema).max(128).optional(),
  definition: sourceDefinitionSchema.optional(),
  secrets: z.record(z.string(), lease).optional(),
});
export type SourceContext = z.infer<typeof sourceContextSchema>;
export const contentSourceContributionSchema = z.strictObject({
  id,
  name: z.string().min(1).max(128),
  capabilityVersion: z.literal(CONTENT_CAPABILITY_VERSION).optional(),
  kinds: z
    .array(z.enum(['text', 'comic']))
    .min(1)
    .max(2),
  capabilities: z.strictObject({
    search: z.boolean().optional(),
    explore: z.boolean().optional(),
    authenticate: z.boolean().optional(),
    checkUpdates: z.boolean().optional(),
    describe: z.boolean().optional(),
    validateSettings: z.boolean().optional(),
    settingActions: z.boolean().optional(),
  }),
  settings: z.array(settingFieldSchema).max(32),
});
export type ContentSourceContribution = z.infer<typeof contentSourceContributionSchema>;
export const sourceFormatContributionSchema = z.strictObject({
  id,
  providerId: id,
  name: z.string().min(1).max(128),
  extensions: z
    .array(z.string().regex(/^[a-z0-9]+$/))
    .min(1)
    .max(16),
});
export const resourceRefSchema = z.strictObject({
  id,
  url: sourceUrlSchema.optional(),
  headers: headers.optional(),
  mimeType: z.string().max(255).optional(),
  data: jsonRecord.optional(),
});
export type ResourceRef = z.infer<typeof resourceRefSchema>;
export const workSchema = z.strictObject({
  id,
  title: z.string().min(1).max(2048),
  author: z.string().max(2048),
  kind: z.enum(['text', 'comic']),
  description: z.string().max(65536).optional(),
  cover: resourceRefSchema.optional(),
  revision: z.string().max(512).optional(),
  url: sourceUrlSchema.optional(),
  data: jsonRecord.optional(),
  tags: z.array(z.string().max(256)).max(128).optional(),
  language: z.string().max(64).optional(),
});
export type Work = z.infer<typeof workSchema>;
export const chapterSchema = z.strictObject({
  id,
  title: z.string().min(1).max(2048),
  url: sourceUrlSchema.optional(),
  revision: z.string().max(512).optional(),
  group: z.string().max(2048).optional(),
  data: jsonRecord.optional(),
});
export type Chapter = z.infer<typeof chapterSchema>;
export const chapterContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('html'),
    html: z.string().max(8 * 1024 * 1024),
    resources: z.record(z.string().max(4096), resourceRefSchema).optional(),
    revision: z.string().max(512).optional(),
  }),
  z.strictObject({
    kind: z.literal('pages'),
    pages: z.array(resourceRefSchema).max(10000),
    revision: z.string().max(512).optional(),
  }),
]);
export type ChapterContent = z.infer<typeof chapterContentSchema>;
export const resolvedResourceSchema = z.strictObject({
  url: sourceUrlSchema,
  headers: headers.optional(),
  mimeType: z.string().max(255).optional(),
  expiresAt: z.number().nonnegative().optional(),
});
export type ResolvedResource = z.infer<typeof resolvedResourceSchema>;
export const readingLocatorSchema = z.strictObject({
  workId: id,
  chapterId: id,
  chapterProgress: z.number().min(0).max(1).optional(),
  text: z
    .strictObject({
      exact: z.string().max(4096),
      prefix: z.string().max(512).optional(),
      suffix: z.string().max(512).optional(),
    })
    .optional(),
  pageIndex: z.number().int().nonnegative().optional(),
  resourceId: id.optional(),
  cfi: z.string().max(8192).optional(),
  approximate: z.boolean().optional(),
  modified: z.number().nonnegative(),
});
export type ReadingLocator = z.infer<typeof readingLocatorSchema>;
const pagination = { cursor: z.string().max(65536).optional() };
const pageResult = { nextCursor: z.string().max(65536).optional() };
export const sourceDescriptionSchema = z.strictObject({
  settings: z.array(settingFieldSchema).max(128),
  actions: z
    .array(z.strictObject({ id: z.string().min(1).max(128), label: z.string().min(1).max(256) }))
    .max(32),
  authentication: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('form'), fields: z.array(settingFieldSchema).max(32) }),
    z.strictObject({ kind: z.literal('unsupported'), reason: z.string().max(4096) }),
  ]),
});
export type SourceDescription = z.infer<typeof sourceDescriptionSchema>;
export const sourcePayloadSchemas = {
  'source.describe': z.strictObject({ context: sourceContextSchema }),
  'source.validateSettings': z.strictObject({ context: sourceContextSchema, values: jsonRecord }),
  'source.runSettingAction': z.strictObject({
    context: sourceContextSchema,
    actionId: z.string().min(1).max(128),
  }),
  'source.inspect': z.strictObject({
    context: sourceContextSchema,
    content: z.string().max(4 * 1024 * 1024),
    format: id,
    filename: z.string().max(512).optional(),
    baseUrl: sourceUrlSchema.optional(),
  }),
  'source.search': z.strictObject({
    context: sourceContextSchema,
    query: z.string().max(4096),
    ...pagination,
    filters: jsonRecord.optional(),
  }),
  'source.explore': z.strictObject({
    context: sourceContextSchema,
    ...pagination,
    category: z.string().max(4096).optional(),
    filters: jsonRecord.optional(),
  }),
  'source.getWork': z.strictObject({ context: sourceContextSchema, work: workSchema }),
  'source.getChapters': z.strictObject({
    context: sourceContextSchema,
    work: workSchema,
    ...pagination,
  }),
  'source.resolveChapter': z.strictObject({
    context: sourceContextSchema,
    work: workSchema,
    chapter: chapterSchema,
  }),
  'source.resolveResource': z.strictObject({
    context: sourceContextSchema,
    resource: resourceRefSchema,
    work: workSchema.optional(),
    chapter: chapterSchema.optional(),
  }),
  'source.authenticate': z.strictObject({
    context: sourceContextSchema,
    input: jsonRecord.optional(),
  }),
  'source.checkUpdates': z.strictObject({ context: sourceContextSchema, work: workSchema }),
} as const;
export const sourceReferenceSchema = z.strictObject({
  name: z.string().min(1).max(2048),
  url: sourceUrlSchema,
  format: id,
  version: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
});
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const sourceResults = {
  'source.describe': sourceDescriptionSchema,
  'source.validateSettings': z.strictObject({
    fieldErrors: z.record(z.string().max(256), z.string().max(1024)),
  }),
  'source.runSettingAction': z.strictObject({
    completed: z.literal(true),
    message: z.string().max(4096).optional(),
  }),
  'source.inspect': z.strictObject({
    definitions: z.array(sourceDefinitionSchema).max(1000),
    references: z.array(sourceReferenceSchema).max(1000).optional(),
    diagnostics: z
      .array(
        z.strictObject({
          code: z.string().max(128),
          message: z.string().max(4000),
          severity: z.enum(['warning', 'error']),
        }),
      )
      .max(1000)
      .optional(),
  }),
  'source.search': z.strictObject({ items: z.array(workSchema).max(1000), ...pageResult }),
  'source.explore': z.strictObject({ items: z.array(workSchema).max(1000), ...pageResult }),
  'source.getWork': workSchema,
  'source.getChapters': z.strictObject({ items: z.array(chapterSchema).max(10000), ...pageResult }),
  'source.resolveChapter': chapterContentSchema,
  'source.resolveResource': resolvedResourceSchema,
  'source.authenticate': z.strictObject({
    authenticated: z.boolean(),
    message: z.string().max(4000).optional(),
  }),
  'source.checkUpdates': z.strictObject({ updated: z.boolean(), work: workSchema.optional() }),
} as const;
export type SourceOperation = keyof typeof sourcePayloadSchemas;
export type SourceResultMap = { [K in SourceOperation]: z.infer<(typeof sourceResults)[K]> };
export type SourcePayload<K extends SourceOperation> = z.infer<(typeof sourcePayloadSchemas)[K]>;

export const sourceHttpRequestSchema = z
  .strictObject({
    instance: lease,
    url: sourceUrlSchema,
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    headers: headers.optional(),
    body: z
      .union([
        z.string().max(8 * 1024 * 1024),
        z.instanceof(Uint8Array).refine((b) => b.byteLength <= 8 * 1024 * 1024),
      ])
      .optional(),
    json: z.json().optional(),
    timeoutMs: z.number().int().min(1).max(120000).optional(),
    auth: z
      .array(
        z.strictObject({
          secret: lease,
          in: z.enum(['header', 'query']),
          name: z.string().min(1).max(128),
        }),
      )
      .max(8)
      .optional(),
  })
  .refine(
    (request) => request.body === undefined || request.json === undefined,
    'Use body or json, not both',
  );
export type SourceHttpRequest = z.infer<typeof sourceHttpRequestSchema>;
export const sourceHttpResponseSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  url: sourceUrlSchema,
  headers,
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= 32 * 1024 * 1024),
});
export type SourceHttpResponse = z.infer<typeof sourceHttpResponseSchema>;
export const sourceInteractionSchema = z.strictObject({
  kind: z.enum(['form', 'message']),
  title: z.string().min(1).max(256),
  message: z.string().max(8192).optional(),
  fields: z.array(settingFieldSchema).max(32).optional(),
  values: jsonRecord.optional(),
});
const key = z.string().min(1).max(256);
export const sourceHostPayloadSchemas = {
  'source.settings.read': z.strictObject({
    instance: lease,
    scope: z.enum(['source', 'plugin']).optional(),
    keys: z.array(z.string().min(1).max(256)).max(128),
  }),
  'source.http': sourceHttpRequestSchema,
  'source.storage.get': z.strictObject({ instance: lease, key }),
  'source.storage.set': z.strictObject({ instance: lease, key, value: z.json() }),
  'source.storage.delete': z.strictObject({ instance: lease, key }),
  'source.cookies.get': z.strictObject({ instance: lease, url: sourceUrlSchema }),
  'source.cookies.set': z.strictObject({
    instance: lease,
    url: sourceUrlSchema,
    cookie: z.string().max(16384),
  }),
  'source.interaction': z.strictObject({ instance: lease, request: sourceInteractionSchema }),
} as const;
export const sourceHostResultSchemas = {
  'source.settings.read': z.strictObject({ values: jsonRecord }),
  'source.http': sourceHttpResponseSchema,
  'source.storage.get': z.json(),
  'source.storage.set': z.strictObject({ saved: z.literal(true) }),
  'source.storage.delete': z.strictObject({ deleted: z.literal(true) }),
  'source.cookies.get': z.strictObject({ cookie: z.string().max(65536) }),
  'source.cookies.set': z.strictObject({ saved: z.literal(true) }),
  'source.interaction': jsonRecord.nullable(),
} as const;
export type SourceHostCapability = keyof typeof sourceHostPayloadSchemas;
export type Json = z.infer<ReturnType<typeof z.json>>;
