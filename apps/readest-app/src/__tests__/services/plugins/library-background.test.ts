import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { PluginConnection } from '@/services/plugins/types';
import { useLibraryStore } from '@/store/libraryStore';
import { create } from 'zustand';

const mocks = vi.hoisted(() => ({ call: vi.fn(), request: vi.fn() }));
vi.mock('@/services/plugins/connections', () => ({
  usePluginConnections: create(() => ({ connections: [] as PluginConnection[] })),
  loadPluginConnections: vi.fn(),
}));
vi.mock('@/services/plugins/manager', () => ({
  getLibraryRuntime: vi.fn(async () => ({
    connection: usePluginConnections.getState().connections[0],
    runtime: { call: mocks.call },
    lease: { context: {}, request: mocks.request },
  })),
  loadPluginManager: vi.fn(),
  findInstalledPlugin: vi.fn(() => ({ enabled: true })),
}));
vi.mock('@/services/plugins/persistence', () => ({
  readPluginRecord: vi.fn(),
  writePluginRecords: vi.fn(),
}));
import { usePluginConnections } from '@/services/plugins/connections';
import {
  cancelExternalLibrarySync,
  syncExternalLibrary,
  reconcileExternalCatalog,
  useExternalLibrarySync,
} from '@/services/plugins/library';

const connection: PluginConnection = {
  id: 'a7d45297-7a2f-4097-8f93-d025c9857710',
  pluginId: 'test',
  fingerprint: 'a'.repeat(64),
  sourceId: 'test',
  name: 'Test',
  url: 'https://example.org',
  config: {},
  libraryIds: ['library'],
  secretNames: [],
  addedAt: 1,
  updatedAt: 1,
};
const item = {
  id: 'book',
  libraryId: 'library',
  title: 'Remote',
  author: 'Author',
  format: 'EPUB',
  revision: '1',
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const app = {
  saveLibraryBooks: vi.fn(async () => {}),
  exists: vi.fn(async () => false),
} as unknown as AppService;
beforeEach(() => {
  vi.clearAllMocks();
  usePluginConnections.setState({ connections: [{ ...connection }] });
  useLibraryStore.getState().setLibrary([]);
  useExternalLibrarySync.setState({ tasks: {} });
});
describe('background external library sync', () => {
  it('keeps live user edits through a large paged scan and does not mark missing books on partial failure', async () => {
    const original = reconcileExternalCatalog(connection, [{ ...item, format: 'EPUB' }], [])[0]!;
    useLibraryStore.getState().setLibrary([original]);
    let page = 0;
    mocks.call.mockImplementation(async (method: string) => {
      if (method !== 'library.syncCatalog') return null;
      if (++page === 2) {
        useLibraryStore
          .getState()
          .setLibrary([
            { ...original, title: 'My title', metadataUpdatedAt: 50, progress: [4, 10] },
          ]);
      }
      return {
        books: Array.from({ length: 400 }, (_, i) => ({
          ...item,
          id: page === 1 && i === 0 ? item.id : `${page}-${i}`,
        })),
        nextCursor: String(page),
        complete: page === 3,
      };
    });
    await expect(syncExternalLibrary(app, connection.id)).resolves.toBe(1200);
    const saved = useLibraryStore.getState().getBookByHash(original.hash)!;
    expect(saved.title).toBe('My title');
    expect(saved.progress).toEqual([4, 10]);
    const before = useLibraryStore.getState().library;
    mocks.call
      .mockResolvedValueOnce({ books: [], nextCursor: 'partial', complete: false })
      .mockRejectedValueOnce(new Error('Disconnected'));
    await expect(syncExternalLibrary(app, connection.id)).rejects.toThrow('Disconnected');
    expect(useLibraryStore.getState().library).toBe(before);
  });
  it('publishes the catalog before slow covers finish and deduplicates requests', async () => {
    const cover = deferred<null>();
    mocks.call.mockImplementation(async (method: string) =>
      method === 'library.syncCatalog' ? { books: [item], complete: true } : cover.promise,
    );
    const first = syncExternalLibrary(app, connection.id);
    const second = syncExternalLibrary(app, connection.id);
    await vi.waitFor(() =>
      expect(useExternalLibrarySync.getState().tasks[connection.id]?.phase).toBe('covers'),
    );
    expect(useLibraryStore.getState().library).toHaveLength(1);
    expect(
      mocks.call.mock.calls.filter(([method]) => method === 'library.syncCatalog'),
    ).toHaveLength(1);
    cover.resolve(null);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(1);
    expect(useExternalLibrarySync.getState().tasks[connection.id]?.phase).toBe('completed');
  });
  it.each([
    'cancel',
    'edit',
    'remove',
  ])('does not publish a stale scan after %s', async (action) => {
    const scan = deferred<{ books: (typeof item)[]; complete: boolean }>();
    mocks.call.mockReturnValue(scan.promise);
    const job = syncExternalLibrary(app, connection.id);
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled());
    if (action === 'cancel') cancelExternalLibrarySync(connection.id);
    else
      usePluginConnections.setState({
        connections: action === 'remove' ? [] : [{ ...connection, updatedAt: 2 }],
      });
    scan.resolve({ books: [item], complete: true });
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
    expect(useLibraryStore.getState().library).toEqual([]);
    expect(app.saveLibraryBooks).not.toHaveBeenCalled();
    expect(useExternalLibrarySync.getState().tasks[connection.id]?.phase).toBe('cancelled');
  });
  it('allows retry after failure', async () => {
    mocks.call.mockRejectedValueOnce(new Error('offline'));
    await expect(syncExternalLibrary(app, connection.id)).rejects.toThrow('offline');
    expect(useExternalLibrarySync.getState().tasks[connection.id]?.phase).toBe('failed');
    mocks.call.mockResolvedValueOnce({ books: [], complete: true });
    await expect(syncExternalLibrary(app, connection.id)).resolves.toBe(0);
  });
  it('starts a replacement scan when saving an edited connection before the old scan settles', async () => {
    const scan = deferred<{ books: (typeof item)[]; complete: boolean }>();
    mocks.call
      .mockReturnValueOnce(scan.promise)
      .mockResolvedValueOnce({ books: [], complete: true });
    const old = syncExternalLibrary(app, connection.id);
    const stopped = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled());
    usePluginConnections.setState({ connections: [{ ...connection, updatedAt: 2 }] });
    const replacement = syncExternalLibrary(app, connection.id);
    scan.resolve({ books: [item], complete: true });
    await stopped;
    await expect(replacement).resolves.toBe(0);
    expect(useExternalLibrarySync.getState().tasks[connection.id]?.phase).toBe('completed');
  });
});
