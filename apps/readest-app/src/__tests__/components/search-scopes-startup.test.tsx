import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ loadManager: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (value: string) => value }));
vi.mock('@/services/contentSources/instances', () => ({
  loadSourceInstances: vi.fn(async () => {}),
  useSourceInstances: () => [
    { id: 'source', pluginId: 'plugin', providerId: 'native', enabled: true, name: 'My source' },
    {
      id: 'disabled',
      pluginId: 'plugin',
      providerId: 'native',
      enabled: false,
      name: 'Disabled source',
    },
    {
      id: 'removed-engine',
      pluginId: 'removed',
      providerId: 'native',
      enabled: true,
      name: 'Offline source',
    },
  ],
}));
vi.mock('@/services/plugins/connections', () => {
  const connections: never[] = [];
  return { loadPluginConnections: vi.fn(async () => {}), usePluginConnections: () => connections };
});
vi.mock('@/services/plugins/library', () => {
  const tasks = {};
  return { useExternalLibrarySync: () => tasks };
});
vi.mock('@/services/plugins/persistence', () => ({ readPluginRecord: async () => undefined }));
vi.mock('@/services/plugins/manager', async () => {
  const { create } = await import('zustand');
  const useInstalledPlugins = create<{ plugins: unknown[] }>(() => ({ plugins: [] }));
  return {
    useInstalledPlugins,
    loadPluginManager: async () => {
      state.loadManager();
      useInstalledPlugins.setState({
        plugins: [
          {
            id: 'plugin',
            enabled: true,
            manifest: {
              contributions: { contentSources: [{ id: 'native', capabilities: { search: true } }] },
            },
          },
        ],
      });
    },
  };
});
import { useSearchScopes } from '@/app/library/hooks/useSearchScopes';
afterEach(cleanup);
it('initializes installed plugins so sources appear before any plugin panel or download is opened', async () => {
  const hook = renderHook(useSearchScopes);
  await waitFor(() => expect(state.loadManager).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(hook.result.current.scopes.some((scope) => scope.id === 'source:source')).toBe(true),
  );
  expect(hook.result.current.scopes.map((scope) => scope.id)).toEqual(['local', 'source:source']);
  expect(hook.result.current.libraryScopes.map((scope) => scope.id)).toEqual([
    'local',
    'source:source',
    'source:disabled',
    'source:removed-engine',
  ]);
});
