import { z } from 'zod';
import { pluginManifestSchema } from './contract';
import {
  sourceHostResultSchemas,
  type Json,
  type SourceContext,
  type SourceHostCapability,
  type SourceHttpRequest,
  type SourcePayload,
  type SourceOperation,
  type SourceResultMap,
  sourceHostPayloadSchemas,
} from './content';
import {
  PluginError,
  startPluginWorkerServer,
  type PluginWorkerGlobalLike,
  type PluginWorkerOperationContext,
  type PluginOperationHandlers,
} from './worker';

/** A request-scoped host facade. The opaque instance lease cannot be overridden by the plugin. */
export function createContentHost(source: SourceContext, worker: PluginWorkerOperationContext) {
  const instance = source.instance;
  const call = async <K extends SourceHostCapability>(
    capability: K,
    payload: Omit<z.infer<(typeof sourceHostPayloadSchemas)[K]>, 'instance'>,
  ): Promise<z.infer<(typeof sourceHostResultSchemas)[K]>> => {
    const bound = sourceHostPayloadSchemas[capability].parse({
      ...payload,
      instance,
    });
    // The capability and payload correlation was checked by the corresponding public schema above.
    const result = await worker.call<SourceHostCapability>(capability, bound);
    return sourceHostResultSchemas[capability].parse(result) as z.infer<
      (typeof sourceHostResultSchemas)[K]
    >;
  };
  return {
    source,
    signal: worker.signal,
    progress: worker.progress.bind(worker),
    http: (request: Omit<SourceHttpRequest, 'instance'>) => call('source.http', request),
    storage: {
      get: (key: string) => call('source.storage.get', { key }),
      set: (key: string, value: Json) => call('source.storage.set', { key, value }),
      delete: (key: string) => call('source.storage.delete', { key }),
    },
    cookies: {
      get: (url: string) => call('source.cookies.get', { url }),
      set: (url: string, cookie: string) => call('source.cookies.set', { url, cookie }),
    },
    interaction: (
      request: z.infer<(typeof sourceHostPayloadSchemas)['source.interaction']>['request'],
    ) => call('source.interaction', { request }),
  };
}
export type ContentHost = ReturnType<typeof createContentHost>;
type ContentMethods = {
  [K in SourceOperation as K extends `source.${infer Name}` ? Name : never]: (
    input: Omit<SourcePayload<K>, 'context'>,
    host: ContentHost,
  ) => Promise<SourceResultMap[K]>;
};
export type ContentProvider = { id: string } & Pick<
  ContentMethods,
  'getWork' | 'getChapters' | 'resolveChapter' | 'resolveResource'
> &
  Partial<Omit<ContentMethods, 'getWork' | 'getChapters' | 'resolveChapter' | 'resolveResource'>>;
export const defineContentProvider = (provider: ContentProvider): ContentProvider => provider;

export interface PluginDefinition {
  manifest: z.input<typeof pluginManifestSchema>;
  contentProviders?: ContentProvider[];
  /** Legacy dictionary/library handlers can coexist with content providers. */
  handlers?: PluginOperationHandlers;
}

export function definePlugin(definition: PluginDefinition) {
  const manifest = pluginManifestSchema.parse(definition.manifest);
  const providers = new Map<string, ContentProvider>();
  for (const provider of definition.contentProviders ?? []) {
    if (providers.has(provider.id)) throw new Error(`Duplicate content provider: ${provider.id}`);
    const contribution = manifest.contributions.contentSources?.find(
      (item) => item.id === provider.id,
    );
    if (!contribution) throw new Error(`Undeclared content provider: ${provider.id}`);
    for (const method of ['getWork', 'getChapters', 'resolveChapter', 'resolveResource'] as const)
      if (typeof provider[method] !== 'function')
        throw new Error(`Missing ${provider.id}.${method}`);
    for (const method of ['search', 'explore', 'authenticate', 'checkUpdates'] as const)
      if (contribution.capabilities[method] && typeof provider[method] !== 'function')
        throw new Error(`Missing declared capability ${provider.id}.${method}`);
    providers.set(provider.id, provider);
  }
  for (const contribution of manifest.contributions.contentSources ?? [])
    if (!providers.has(contribution.id))
      throw new Error(`Missing content provider: ${contribution.id}`);
  for (const format of manifest.contributions.sourceFormats ?? [])
    if (!providers.get(format.providerId)?.inspect)
      throw new Error(`Missing importer: ${format.id}`);

  const providerFor = (source: SourceContext): ContentProvider => {
    const provider = providers.get(source.providerId);
    if (!provider)
      throw new PluginError(`Unknown provider: ${source.providerId}`, 'PROVIDER_UNAVAILABLE');
    return provider;
  };
  const unavailable = (method: string): never => {
    throw new PluginError(
      `Plugin operation is unavailable: source.${method}`,
      'OPERATION_UNAVAILABLE',
    );
  };
  const handlers: PluginOperationHandlers = {
    ...definition.handlers,
    'source.inspect': async ({ context, ...input }, worker) =>
      providerFor(context).inspect?.(input, createContentHost(context, worker)) ??
      unavailable('inspect'),
    'source.search': async ({ context, ...input }, worker) =>
      providerFor(context).search?.(input, createContentHost(context, worker)) ??
      unavailable('search'),
    'source.explore': async ({ context, ...input }, worker) =>
      providerFor(context).explore?.(input, createContentHost(context, worker)) ??
      unavailable('explore'),
    'source.getWork': async ({ context, ...input }, worker) =>
      providerFor(context).getWork(input, createContentHost(context, worker)),
    'source.getChapters': async ({ context, ...input }, worker) =>
      providerFor(context).getChapters(input, createContentHost(context, worker)),
    'source.resolveChapter': async ({ context, ...input }, worker) =>
      providerFor(context).resolveChapter(input, createContentHost(context, worker)),
    'source.resolveResource': async ({ context, ...input }, worker) =>
      providerFor(context).resolveResource(input, createContentHost(context, worker)),
    'source.authenticate': async ({ context, ...input }, worker) =>
      providerFor(context).authenticate?.(input, createContentHost(context, worker)) ??
      unavailable('authenticate'),
    'source.checkUpdates': async ({ context, ...input }, worker) =>
      providerFor(context).checkUpdates?.(input, createContentHost(context, worker)) ??
      unavailable('checkUpdates'),
  };
  return {
    manifest,
    handlers,
    start: (scope: PluginWorkerGlobalLike = globalThis as unknown as PluginWorkerGlobalLike) =>
      startPluginWorkerServer(scope, handlers),
  };
}
