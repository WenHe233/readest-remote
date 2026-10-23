import { z } from 'zod';

export const pluginPermissionsSchema = z.strictObject({
  network: z.boolean().optional(),
  secrets: z.boolean().optional(),
  storage: z.boolean().optional(),
  cookies: z.boolean().optional(),
  interaction: z.boolean().optional(),
  wasm: z.boolean().optional(),
});
export type PluginPermissions = z.infer<typeof pluginPermissionsSchema>;
export const settingFieldSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/u),
  label: z.string().min(1).max(128),
  type: z.enum(['text', 'secret', 'boolean']),
  required: z.boolean().optional(),
});
export const libraryContributionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/u),
  name: z.string().min(1).max(128),
  formats: z
    .array(z.enum(['EPUB', 'CBZ', 'PDF']))
    .min(1)
    .max(3),
  settings: z.array(settingFieldSchema).max(16),
});
const handle = z.string().min(1).max(256);
export const libraryContextSchema = z.strictObject({
  sourceId: handle,
  connection: handle,
  config: z.record(z.string(), z.union([z.string().max(4096), z.boolean(), z.number()])),
  secrets: z.record(z.string(), handle),
});
export type LibraryContext = z.infer<typeof libraryContextSchema>;
export const resourceDescriptorSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  query: z
    .record(z.string().max(128), z.union([z.string().max(4096), z.number(), z.boolean()]))
    .optional(),
  headers: z.record(z.string().max(128), z.string().max(4096)).optional(),
  auth: z
    .array(
      z.strictObject({
        secret: handle,
        in: z.enum(['header', 'query']),
        name: z.string().min(1).max(128),
      }),
    )
    .max(4)
    .optional(),
});
export type ResourceDescriptor = z.infer<typeof resourceDescriptorSchema>;
export const httpRequestSchema = resourceDescriptorSchema.extend({
  connection: handle,
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  json: z.json().optional(),
});
export type HttpRequest = z.infer<typeof httpRequestSchema>;
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}
export const remoteLibrarySchema = z.strictObject({ id: handle, name: z.string().min(1).max(512) });
export type RemoteLibrary = z.infer<typeof remoteLibrarySchema>;
export const remoteBookSchema = z.strictObject({
  id: handle,
  libraryId: handle,
  title: z.string().min(1).max(2048),
  author: z.string().max(2048),
  format: z.enum(['EPUB', 'CBZ', 'PDF']),
  revision: z.string().min(1).max(512),
  size: z.number().int().nonnegative().optional(),
  pageCount: z.number().int().positive().optional(),
  language: z.string().max(64).optional(),
  description: z.string().max(65536).optional(),
  tags: z.array(z.string().max(256)).max(256).optional(),
  series: z.string().max(1024).optional(),
  data: z.record(z.string(), z.json()).optional(),
});
export type RemoteBook = z.infer<typeof remoteBookSchema>;
export const contentDescriptorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('remote-file'),
    resource: resourceDescriptorSchema,
    size: z.number().int().positive(),
    download: resourceDescriptorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('epub-resources'),
    resource: resourceDescriptorSchema,
    inlineResources: z
      .record(z.string().max(4096), z.string().max(1048576))
      .refine((files) => Object.keys(files).length <= 8)
      .optional(),
    download: resourceDescriptorSchema,
  }),
  z.strictObject({
    kind: z.literal('pages'),
    resource: resourceDescriptorSchema,
    pageCount: z.number().int().positive().max(100000),
    firstPage: z.number().int().min(0).max(1),
    download: resourceDescriptorSchema,
  }),
]);
export type ContentDescriptor = z.infer<typeof contentDescriptorSchema>;
export const readingPositionSchema = z.strictObject({
  kind: z.enum(['epub', 'page']),
  fraction: z.number().min(0).max(1),
  modified: z.number().nonnegative(),
  cfi: z.string().max(8192).optional(),
  href: z.string().max(4096).optional(),
  spineIndex: z.number().int().nonnegative().optional(),
  xpath: z.string().max(8192).optional(),
  fragment: z.string().max(8192).optional(),
  sectionProgress: z.number().min(0).max(1).optional(),
  pageIndex: z.number().int().nonnegative().optional(),
  approximate: z.boolean().optional(),
});
export type ReadingPosition = z.infer<typeof readingPositionSchema>;
export const libraryResults = {
  ping: z.strictObject({ ready: z.literal(true) }),
  'library.testConnection': z.strictObject({
    name: z.string().max(512),
    version: z.string().max(128).optional(),
  }),
  'library.listLibraries': z.array(remoteLibrarySchema).max(10000),
  'library.syncCatalog': z.strictObject({
    books: z.array(remoteBookSchema).max(1000),
    nextCursor: z.string().max(65536).optional(),
    complete: z.boolean(),
  }),
  'library.getBook': remoteBookSchema,
  'library.resolveContent': contentDescriptorSchema,
  'library.getCover': resourceDescriptorSchema.nullable(),
  'library.pullProgress': readingPositionSchema.nullable(),
  'library.pushProgress': z.strictObject({ saved: z.literal(true) }),
};
export type LibraryResultMap = {
  [K in keyof typeof libraryResults]: z.infer<(typeof libraryResults)[K]>;
};
