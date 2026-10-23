import { z } from 'zod';
import {
  contentSourceContributionSchema,
  sourceFormatContributionSchema,
  sourcePayloadSchemas,
  sourceResults,
  sourceHostPayloadSchemas,
  type SourceResultMap,
} from './content';
import {
  pluginPermissionsSchema,
  libraryContributionSchema,
  libraryContextSchema,
  remoteBookSchema,
  readingPositionSchema,
  httpRequestSchema,
  libraryResults,
  type LibraryResultMap,
} from './library';

export const PLUGIN_PROTOCOL_VERSION = 2 as const;
export const PLUGIN_API_VERSION = 3 as const;
export const MIN_PLUGIN_API_VERSION = 2 as const;
export const supportsPluginApi = (range: { min: number; max: number }): boolean =>
  range.min <= range.max && range.min <= PLUGIN_API_VERSION && range.max >= MIN_PLUGIN_API_VERSION;
export const MAX_PLUGIN_RESOURCE_BYTES = 4 * 1_024 * 1_024;
export const MAX_PLUGIN_SQL_PARAMS = 9_000;
export const MAX_PLUGIN_SQL_PARAMETER_BYTES = MAX_PLUGIN_RESOURCE_BYTES;
export const MAX_PLUGIN_SQL_REQUEST_BYTES = MAX_PLUGIN_RESOURCE_BYTES * 2;
export const MAX_PLUGIN_ERROR_CODE_LENGTH = 128;
export const MAX_PLUGIN_ERROR_MESSAGE_LENGTH = 4_000;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

const opaqueHandleSchema = z.string().min(1).max(256);

export const dictionaryFormatContributionSchema = z.strictObject({
  id: identifierSchema,
  extensions: z
    .array(z.string().regex(/^[a-z0-9]+$/u))
    .min(1)
    .max(16),
  indexVersion: z.number().int().positive(),
  materialization: z.enum(['sql', 'database']),
});

export const pluginManifestSchema = z
  .strictObject({
    id: identifierSchema,
    protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
    pluginVersion: z.string().min(1).max(64),
    builtAt: z.iso.datetime().optional(),
    name: z.string().min(1).max(128).optional(),
    description: z.string().max(4096).optional(),
    entry: z.literal('worker.js').optional(),
    pluginApi: z
      .strictObject({ min: z.number().int().positive(), max: z.number().int().positive() })
      .optional(),
    permissions: pluginPermissionsSchema.optional(),
    contributions: z.strictObject({
      dictionaryFormats: z.array(dictionaryFormatContributionSchema).max(16).default([]),
      librarySources: z.array(libraryContributionSchema).max(16).optional(),
      contentSources: z.array(contentSourceContributionSchema).max(32).optional(),
      sourceFormats: z.array(sourceFormatContributionSchema).max(32).optional(),
    }),
  })
  .superRefine((manifest, context) => {
    if (manifest.pluginApi && manifest.pluginApi.min > manifest.pluginApi.max)
      context.addIssue({ code: 'custom', message: 'Invalid plugin API range' });
    const providers = manifest.contributions.contentSources ?? [];
    const formats = manifest.contributions.sourceFormats ?? [];
    if ((providers.length || formats.length) && (!manifest.pluginApi || manifest.pluginApi.min < 3))
      context.addIssue({ code: 'custom', message: 'Content sources require plugin API 3' });
    if (
      new Set(providers.map((p) => p.id)).size !== providers.length ||
      new Set(formats.map((f) => f.id)).size !== formats.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate provider or format ID' });
    for (const format of formats)
      if (!providers.some((p) => p.id === format.providerId))
        context.addIssue({
          code: 'custom',
          message: `Unknown source format provider: ${format.providerId}`,
        });
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

const sourceRefSchema = z.strictObject({
  handle: opaqueHandleSchema,
  name: z.string().min(1).max(512),
  size: z.number().int().nonnegative(),
});

const requestEnvelope = {
  kind: z.literal('request'),
  protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(256),
};

const probeRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('probe'),
  payload: z.strictObject({
    sources: z.array(sourceRefSchema).min(1).max(16),
  }),
});

const inspectRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('inspect'),
  payload: z.strictObject({
    sourceHandle: opaqueHandleSchema,
  }),
});

const buildIndexRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('buildIndex'),
  payload: z.strictObject({
    dictionaryId: identifierSchema,
    sourceHandle: opaqueHandleSchema,
    databaseHandle: opaqueHandleSchema,
    sourceFormatVersion: z.number().int().positive(),
  }),
});

const verifyIndexRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('verifyIndex'),
  payload: z.strictObject({
    dictionaryId: identifierSchema,
    databaseHandle: opaqueHandleSchema,
  }),
});

const lookupRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('lookup'),
  payload: z.strictObject({
    dictionaryId: identifierSchema,
    databaseHandle: opaqueHandleSchema,
    query: z.string().min(1).max(512),
    language: z.string().min(2).max(35).optional(),
  }),
});

const readResourceRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('readResource'),
  payload: z.strictObject({
    dictionaryId: identifierSchema,
    sourceHandle: opaqueHandleSchema,
    databaseHandle: opaqueHandleSchema,
    resourceRef: z.string().min(1).max(512),
  }),
});

const pingRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('ping'),
  payload: z.strictObject({}),
});
const library_testConnectionRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('library.testConnection'),
  payload: z.strictObject({ context: libraryContextSchema }),
});
const library_listLibrariesRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('library.listLibraries'),
  payload: z.strictObject({ context: libraryContextSchema }),
});
const library_syncCatalogRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('library.syncCatalog'),
  payload: z.strictObject({
    context: libraryContextSchema,
    libraryIds: z.array(opaqueHandleSchema).max(10000),
    cursor: z.string().max(65536).optional(),
  }),
});
const library_getBookRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('library.getBook'),
  payload: z.strictObject({ context: libraryContextSchema, book: remoteBookSchema }),
});
const library_resolveContentRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('library.resolveContent'),
  payload: z.strictObject({ context: libraryContextSchema, book: remoteBookSchema }),
});
const library_getCoverRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('library.getCover'),
  payload: z.strictObject({ context: libraryContextSchema, book: remoteBookSchema }),
});
const library_pullProgressRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('library.pullProgress'),
  payload: z.strictObject({ context: libraryContextSchema, book: remoteBookSchema }),
});
const library_pushProgressRequestSchema = z.strictObject({
  ...requestEnvelope,
  operation: z.literal('library.pushProgress'),
  payload: z.strictObject({
    context: libraryContextSchema,
    book: remoteBookSchema,
    progress: readingPositionSchema,
  }),
});

export const pluginRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.inspect'),
    payload: sourcePayloadSchemas['source.inspect'],
  }),
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.search'),
    payload: sourcePayloadSchemas['source.search'],
  }),
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.explore'),
    payload: sourcePayloadSchemas['source.explore'],
  }),
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.getWork'),
    payload: sourcePayloadSchemas['source.getWork'],
  }),
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.getChapters'),
    payload: sourcePayloadSchemas['source.getChapters'],
  }),
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.resolveChapter'),
    payload: sourcePayloadSchemas['source.resolveChapter'],
  }),
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.resolveResource'),
    payload: sourcePayloadSchemas['source.resolveResource'],
  }),
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.authenticate'),
    payload: sourcePayloadSchemas['source.authenticate'],
  }),
  z.strictObject({
    ...requestEnvelope,
    operation: z.literal('source.checkUpdates'),
    payload: sourcePayloadSchemas['source.checkUpdates'],
  }),
  pingRequestSchema,
  library_testConnectionRequestSchema,
  library_listLibrariesRequestSchema,
  library_syncCatalogRequestSchema,
  library_getBookRequestSchema,
  library_resolveContentRequestSchema,
  library_getCoverRequestSchema,
  library_pullProgressRequestSchema,
  library_pushProgressRequestSchema,
  probeRequestSchema,
  inspectRequestSchema,
  buildIndexRequestSchema,
  verifyIndexRequestSchema,
  lookupRequestSchema,
  readResourceRequestSchema,
]);

export type PluginRequest = z.infer<typeof pluginRequestSchema>;
export type PluginOperation = PluginRequest['operation'];
export type PluginRequestFor<T extends PluginOperation> = Extract<PluginRequest, { operation: T }>;
export type PluginPayload<T extends PluginOperation> = PluginRequestFor<T>['payload'];

const dictionaryTextNodeSchema = z.strictObject({
  type: z.literal('text'),
  value: z.string().max(100_000),
});

const dictionaryLineBreakNodeSchema = z.strictObject({
  type: z.literal('lineBreak'),
});

const dictionaryElementTagSchema = z.enum([
  'p',
  'span',
  'div',
  'ruby',
  'rt',
  'rp',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'ol',
  'ul',
  'li',
  'details',
  'summary',
]);

const dictionaryStyleSchema = z.strictObject({
  fontStyle: z.enum(['normal', 'italic']).optional(),
  fontWeight: z.enum(['normal', 'bold']).optional(),
  textDecorationLine: z.enum(['none', 'underline', 'line-through']).optional(),
  verticalAlign: z
    .enum(['baseline', 'sub', 'super', 'text-top', 'text-bottom', 'middle'])
    .optional(),
  textAlign: z.enum(['start', 'end', 'left', 'right', 'center']).optional(),
});

const lookupLinkTargetSchema = z.strictObject({
  type: z.literal('lookup'),
  word: z.string().min(1).max(512),
});

const externalLinkTargetSchema = z
  .strictObject({
    type: z.literal('external'),
    url: z.url(),
  })
  .refine(({ url }) => {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  }, 'Only HTTP(S) dictionary links are allowed');

const dictionaryImageNodeSchema = z.strictObject({
  type: z.literal('image'),
  resourceRef: z.string().min(1).max(512),
  alt: z.string().max(2_000).optional(),
  title: z.string().max(2_000).optional(),
  width: z.number().positive().max(8_192).optional(),
  height: z.number().positive().max(8_192).optional(),
  sizeUnits: z.enum(['px', 'em']).optional(),
  imageRendering: z.enum(['auto', 'pixelated', 'crisp-edges']).optional(),
  appearance: z.enum(['auto', 'monochrome']).optional(),
});

const dictionaryLinkNodeSchema = z.strictObject({
  type: z.literal('link'),
  label: z.string().min(1).max(4_000),
  target: z.discriminatedUnion('type', [lookupLinkTargetSchema, externalLinkTargetSchema]),
});

interface DictionaryElementNode {
  type: 'element';
  tag: z.infer<typeof dictionaryElementTagSchema>;
  children: DictionaryContentNode[];
  title?: string;
  open?: boolean;
  lang?: string;
  colSpan?: number;
  rowSpan?: number;
  style?: z.infer<typeof dictionaryStyleSchema>;
}

export type DictionaryContentNode =
  | z.infer<typeof dictionaryTextNodeSchema>
  | z.infer<typeof dictionaryLineBreakNodeSchema>
  | z.infer<typeof dictionaryImageNodeSchema>
  | z.infer<typeof dictionaryLinkNodeSchema>
  | DictionaryElementNode;

export const dictionaryContentNodeSchema: z.ZodType<DictionaryContentNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    dictionaryTextNodeSchema,
    dictionaryLineBreakNodeSchema,
    dictionaryImageNodeSchema,
    dictionaryLinkNodeSchema,
    z.strictObject({
      type: z.literal('element'),
      tag: dictionaryElementTagSchema,
      children: z.array(dictionaryContentNodeSchema).max(2_000),
      title: z.string().max(2_000).optional(),
      open: z.boolean().optional(),
      lang: z.string().min(2).max(35).optional(),
      colSpan: z.number().int().min(1).max(100).optional(),
      rowSpan: z.number().int().min(1).max(100).optional(),
      style: dictionaryStyleSchema.optional(),
    }),
  ]),
);

export const dictionaryTagSchema = z.strictObject({
  name: z.string().min(1).max(256),
  category: z.string().max(256).optional(),
  notes: z.string().max(4_000).optional(),
  score: z.number().optional(),
});

export const dictionaryFrequencySchema = z.strictObject({
  value: z.union([z.number(), z.string().max(512)]),
  displayValue: z.string().max(512).optional(),
});

export const dictionaryPitchSchema = z.strictObject({
  position: z.union([z.number().int().nonnegative(), z.string().regex(/^[HL]+$/u)]),
  nasal: z
    .union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])
    .optional(),
  devoice: z
    .union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])
    .optional(),
  tags: z.array(z.string().max(256)).max(64).optional(),
});

export const dictionaryIpaSchema = z.strictObject({
  value: z.string().min(1).max(2_000),
  tags: z.array(z.string().max(256)).max(64).optional(),
});

export const dictionaryLookupEntrySchema = z.strictObject({
  expression: z.string().min(1).max(512),
  reading: z.string().max(512),
  rules: z.array(z.string().max(128)).max(64).optional(),
  score: z.number().optional(),
  deinflection: z.array(z.string().max(256)).max(32).optional(),
  tags: z.array(dictionaryTagSchema).max(128).optional(),
  frequencies: z.array(dictionaryFrequencySchema).max(128).optional(),
  pitches: z.array(dictionaryPitchSchema).max(128).optional(),
  ipa: z.array(dictionaryIpaSchema).max(128).optional(),
  definitions: z.array(dictionaryContentNodeSchema).max(2_000),
});

export const dictionaryLookupResultSchema = z.strictObject({
  entries: z.array(dictionaryLookupEntrySchema).max(128),
});

export type DictionaryLookupResult = z.infer<typeof dictionaryLookupResultSchema>;
export type DictionaryLookupEntry = z.infer<typeof dictionaryLookupEntrySchema>;

export const MAX_DICTIONARY_DOCUMENT_DEPTH = 16;
export const MAX_DICTIONARY_DOCUMENT_NODES = 1_024;

const assertDocumentLimits = (result: DictionaryLookupResult): void => {
  let nodes = 0;
  const visit = (node: DictionaryContentNode, depth: number): void => {
    if (depth > MAX_DICTIONARY_DOCUMENT_DEPTH) {
      throw new Error(`Dictionary document exceeds maximum depth ${MAX_DICTIONARY_DOCUMENT_DEPTH}`);
    }
    nodes += 1;
    if (nodes > MAX_DICTIONARY_DOCUMENT_NODES) {
      throw new Error(`Dictionary document exceeds maximum nodes ${MAX_DICTIONARY_DOCUMENT_NODES}`);
    }
    if (node.type === 'element') {
      for (const child of node.children) visit(child, depth + 1);
    }
  };

  for (const entry of result.entries) {
    for (const definition of entry.definitions) visit(definition, 1);
  }
};

export const parseDictionaryLookupResult = (value: unknown): DictionaryLookupResult => {
  const result = dictionaryLookupResultSchema.parse(value);
  assertDocumentLimits(result);
  return result;
};

const probeResultSchema = z.strictObject({
  matches: z
    .array(
      z.strictObject({
        sourceHandle: opaqueHandleSchema,
        formatId: identifierSchema,
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(16),
});

const inspectResultSchema = z.strictObject({
  formatId: identifierSchema,
  sourceFormatVersion: z.number().int().positive(),
  title: z.string().min(1).max(1_024),
  revision: z.string().max(1_024).optional(),
  language: z.string().min(2).max(35).optional(),
  sequenced: z.boolean().optional(),
});

const buildIndexResultSchema = z.strictObject({
  indexVersion: z.number().int().positive(),
  entries: z.number().int().nonnegative(),
  resources: z.number().int().nonnegative(),
});

const verifyIndexResultSchema = z.strictObject({
  indexVersion: z.number().int().positive(),
  entries: z.number().int().nonnegative(),
  title: z.string().min(1).max(1_024).optional(),
});

const resourceBytesSchema = z
  .instanceof(Uint8Array)
  .refine(
    (bytes) => bytes.byteLength <= MAX_PLUGIN_RESOURCE_BYTES,
    'Dictionary resource exceeds the protocol byte limit',
  );

const resourceMimeTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu);

const readResourceResultSchema = z.strictObject({
  mimeType: resourceMimeTypeSchema,
  bytes: resourceBytesSchema,
});

export interface PluginResultByOperation extends LibraryResultMap, SourceResultMap {
  probe: z.infer<typeof probeResultSchema>;
  inspect: z.infer<typeof inspectResultSchema>;
  buildIndex: z.infer<typeof buildIndexResultSchema>;
  verifyIndex: z.infer<typeof verifyIndexResultSchema>;
  lookup: DictionaryLookupResult;
  readResource: z.infer<typeof readResourceResultSchema>;
}

export type PluginResult<T extends PluginOperation> = PluginResultByOperation[T];

export const parsePluginOperationResult = <T extends PluginOperation>(
  operation: T,
  value: unknown,
): PluginResult<T> => {
  let result: PluginResultByOperation[PluginOperation];
  switch (operation) {
    case 'source.inspect':
      result = sourceResults['source.inspect'].parse(value);
      break;
    case 'source.search':
      result = sourceResults['source.search'].parse(value);
      break;
    case 'source.explore':
      result = sourceResults['source.explore'].parse(value);
      break;
    case 'source.getWork':
      result = sourceResults['source.getWork'].parse(value);
      break;
    case 'source.getChapters':
      result = sourceResults['source.getChapters'].parse(value);
      break;
    case 'source.resolveChapter':
      result = sourceResults['source.resolveChapter'].parse(value);
      break;
    case 'source.resolveResource':
      result = sourceResults['source.resolveResource'].parse(value);
      break;
    case 'source.authenticate':
      result = sourceResults['source.authenticate'].parse(value);
      break;
    case 'source.checkUpdates':
      result = sourceResults['source.checkUpdates'].parse(value);
      break;
    case 'ping':
      result = libraryResults['ping'].parse(value);
      break;
    case 'library.testConnection':
      result = libraryResults['library.testConnection'].parse(value);
      break;
    case 'library.listLibraries':
      result = libraryResults['library.listLibraries'].parse(value);
      break;
    case 'library.syncCatalog':
      result = libraryResults['library.syncCatalog'].parse(value);
      break;
    case 'library.getBook':
      result = libraryResults['library.getBook'].parse(value);
      break;
    case 'library.resolveContent':
      result = libraryResults['library.resolveContent'].parse(value);
      break;
    case 'library.getCover':
      result = libraryResults['library.getCover'].parse(value);
      break;
    case 'library.pullProgress':
      result = libraryResults['library.pullProgress'].parse(value);
      break;
    case 'library.pushProgress':
      result = libraryResults['library.pushProgress'].parse(value);
      break;
    case 'probe':
      result = probeResultSchema.parse(value);
      break;
    case 'inspect':
      result = inspectResultSchema.parse(value);
      break;
    case 'buildIndex':
      result = buildIndexResultSchema.parse(value);
      break;
    case 'verifyIndex':
      result = verifyIndexResultSchema.parse(value);
      break;
    case 'lookup':
      result = parseDictionaryLookupResult(value);
      break;
    case 'readResource':
      result = readResourceResultSchema.parse(value);
      break;
    default:
      throw new Error(`Unknown plugin operation: ${String(operation)}`);
  }
  return result as PluginResult<T>;
};

export const normalizePluginErrorPayload = (
  code: unknown,
  message: unknown,
): { code: string; message: string } => ({
  code:
    (typeof code === 'string' ? code : String(code)).slice(0, MAX_PLUGIN_ERROR_CODE_LENGTH) ||
    'UNKNOWN_ERROR',
  message:
    (typeof message === 'string' ? message : String(message)).slice(
      0,
      MAX_PLUGIN_ERROR_MESSAGE_LENGTH,
    ) || 'Plugin operation failed',
});

const errorPayloadSchema = z.strictObject({
  code: z.string().min(1).max(MAX_PLUGIN_ERROR_CODE_LENGTH),
  message: z.string().min(1).max(MAX_PLUGIN_ERROR_MESSAGE_LENGTH),
});

const responseEnvelope = {
  kind: z.literal('response'),
  protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(256),
};

const pluginSuccessResponseSchema = z.strictObject({
  ...responseEnvelope,
  ok: z.literal(true),
  result: z.unknown(),
});

const pluginErrorResponseSchema = z.strictObject({
  ...responseEnvelope,
  ok: z.literal(false),
  error: errorPayloadSchema,
});

export const pluginResponseSchema = z.discriminatedUnion('ok', [
  pluginSuccessResponseSchema,
  pluginErrorResponseSchema,
]);

const cancelRequestSchema = z.strictObject({
  kind: z.literal('cancel'),
  protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(256),
});

const sqlValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.bigint(),
  z.boolean(),
  z.null(),
  z.instanceof(Uint8Array),
]);

export type PluginSqlValue = z.infer<typeof sqlValueSchema>;

export const pluginSqlValueBytes = (value: unknown): number => {
  if (value === null) return 0;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (typeof value === 'number') return 8;
  if (typeof value === 'bigint') {
    const bits = value === 0n ? 1 : value.toString(2).replace('-', '').length;
    return Math.ceil(bits / 8);
  }
  if (typeof value === 'boolean') return 1;
  if (value instanceof Uint8Array) return value.byteLength;
  throw new TypeError('Unsupported SQL parameter type');
};

const boundedSqlValueSchema = sqlValueSchema.superRefine((value, context) => {
  if (pluginSqlValueBytes(value) > MAX_PLUGIN_SQL_PARAMETER_BYTES) {
    context.addIssue({ code: 'custom', message: 'SQL parameter cell size limit exceeded' });
  }
});

const sqlParamsSchema = z
  .array(boundedSqlValueSchema)
  .max(MAX_PLUGIN_SQL_PARAMS)
  .superRefine((params, context) => {
    if (
      params.reduce<number>((total, value) => total + pluginSqlValueBytes(value), 0) >
      MAX_PLUGIN_SQL_REQUEST_BYTES
    ) {
      context.addIssue({ code: 'custom', message: 'SQL parameter payload size limit exceeded' });
    }
  })
  .optional();

const hostCallEnvelope = {
  kind: z.literal('host-call'),
  protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(256),
  callId: z.string().min(1).max(256),
};

const sourceStatCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('source.stat'),
  payload: z.strictObject({ handle: opaqueHandleSchema }),
});

const sourceReadRangeCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('source.readRange'),
  payload: z.strictObject({
    handle: opaqueHandleSchema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
  }),
});

const sqlExecuteCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('sql.execute'),
  payload: z.strictObject({
    handle: opaqueHandleSchema,
    sql: z.string().min(1).max(65_536),
    params: sqlParamsSchema,
  }),
});

const sqlSelectCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('sql.select'),
  payload: z.strictObject({
    handle: opaqueHandleSchema,
    sql: z.string().min(1).max(65_536),
    params: sqlParamsSchema,
    maxRows: z.number().int().min(1).max(1_000),
  }),
});

const transactionStatementSchema = z.strictObject({
  sql: z.string().min(1).max(65_536),
  params: sqlParamsSchema,
});

const transactionStatementsSchema = z
  .array(transactionStatementSchema)
  .min(1)
  .max(64)
  .superRefine((statements, context) => {
    const totalBytes = statements.reduce<number>(
      (total, statement) =>
        total +
        (statement.params ?? []).reduce<number>(
          (statementTotal, value) => statementTotal + pluginSqlValueBytes(value),
          0,
        ),
      0,
    );
    if (totalBytes > MAX_PLUGIN_SQL_REQUEST_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'SQL transaction parameter size limit exceeded',
      });
    }
  });

const sqlTransactionCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('sql.transaction'),
  payload: z.strictObject({
    handle: opaqueHandleSchema,
    statements: transactionStatementsSchema,
  }),
});

const httpRequestCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('http.request'),
  payload: httpRequestSchema,
});
const storageGetCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('storage.get'),
  payload: z.strictObject({ key: z.string().min(1).max(256) }),
});
const storageSetCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('storage.set'),
  payload: z.strictObject({ key: z.string().min(1).max(256), value: z.json() }),
});
const storageDeleteCallSchema = z.strictObject({
  ...hostCallEnvelope,
  capability: z.literal('storage.delete'),
  payload: z.strictObject({ key: z.string().min(1).max(256) }),
});

export const pluginHostCallSchema = z.discriminatedUnion('capability', [
  z.strictObject({
    ...hostCallEnvelope,
    capability: z.literal('source.http'),
    payload: sourceHostPayloadSchemas['source.http'],
  }),
  z.strictObject({
    ...hostCallEnvelope,
    capability: z.literal('source.storage.get'),
    payload: sourceHostPayloadSchemas['source.storage.get'],
  }),
  z.strictObject({
    ...hostCallEnvelope,
    capability: z.literal('source.storage.set'),
    payload: sourceHostPayloadSchemas['source.storage.set'],
  }),
  z.strictObject({
    ...hostCallEnvelope,
    capability: z.literal('source.storage.delete'),
    payload: sourceHostPayloadSchemas['source.storage.delete'],
  }),
  z.strictObject({
    ...hostCallEnvelope,
    capability: z.literal('source.cookies.get'),
    payload: sourceHostPayloadSchemas['source.cookies.get'],
  }),
  z.strictObject({
    ...hostCallEnvelope,
    capability: z.literal('source.cookies.set'),
    payload: sourceHostPayloadSchemas['source.cookies.set'],
  }),
  z.strictObject({
    ...hostCallEnvelope,
    capability: z.literal('source.interaction'),
    payload: sourceHostPayloadSchemas['source.interaction'],
  }),
  httpRequestCallSchema,
  storageGetCallSchema,
  storageSetCallSchema,
  storageDeleteCallSchema,
  sourceStatCallSchema,
  sourceReadRangeCallSchema,
  sqlExecuteCallSchema,
  sqlSelectCallSchema,
  sqlTransactionCallSchema,
]);

export type PluginHostCall = z.infer<typeof pluginHostCallSchema>;

const progressMessageSchema = z.strictObject({
  kind: z.literal('progress'),
  protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(256),
  stage: z.string().min(1).max(128),
  completed: z.number().nonnegative(),
  total: z.number().nonnegative().optional(),
});

const hostResultEnvelope = {
  kind: z.literal('host-result'),
  protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(256),
  callId: z.string().min(1).max(256),
};

const hostSuccessResultSchema = z.strictObject({
  ...hostResultEnvelope,
  ok: z.literal(true),
  result: z.unknown(),
});

const hostErrorResultSchema = z.strictObject({
  ...hostResultEnvelope,
  ok: z.literal(false),
  error: errorPayloadSchema,
});

export const pluginHostResultSchema = z.discriminatedUnion('ok', [
  hostSuccessResultSchema,
  hostErrorResultSchema,
]);

export const pluginWorkerInboundMessageSchema = z.union([
  pluginRequestSchema,
  cancelRequestSchema,
  pluginHostResultSchema,
]);

export const pluginWorkerOutboundMessageSchema = z.union([
  pluginResponseSchema,
  pluginHostCallSchema,
  progressMessageSchema,
]);

export type PluginResponse = z.infer<typeof pluginResponseSchema>;
export type PluginProgress = z.infer<typeof progressMessageSchema>;
export type PluginHostResult = z.infer<typeof pluginHostResultSchema>;
export type PluginWorkerInboundMessage = z.infer<typeof pluginWorkerInboundMessageSchema>;
export type PluginWorkerOutboundMessage = z.infer<typeof pluginWorkerOutboundMessageSchema>;
