import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  handler: undefined as ((event: CustomEvent) => void) | undefined,
  inbox: vi.fn(),
  panel: vi.fn(),
  open: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { readFile: state.read } }),
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ setRequestedPanel: state.panel, setSettingsDialogOpen: state.open }),
  },
}));
vi.mock('@/services/plugins/inbox', () => ({ usePluginInbox: { setState: state.inbox } }));
vi.mock('@/services/plugins/package', () => ({ verifyPluginPackage: vi.fn() }));
vi.mock('@/services/plugins/repositories', () => ({ parseRepositoryImport: vi.fn() }));
vi.mock('@/utils/event', () => ({
  eventDispatcher: {
    on: (_name: string, callback: (event: CustomEvent) => void) => {
      state.handler = callback;
    },
    off: vi.fn(),
  },
}));
import { usePluginIngress } from '@/hooks/usePluginIngress';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
describe('experimental plugin import links', () => {
  it('opens repository review for the experimental deep link', async () => {
    renderHook(() => usePluginIngress());
    state.handler?.(
      new CustomEvent('app-incoming-url', {
        detail: {
          urls: [
            'readest-remote-x://plugins/add-repository?url=https%3A%2F%2Fplugins.example%2Frepo.json',
          ],
        },
      }),
    );
    await waitFor(() =>
      expect(state.inbox).toHaveBeenCalledWith({
        repositoryUrl: 'https://plugins.example/repo.json',
      }),
    );
    expect(state.panel).toHaveBeenCalledWith('Plugins');
    expect(state.open).toHaveBeenCalledWith(true);
    expect(state.read).not.toHaveBeenCalled();
  });
  it('does not claim the stable app scheme or similar-looking routes', () => {
    renderHook(() => usePluginIngress());
    state.handler?.(
      new CustomEvent('app-incoming-url', {
        detail: {
          urls: [
            'readest-remote://plugins/add-repository?url=https://plugins.example/repo.json',
            'readest-remote-x://plugins/add-repository-extra?url=https://plugins.example/repo.json',
          ],
        },
      }),
    );
    expect(state.inbox).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
  });
});
