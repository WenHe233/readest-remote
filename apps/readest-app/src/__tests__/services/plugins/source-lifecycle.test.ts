import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceInstance } from '@/services/contentSources/instances';

const state = vi.hoisted(() => ({
  installed: {
    id: 'test.source',
    fingerprint: 'a'.repeat(64),
    enabled: true,
    activeHash: 'pkg',
    permissions: {},
    manifest: { contributions: { sourceFormats: [{ id: 'native', providerId: 'native' }] } },
  },
  instances: new Map<string, SourceInstance>(),
  runtimes: [] as Array<{ close: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn> }>,
  hold: undefined as Promise<unknown> | undefined,
  packageGate: undefined as Promise<void> | undefined,
  packageRequests: 0,
  busyLeases: new Set<string>(),
}));
vi.mock('@/services/plugins/manager', () => ({
  findInstalledPlugin: () => state.installed,
  loadPluginManager: async () => {},
  getInstalledPluginPackage: async () => {
    state.packageRequests++;
    await state.packageGate;
    return {
      manifest: {
        contributions: { contentSources: [{ id: 'native', capabilities: { search: true } }] },
      },
      resources: {},
      workerSource: '',
    };
  },
  useInstalledPlugins: { subscribe: () => () => {} },
}));
vi.mock('@/services/contentSources/instances', () => ({
  loadSourceInstances: async () => {},
  getSourceInstance: (id: string) => state.instances.get(id),
  readSourceDefinition: async () => undefined,
  useSourceInstances: { subscribe: () => () => {} },
}));
vi.mock('@/services/contentSources/network', () => ({
  createSourceLease: (instance: SourceInstance) => ({
    context: {},
    close: vi.fn(),
    handleHostCall: vi.fn(),
    busy: () => state.busyLeases.has(instance.id),
  }),
}));
vi.mock('@/services/plugins/runtime', async (original) => {
  const actual = await original<typeof import('@/services/plugins/runtime')>();
  return {
    ...actual,
    createPluginRuntime: () => {
      const runtime = {
        close: vi.fn(),
        call: vi.fn(async () => state.hold ?? { definitions: [] }),
      };
      state.runtimes.push(runtime);
      return runtime;
    },
  };
});
const instance = (id: string): SourceInstance => ({
  id,
  pluginId: 'test.source',
  fingerprint: 'a'.repeat(64),
  providerId: 'native',
  name: id,
  config: {},
  enabled: true,
  origins: [],
  allowPrivateNetwork: false,
  secretNames: [],
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => {
  vi.resetModules();
  state.instances.clear();
  state.runtimes = [];
  state.hold = undefined;
  state.packageGate = undefined;
  state.packageRequests = 0;
  state.busyLeases.clear();
});

describe('source capability lifecycle', () => {
  it('prevents a pending archive load from resurrecting a stopped worker', async () => {
    const { getSourceRuntime } = await import('@/services/contentSources/runtime');
    const { stopPluginDependents } = await import('@/services/plugins/lifecycle');
    let finish: (() => void) | undefined;
    state.packageGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.instances.set('one', instance('one'));
    const starting = getSourceRuntime('one');
    const rejection = expect(starting).rejects.toThrow(/stopped/);
    await vi.waitFor(() => expect(state.packageRequests).toBe(1));
    stopPluginDependents('test.source');
    finish!();
    await rejection;
    expect(state.runtimes).toHaveLength(0);
  });

  it('does not evict a worker whose resource download is still running', async () => {
    const { getSourceRuntime } = await import('@/services/contentSources/runtime');
    for (let i = 0; i < 5; i++) state.instances.set(String(i), instance(String(i)));
    for (let i = 0; i < 4; i++) {
      await getSourceRuntime(String(i));
      state.busyLeases.add(String(i));
    }
    await expect(getSourceRuntime('4')).rejects.toMatchObject({ code: 'SOURCE_BUSY' });
    expect(state.runtimes.every((runtime) => runtime.close.mock.calls.length === 0)).toBe(true);
    state.busyLeases.delete('1');
    await getSourceRuntime('4');
    expect(state.runtimes[1]!.close).toHaveBeenCalled();
  });
  it('closes source workers on a core plugin stop even when the installed row does not change', async () => {
    const { getSourceRuntime } = await import('@/services/contentSources/runtime');
    const { stopPluginDependents } = await import('@/services/plugins/lifecycle');
    state.instances.set('one', instance('one'));
    const first = await getSourceRuntime('one');
    stopPluginDependents('test.source');
    expect(state.runtimes[0]!.close).toHaveBeenCalled();
    await expect(first.call('source.search', { query: 'x' })).rejects.toThrow(/closed/);
    const second = await getSourceRuntime('one');
    expect(second).not.toBe(first);
  });

  it('counts import inspectors against the same bounded allocation as instance workers', async () => {
    const { inspectSourceFile } = await import('@/services/contentSources/runtime');
    let finish: (() => void) | undefined;
    state.hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const imports = Array.from({ length: 4 }, () =>
      inspectSourceFile('test.source', 'native', 'native', '{}'),
    );
    await vi.waitFor(() => expect(state.runtimes).toHaveLength(4));
    await expect(inspectSourceFile('test.source', 'native', 'native', '{}')).rejects.toMatchObject({
      code: 'SOURCE_BUSY',
    });
    finish!();
    await Promise.all(imports);
    expect(state.runtimes.every((runtime) => runtime.close.mock.calls.length > 0)).toBe(true);
  });
});
