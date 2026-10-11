import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  libraryResults,
  startPluginWorkerServer,
  type HttpResponse,
  type PluginWorkerGlobalLike,
} from '@readest/plugin-sdk';
import { installPlugin, probeLibraryConnection } from '@/services/plugins/manager';
import { createConnectionLease } from '@/services/plugins/httpBroker';
import type { PluginWorkerLike } from '@/services/plugins/runtime';
import type { VerifiedPluginPackage } from '@/services/plugins/package';
import type { PluginConnection } from '@/services/plugins/types';

const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/services/plugins/persistence', () => ({
  readPluginRecord: async (key: string) => records.get(key),
  listPluginRecords: async (prefix: string) =>
    [...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  writePluginRecords: async (values: Record<string, unknown>, remove: string[] = []) => {
    for (const [key, value] of Object.entries(values)) records.set(key, value);
    for (const key of remove) records.delete(key);
  },
}));
vi.mock('@/services/plugins/package', () => ({ verifyPluginPackage: async () => pkg }));
// Exercise the real RPC and HTTP broker with an in-process SDK worker. Sandbox
// isolation and signed archive verification have separate browser tests.
vi.mock('@/services/plugins/sandbox', () => ({
  createSandboxedPluginWorker: () => {
    const scope: PluginWorkerGlobalLike = {
      onmessage: null,
      postMessage: (data) =>
        queueMicrotask(() => worker.onmessage?.(new MessageEvent('message', { data }))),
    };
    const worker: PluginWorkerLike = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (data) =>
        queueMicrotask(() => scope.onmessage?.(new MessageEvent('message', { data }))),
      terminate: () => {
        scope.onmessage = null;
        worker.onmessage = null;
      },
    };
    startPluginWorkerServer(scope, {
      'library.testConnection': async ({ context }, host) => {
        await host.call('http.request', { connection: context.connection, path: '/test' });
        return { name: 'Test server' };
      },
      'library.listLibraries': async ({ context }, host) => {
        const response = (await host.call('http.request', {
          connection: context.connection,
          path: '/libraries',
        })) as HttpResponse;
        return libraryResults['library.listLibraries'].parse(
          JSON.parse(new TextDecoder().decode(response.bytes)),
        );
      },
    });
    return worker;
  },
}));

const pkg: VerifiedPluginPackage = {
  manifest: {
    id: 'test.abort',
    name: 'Abort regression',
    protocolVersion: 2,
    pluginVersion: '1.0.0',
    entry: 'worker.js',
    pluginApi: { min: 2, max: 2 },
    permissions: { network: true },
    contributions: {
      dictionaryFormats: [],
      librarySources: [{ id: 'test', name: 'Test', formats: ['EPUB'], settings: [] }],
    },
  },
  fingerprint: 'a'.repeat(64),
  publicKey: '',
  packageHash: 'b'.repeat(64),
  workerSource: '',
  bytes: new Uint8Array([1]),
  resources: {},
};
const connection: PluginConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  pluginId: pkg.manifest.id,
  fingerprint: pkg.fingerprint,
  sourceId: 'test',
  name: 'Test',
  url: 'https://server.example',
  config: {},
  libraryIds: [],
  secretNames: [],
  addedAt: 1,
  updatedAt: 1,
};
const libraries = [{ id: '1', name: 'Books' }];
const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
const leases: ReturnType<typeof createConnectionLease>[] = [];
const lease = () => {
  const result = createConnectionLease(connection, { network: true }, () => true, {
    connection: () => connection,
    device: async () => ({}),
    credentials: async () => ({}),
  });
  leases.push(result);
  return result;
};
beforeAll(() => installPlugin(pkg, true));
beforeEach(() => {
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
});
afterEach(() => {
  for (const target of leases.splice(0)) target.close();
  if (originalAny) Object.defineProperty(AbortSignal, 'any', originalAny);
  else Reflect.deleteProperty(AbortSignal, 'any');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('plugin connections without AbortSignal.any', () => {
  it('tests the connection and lists libraries through the SDK and HTTP broker', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(libraries)));
    vi.stubGlobal('fetch', fetcher);
    await expect(probeLibraryConnection(connection, {}, {})).resolves.toEqual(libraries);
    expect(fetcher.mock.calls).toHaveLength(2);
  });

  it('honors a probe already cancelled before it starts', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(
      probeLibraryConnection(connection, {}, {}, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels the active HTTP request when the probe is cancelled', async () => {
    let active: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        active = init.signal;
        return new Promise<Response>((_resolve, reject) =>
          active?.addEventListener('abort', () => reject(active?.reason), { once: true }),
        );
      }),
    );
    const controller = new AbortController();
    const pending = probeLibraryConnection(connection, {}, {}, controller.signal);
    const failure = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(active).toBeDefined());
    controller.abort();
    expect(await failure).toMatchObject({ name: 'AbortError' });
    expect(active?.aborted).toBe(true);
  });

  it('retains the probe deadline while listing libraries after a successful connection test', async () => {
    const deadlines: AbortController[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    let active: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/test')) return new Response('{}');
        active = init.signal;
        return new Promise<Response>((_resolve, reject) =>
          active?.addEventListener('abort', () => reject(active?.reason), { once: true }),
        );
      }),
    );
    const failure = probeLibraryConnection(connection, {}, {}).catch((error: unknown) => error);
    await vi.waitFor(() => expect(active).toBeDefined());
    // The first deadline belongs to the complete probe, before either HTTP call.
    deadlines[0]!.abort(new DOMException('Timed out', 'TimeoutError'));
    expect(await failure).toMatchObject({ name: 'AbortError' });
    expect(active?.aborted).toBe(true);
  });

  it('uses one signal and deadline across same-server redirects', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal);
        return signals.length === 1
          ? new Response(null, { status: 302, headers: { location: '/final' } })
          : new Response('book');
      }),
    );
    const target = lease();
    expect(
      await (await target.request({ connection: target.context.connection, path: '/file' })).text(),
    ).toBe('book');
    expect(signals).toHaveLength(2);
    expect(signals[1]).toBe(signals[0]);
  });

  it.each([
    'caller',
    'lease',
    'timeout',
  ] as const)('keeps %s cancellation connected after response headers', async (source) => {
    const controller = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let active: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(stream) {
                active = init.signal;
                stream.enqueue(new Uint8Array([1]));
                init.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), {
                  once: true,
                });
              },
            }),
          ),
      ),
    );
    const target = lease();
    const response = await target.request(
      { connection: target.context.connection, path: '/file' },
      controller.signal,
      1234,
    );
    const reader = response.body!.getReader();
    expect(await reader.read()).toEqual({ value: new Uint8Array([1]), done: false });
    const failure = expect(reader.read()).rejects.toBeDefined();
    if (source === 'caller') controller.abort();
    else if (source === 'lease') target.close();
    else deadline.abort(new DOMException('Timed out', 'TimeoutError'));
    await failure;
    expect(active?.reason).toMatchObject({
      name: source === 'timeout' ? 'TimeoutError' : 'AbortError',
    });
    reader.releaseLock();
    expect(timeout).toHaveBeenCalledWith(1234);
  });
});
