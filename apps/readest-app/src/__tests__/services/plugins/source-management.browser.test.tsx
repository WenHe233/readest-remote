import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { page } from 'vitest/browser';
import zh from '../../../../public/locales/zh-CN/translation.json';
import '@/styles/globals.css';

const state = vi.hoisted(() => {
  const provider = {
    id: 'novel',
    name: 'Example novels',
    kinds: ['text'],
    capabilities: { search: true, explore: true },
    settings: [],
  };
  const plugin = {
    id: 'example.native',
    enabled: true,
    fingerprint: 'a'.repeat(64),
    manifest: { name: 'Example', contributions: { contentSources: [provider], sourceFormats: [] } },
  };
  const instance = {
    id: '40db0d15-7837-49ed-8303-190fb3cff54e',
    pluginId: plugin.id,
    providerId: provider.id,
    name: 'Novel source',
    enabled: true,
    fingerprint: plugin.fingerprint,
    config: {},
    origins: [],
    secretNames: [],
  };
  return {
    provider,
    plugin,
    instance,
    plugins: [plugin],
    instances: [instance],
    pending: [] as unknown[],
    origins: [] as unknown[],
    call: vi.fn(),
    inspect: vi.fn(),
    save: vi.fn(),
    readSecrets: vi.fn(async (): Promise<Record<string, string>> => ({})),
    subscriptions: [] as unknown[],
    grant: vi.fn(),
    dismiss: vi.fn(),
    work: { id: 'work-1', title: 'Test novel', author: 'Test author', kind: 'text' },
  };
});
vi.mock('@/components/settings/SourceDownloadManager', () => ({ default: () => null }));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => (zh as Record<string, string>)[key] ?? key,
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
vi.mock('@/hooks/useAppRouter', () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/nav', () => ({ navigateToReader: vi.fn() }));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: (select: (value: { library: never[] }) => unknown) => select({ library: [] }),
}));
vi.mock('@/services/plugins/manager', () => ({
  loadPluginManager: vi.fn().mockResolvedValue(undefined),
  useInstalledPlugins: (select: (value: { plugins: typeof state.plugins }) => unknown) =>
    select({ plugins: state.plugins }),
}));
vi.mock('@/services/contentSources/instances', () => ({
  loadSourceInstances: vi.fn().mockResolvedValue(undefined),
  readSourceDefinition: vi.fn().mockResolvedValue(undefined),
  saveSourceInstance: state.save,
  setSourceInstanceEnabled: vi.fn(),
  removeSourceInstance: vi.fn(),
  useSourceInstances: (select: (value: { instances: typeof state.instances }) => unknown) =>
    select({ instances: state.instances }),
}));
vi.mock('@/services/contentSources/privateStorage', () => ({
  readSourceCredentials: state.readSecrets,
}));
vi.mock('@/services/contentSources/subscriptions', () => ({
  loadSourceSubscriptions: vi.fn().mockResolvedValue(undefined),
  useSourceSubscriptions: (select: (value: { subscriptions: unknown[] }) => unknown) =>
    select({ subscriptions: state.subscriptions }),
  saveSourceSubscription: vi.fn(async (input: Record<string, unknown>, references: unknown[]) => {
    const item = { ...input, id: 'list', references };
    state.subscriptions = [item];
    return item;
  }),
  refreshSourceSubscription: vi.fn(),
  removeSourceSubscription: vi.fn(),
}));
vi.mock('@/services/plugins/vault', () => ({
  getConnectionSecrets: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/services/contentSources/runtime', () => ({
  getSourceRuntime: vi.fn(async () => ({ call: state.call, provider: state.provider })),
  inspectSourceFile: state.inspect,
  describeSourceDefinition: vi.fn(async () => ({
    settings: [],
    actions: [],
    authentication: { kind: 'none' },
  })),
  validateSourceSettings: vi.fn(async () => ({ fieldErrors: {} })),
  useSourceDiagnostics: (select: (value: { entries: never[] }) => unknown) =>
    select({ entries: [] }),
}));
vi.mock('@/services/contentSources/network', () => ({ sourceTransport: vi.fn() }));
vi.mock('@/services/contentSources/catalog', () => ({
  addSourceWork: vi.fn(),
  getSourceBookRef: vi.fn(),
  listSourceChapters: vi.fn().mockResolvedValue([]),
  downloadSourceChapters: vi.fn(),
  sourceChapterDownloaded: vi.fn(),
  removeSourceDownloadedChapter: vi.fn(),
  sourceBookHash: vi.fn(),
  useSourceDownloads: (select: (value: { tasks: object }) => unknown) => select({ tasks: {} }),
}));
vi.mock('@/services/contentSources/interactions', () => ({
  useSourceInteractions: (select: (value: { pending: unknown[] }) => unknown) =>
    select({ pending: state.pending }),
}));
vi.mock('@/services/contentSources/permissions', () => ({
  useSourceOriginRequests: (select: (value: { requests: unknown[] }) => unknown) =>
    select({ requests: state.origins }),
  grantSourceOrigin: state.grant,
  dismissSourceOrigin: state.dismiss,
}));

import NetworkSourcesDialog from '@/components/settings/NetworkSourcesDialog';

beforeEach(() => {
  vi.clearAllMocks();
  state.plugins = [state.plugin];
  state.instances = [state.instance];
  state.pending = [];
  state.origins = [];
  state.subscriptions = [];
  state.readSecrets.mockResolvedValue({});
  state.save.mockResolvedValue(undefined);
  state.grant.mockResolvedValue(undefined);
});
afterEach(cleanup);
const mount = async () => {
  const result = render(<NetworkSourcesDialog isOpen onClose={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText(zh['Working…'])).toBeNull());
  return result;
};

describe('network source layout', () => {
  it.each([320, 720])('keeps source permissions visible at %ipx in eink mode', async (width) => {
    await page.viewport(width, 844);
    document.documentElement.dataset['eink'] = 'true';
    document.documentElement.style.fontSize = '20px';
    await mount();
    fireEvent.click(screen.getAllByRole('button', { name: zh['Configure'] })[0]!);
    const dialog = await screen.findByRole('dialog', { name: zh['Source settings'] });
    await waitFor(() => expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0));
    for (const control of dialog.querySelectorAll('button, input, textarea, select')) {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      expect(rect.left).toBeGreaterThanOrEqual(-1);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
    }
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    console.warn('Source UI screenshot:', await page.screenshot());
    delete document.documentElement.dataset['eink'];
    document.documentElement.style.fontSize = '';
  });
});
