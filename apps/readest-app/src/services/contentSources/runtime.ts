import { create } from 'zustand';
import type {
  PluginPayload,
  PluginResult,
  SourceOperation,
  SourceDefinition,
} from '@readest/plugin-sdk';
import { createPluginRuntime, PluginRuntimeError } from '../plugins/runtime';
import { createSandboxedPluginWorker } from '../plugins/sandbox';
import {
  findInstalledPlugin,
  getInstalledPluginPackage,
  loadPluginManager,
  useInstalledPlugins,
} from '../plugins/manager';
import { createSourceLease } from './network';
import { onPluginStopped, pluginLifecycleEpoch, isPluginDataResetting } from '../plugins/lifecycle';
import {
  getSourceInstance,
  loadSourceInstances,
  readSourceDefinition,
  useSourceInstances,
  type SourceInstance,
} from './instances';

export const useSourceDiagnostics = create<{
  entries: Array<{
    instanceId: string;
    operation: string;
    startedAt: number;
    duration: number;
    code?: string;
  }>;
}>(() => ({ entries: [] }));
function record(instanceId: string, operation: string, startedAt: number, code?: string) {
  useSourceDiagnostics.setState((state) => ({
    entries: [
      { instanceId, operation, startedAt, duration: Date.now() - startedAt, code },
      ...state.entries,
    ].slice(0, 100),
  }));
}
const active = new Map<string, Awaited<ReturnType<typeof buildRuntime>>>();
const creating = new Map<string, Promise<Awaited<ReturnType<typeof buildRuntime>>>>();
const allocations = new Map<symbol, { pluginId: string; stop(): void }>();
const unsupported = (message: string) =>
  new PluginRuntimeError(message, 'SOURCE_UNSUPPORTED_CAPABILITY');

async function buildRuntime(
  instance: SourceInstance,
  definition?: SourceDefinition,
  inspectOnly = false,
) {
  if (isPluginDataResetting(instance.pluginId)) throw new Error('Plugin data is being cleared.');
  if (allocations.size >= 4) {
    const idle = [...active.entries()].find(([, target]) => !target.busy());
    if (!idle)
      throw new PluginRuntimeError(
        'Four source workers are already running. Try again when a task completes.',
        'SOURCE_BUSY',
      );
    idle[1].close();
    active.delete(idle[0]);
  }
  const epoch = pluginLifecycleEpoch(instance.pluginId);
  const allocation = Symbol(instance.id);
  let cancelled = false;
  let dispose = () => {};
  const stop = () => {
    cancelled = true;
    dispose();
    allocations.delete(allocation);
  };
  allocations.set(allocation, { pluginId: instance.pluginId, stop });
  try {
    const pkg = await getInstalledPluginPackage(instance.pluginId);
    const installed = findInstalledPlugin(instance.pluginId);
    if (cancelled || epoch !== pluginLifecycleEpoch(instance.pluginId))
      throw new Error('Source was stopped while starting.');
    if (!installed?.enabled || installed.fingerprint !== instance.fingerprint)
      throw new Error('Source signer does not match the installed plugin.');
    const provider = pkg.manifest.contributions.contentSources?.find(
      (item) => item.id === instance.providerId,
    );
    if (!provider) throw unsupported('The plugin does not provide this content capability.');
    const allowed = () =>
      !cancelled &&
      !isPluginDataResetting(instance.pluginId) &&
      epoch === pluginLifecycleEpoch(instance.pluginId) &&
      findInstalledPlugin(instance.pluginId) === installed &&
      installed.enabled &&
      (inspectOnly ||
        (getSourceInstance(instance.id)?.updatedAt === instance.updatedAt &&
          !!getSourceInstance(instance.id)?.enabled));
    const lease = createSourceLease(
      instance,
      installed.permissions,
      allowed,
      definition,
      undefined,
      inspectOnly,
    );
    const runtime = createPluginRuntime({
      createWorker: () =>
        createSandboxedPluginWorker(pkg.workerSource, pkg.resources, installed.permissions),
      handleHostCall: lease.handleHostCall,
    });
    let tail: Promise<unknown> = Promise.resolve();
    let pending = 0;
    let closed = false;
    const call = <T extends SourceOperation>(
      operation: T,
      payload: Omit<PluginPayload<T>, 'context'>,
      signal?: AbortSignal,
    ): Promise<PluginResult<T>> => {
      const optional = {
        'source.search': 'search',
        'source.explore': 'explore',
        'source.authenticate': 'authenticate',
        'source.checkUpdates': 'checkUpdates',
      } as const;
      const capability = optional[operation as keyof typeof optional];
      if (capability && !provider.capabilities[capability])
        return Promise.reject(unsupported(`This source does not support ${capability}.`));
      if (closed) return Promise.reject(new Error('Source runtime was closed.'));
      pending++;
      const operationTask = tail
        .catch(() => {})
        .then(async () => {
          signal?.throwIfAborted();
          if (!allowed() || closed) throw new Error('Source permission was revoked.');
          const startedAt = Date.now();
          const controller = new AbortController();
          const cancel = () => controller.abort();
          signal?.addEventListener('abort', cancel, { once: true });
          const timeout = setTimeout(cancel, 60000);
          try {
            const result = await runtime.call(
              operation,
              { ...payload, context: lease.context } as PluginPayload<T>,
              { signal: controller.signal },
            );
            record(instance.id, operation, startedAt);
            return result;
          } catch (error) {
            record(
              instance.id,
              operation,
              startedAt,
              error instanceof PluginRuntimeError ? error.code : 'SOURCE_OPERATION_FAILED',
            );
            // Terminate even a native plugin stuck in a CPU loop; cancellation cannot rely on its event loop.
            if (controller.signal.aborted) {
              stop();
              active.delete(instance.id);
            }
            throw error;
          } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', cancel);
          }
        })
        .finally(() => {
          pending--;
        });
      tail = operationTask;
      return operationTask;
    };
    dispose = () => {
      closed = true;
      lease.close();
      runtime.close();
    };
    return {
      instance,
      provider,
      installed,
      pluginHash: installed.activeHash,
      call,
      lease,
      busy: () => pending > 0 || lease.busy(),
      available: () => allowed() && !closed,
      close: stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

export async function getSourceRuntime(id: string) {
  await Promise.all([loadPluginManager(), loadSourceInstances()]);
  const instance = getSourceInstance(id);
  if (!instance?.enabled) throw new Error('Enable this source before loading online content.');
  const installed = findInstalledPlugin(instance.pluginId);
  const previous = active.get(id);
  if (
    previous &&
    previous.available() &&
    previous.instance.updatedAt === instance.updatedAt &&
    installed?.enabled &&
    previous.pluginHash === installed.activeHash
  )
    return previous;
  previous?.close();
  active.delete(id);
  const inFlight = creating.get(id);
  if (inFlight) return inFlight;
  const operation = (async () => {
    const target = await buildRuntime(instance, await readSourceDefinition(instance.definitionId));
    if (!target.available() || getSourceInstance(id)?.updatedAt !== instance.updatedAt) {
      target.close();
      throw new Error('Source changed while starting.');
    }
    active.set(id, target);
    return target;
  })().finally(() => creating.delete(id));
  creating.set(id, operation);
  return operation;
}

export async function inspectSourceFile(
  pluginId: string,
  providerId: string,
  format: string,
  content: string,
  filename?: string,
  signal?: AbortSignal,
  baseUrl?: string,
) {
  await loadPluginManager();
  const installed = findInstalledPlugin(pluginId);
  if (!installed) throw new Error('Install the source adapter first.');
  if (
    !installed.manifest.contributions.sourceFormats?.some(
      (item) => item.id === format && item.providerId === providerId,
    )
  )
    throw unsupported('This plugin does not import the selected format.');
  const instance: SourceInstance = {
    id: crypto.randomUUID(),
    pluginId,
    providerId,
    fingerprint: installed.fingerprint,
    name: 'Import inspection',
    config: {},
    enabled: true,
    origins: [],
    allowPrivateNetwork: false,
    secretNames: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const target = await buildRuntime(instance, undefined, true);
  try {
    return await target.call('source.inspect', { content, format, filename, baseUrl }, signal);
  } finally {
    target.close();
  }
}

useSourceInstances.subscribe(({ instances }) => {
  for (const [id, runtime] of active) {
    const instance = instances.find((item) => item.id === id);
    if (!instance?.enabled || instance.updatedAt !== runtime.instance.updatedAt) {
      runtime.close();
      active.delete(id);
    }
  }
});
useInstalledPlugins.subscribe(({ plugins }) => {
  for (const [id, runtime] of active) {
    const plugin = plugins.find((item) => item.id === runtime.instance.pluginId);
    if (!plugin?.enabled || plugin !== runtime.installed) {
      runtime.close();
      active.delete(id);
    }
  }
});

onPluginStopped((pluginId) => {
  for (const allocation of [...allocations.values()])
    if (allocation.pluginId === pluginId) allocation.stop();
  for (const [id, target] of active) if (target.instance.pluginId === pluginId) active.delete(id);
});
