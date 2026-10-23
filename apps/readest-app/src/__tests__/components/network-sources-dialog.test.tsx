import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

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
    transport: vi.fn(),
    save: vi.fn(),
    grant: vi.fn(),
    dismiss: vi.fn(),
    listChapters: vi.fn(),
    downloaded: vi.fn(),
    removeDownload: vi.fn(),
    work: { id: 'work-1', title: 'Test novel', author: 'Test author', kind: 'text' },
  };
});
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
  saveSourceInstance: state.save,
  setSourceInstanceEnabled: vi.fn(),
  removeSourceInstance: vi.fn(),
  useSourceInstances: (select: (value: { instances: typeof state.instances }) => unknown) =>
    select({ instances: state.instances }),
}));
vi.mock('@/services/plugins/vault', () => ({
  getConnectionSecrets: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/services/contentSources/runtime', () => ({
  getSourceRuntime: vi.fn(async () => ({ call: state.call, provider: state.provider })),
  inspectSourceFile: state.inspect,
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
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(state.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'My novels' } });
    fireEvent.change(screen.getByLabelText('Allowed websites, one URL per line'), {
      target: { value: 'https://books.example/search' },
    });
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
    fireEvent.click(screen.getByRole('button', { name: 'Save and allow access' }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0]?.[1].definition).toMatchObject({ id: 'imported' });
  });

  it('preserves exploration pagination and does not send a search on load more', async () => {
    state.call
      .mockResolvedValueOnce({ items: [state.work], nextCursor: 'next-page' })
      .mockResolvedValueOnce({ items: [], nextCursor: undefined });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    await screen.findByText('Test novel');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(state.call).toHaveBeenCalledTimes(2));
    expect(state.call.mock.calls[1]?.[0]).toBe('source.explore');
    expect(state.call.mock.calls[1]?.[1]).toEqual({ cursor: 'next-page' });
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

  it('shows only a diagnostic code when a plugin error includes credentials', async () => {
    state.call.mockRejectedValue(
      Object.assign(new Error('token=DO_NOT_DISPLAY'), { code: 'SOURCE_PERMISSION_DENIED' }),
    );
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Search' })[1]!);
    await screen.findByText(/SOURCE_PERMISSION_DENIED/u);
    expect(screen.queryByText(/DO_NOT_DISPLAY/u)).toBeNull();
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
  it('removes selected pinned chapters without removing the book or its source', async () => {
    state.call.mockResolvedValueOnce({ items: [state.work] }).mockResolvedValueOnce(state.work);
    state.listChapters.mockResolvedValue([{ id: 'chapter-1', title: 'Chapter One', slot: 0 }]);
    state.downloaded.mockResolvedValue(true);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Search' })[1]!);
    await screen.findByText('Test novel');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    await screen.findByText('Downloaded');
    fireEvent.click(screen.getByRole('checkbox', { name: /Chapter One/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected downloads' }));
    await waitFor(() =>
      expect(state.removeDownload).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: state.instance.id }),
        'chapter-1',
      ),
    );
    await screen.findByText('Downloaded chapters removed');
    expect(state.save).not.toHaveBeenCalled();
  });
});
