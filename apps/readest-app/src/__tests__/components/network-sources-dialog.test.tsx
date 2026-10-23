import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => {
  const provider = {
    id: 'novel',
    name: 'Example novels',
    kinds: ['text'],
    capabilities: { search: true, explore: true, describe: false },
    settings: [],
  };
  const plugin = {
    id: 'example.native',
    enabled: true,
    permissions: { secretValues: false },
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
    transport: vi.fn(),
    save: vi.fn(),
    describe: vi.fn(),
    readSecrets: vi.fn(async (): Promise<Record<string, string>> => ({})),
    subscriptions: [] as unknown[],
    grant: vi.fn(),
    dismiss: vi.fn(),
    listChapters: vi.fn(),
    downloaded: vi.fn(),
    removeDownload: vi.fn(),
    work: { id: 'work-1', title: 'Test novel', author: 'Test author', kind: 'text' },
  };
});
vi.mock('@/components/settings/SourceDownloadManager', () => ({ default: () => null }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
vi.mock('@/hooks/useAppRouter', () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/nav', () => ({ navigateToReader: vi.fn() }));
vi.mock('@/components/Dialog', () => ({
  default: ({
    children,
    isOpen,
    title,
  }: {
    children: ReactNode;
    isOpen: boolean;
    title: string;
  }) =>
    isOpen ? (
      <div role='dialog' aria-label={title}>
        {children}
      </div>
    ) : null,
}));
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
  describeSourceDefinition: state.describe,
  validateSourceSettings: vi.fn(async () => ({ fieldErrors: {} })),
  useSourceDiagnostics: (select: (value: { entries: never[] }) => unknown) =>
    select({ entries: [] }),
}));
vi.mock('@/services/contentSources/network', () => ({ sourceTransport: state.transport }));
vi.mock('@/services/contentSources/catalog', () => ({
  addSourceWork: vi.fn(),
  getSourceBookRef: vi.fn(),
  listSourceChapters: state.listChapters,
  downloadSourceChapters: vi.fn(),
  sourceChapterDownloaded: state.downloaded,
  removeSourceDownloadedChapter: state.removeDownload,
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
import SourceInteractionDialog from '@/components/settings/SourceInteractionDialog';

beforeEach(() => {
  vi.clearAllMocks();
  state.plugins = [state.plugin];
  state.instances = [state.instance];
  state.pending = [];
  state.origins = [];
  state.subscriptions = [];
  state.readSecrets.mockResolvedValue({});
  state.describe.mockResolvedValue({ settings: [], actions: [], authentication: { kind: 'none' } });
  state.save.mockResolvedValue(undefined);
  state.grant.mockResolvedValue(undefined);
  state.inspect.mockReset();
  state.call.mockReset();
  state.transport.mockReset();
  state.listChapters.mockResolvedValue([]);
  state.downloaded.mockResolvedValue(false);
  state.removeDownload.mockResolvedValue(undefined);
});
afterEach(cleanup);
const mount = async () => {
  const result = render(<NetworkSourcesDialog isOpen onClose={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText('Working…')).toBeNull());
  return result;
};

describe('network sources interface', () => {
  it('creates a native source only after explicit settings and origin approval', async () => {
    await mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[0]!);
    expect(state.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'My novels' } });
    fireEvent.change(screen.getByLabelText('Allowed websites, one URL per line'), {
      target: { value: 'https://books.example/search' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and allow access' })).not.toHaveProperty(
        'disabled',
        true,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save and allow access' }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0]?.[0]).toMatchObject({
      name: 'My novels',
      pluginId: 'example.native',
      providerId: 'novel',
      origins: ['https://books.example'],
      allowPrivateNetwork: false,
    });
  });

  it('keeps imported definitions uninstalled until the individual source is reviewed', async () => {
    state.plugins = [
      {
        ...state.plugin,
        manifest: {
          ...state.plugin.manifest,
          contributions: {
            contentSources: [state.provider],
            sourceFormats: [
              { id: 'legado', providerId: 'novel', name: 'Legado', extensions: ['json'] },
            ],
          },
        },
      } as typeof state.plugin,
    ];
    state.inspect.mockResolvedValue({
      definitions: [
        {
          id: 'imported',
          name: 'Imported novels',
          format: 'legado',
          revision: '1',
          content: '{"bookSourceName":"Imported novels"}',
          origins: ['https://import.example'],
        },
      ],
    });
    const result = await mount();
    const file = new File(['{}'], 'source.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => '{}' });
    fireEvent.change(result.container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    await screen.findByText('Imported novels');
    expect(state.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByLabelText('Allowed websites, one URL per line')).toHaveProperty(
      'value',
      'https://import.example',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and allow access' })).not.toHaveProperty(
        'disabled',
        true,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save and allow access' }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0]?.[1].definition).toMatchObject({ id: 'imported' });
  });

  it('lists remote source references without fetching until the user selects one', async () => {
    state.plugins = [
      {
        ...state.plugin,
        manifest: {
          ...state.plugin.manifest,
          contributions: {
            contentSources: [state.provider],
            sourceFormats: [
              { id: 'venera', providerId: 'novel', name: 'Venera', extensions: ['json', 'js'] },
            ],
          },
        },
      } as typeof state.plugin,
    ];
    state.inspect
      .mockResolvedValueOnce({
        definitions: [],
        references: [
          { name: 'Remote source', url: 'https://configs.example/source.js', format: 'venera' },
        ],
      })
      .mockResolvedValueOnce({
        definitions: [
          {
            id: 'downloaded',
            name: 'Downloaded source',
            format: 'venera',
            revision: '1',
            content: 'class ComicSource {}',
          },
        ],
      });
    state.transport.mockResolvedValue({
      status: 200,
      bytes: new TextEncoder().encode('class ComicSource {}'),
      headers: {},
      setCookies: [],
      url: 'https://configs.example/source.js',
    });
    const result = await mount();
    const file = new File(['[]'], 'index.json');
    Object.defineProperty(file, 'text', { value: async () => '[]' });
    fireEvent.change(result.container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    await screen.findByText('Remote source');
    expect(state.transport).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Download and inspect' }).at(-1)!);
    await screen.findByText('Downloaded source');
    expect(state.transport.mock.calls[0]?.[0]).toBe('https://configs.example/source.js');
    expect(state.inspect.mock.calls[1]?.[6]).toBe('https://configs.example/source.js');
    expect(state.save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('requires an explicit answer for an additional website', async () => {
    state.origins = [{ instanceId: state.instance.id, origin: 'https://images.example' }];
    render(<SourceInteractionDialog />);
    expect(state.grant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(state.grant).toHaveBeenCalledWith(state.instance.id, 'https://images.example'),
    );
  });

  it('preserves stored credentials when editing unrelated source settings', async () => {
    state.readSecrets.mockResolvedValue({ token: 'saved-token' });
    await mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[1]!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and allow access' })).not.toHaveProperty(
        'disabled',
        true,
      ),
    );
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and allow access' }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0]?.[1].secrets).toEqual({ token: 'saved-token' });
  });
  it('renders dynamic source settings and saves an API key outside public configuration', async () => {
    state.plugins = [
      {
        ...state.plugin,
        permissions: { secretValues: true },
        manifest: {
          ...state.plugin.manifest,
          contributions: {
            ...state.plugin.manifest.contributions,
            contentSources: [
              {
                ...state.provider,
                capabilities: { ...state.provider.capabilities, describe: true },
              },
            ],
          },
        },
      } as typeof state.plugin,
    ];
    state.describe.mockResolvedValue({
      settings: [
        { key: 'apiKey', label: 'API Key', type: 'secret', private: true, default: '' },
        {
          key: 'language',
          label: 'Language',
          type: 'select',
          options: [
            { value: 'en', label: 'English' },
            { value: 'ja', label: 'Japanese' },
          ],
          default: 'en',
        },
      ],
      actions: [],
      authentication: { kind: 'unsupported', reason: 'account.loginWithWebview' },
    });
    await mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[1]!);
    const apiKey = await screen.findByLabelText('API Key');
    expect(apiKey).toHaveProperty('type', 'password');
    fireEvent.change(apiKey, { target: { value: 'fixture-private-key' } });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ja' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and allow access' }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0]?.[0].config).toEqual({ language: 'ja' });
    expect(state.save.mock.calls[0]?.[1].secrets).toEqual({ apiKey: 'fixture-private-key' });
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});
