import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import { pluginRequestSchema } from '@readest/plugin-sdk';
import {
  addSourceWork,
  chapterResources,
  listSourceChapters,
  downloadSourceChapters,
  resolveSourceChapter,
  loadSourceResource,
  sourceChapterDownloaded,
  sourceBookHash,
  removeSourceDownloadedChapter,
  type SourceBookRef,
} from '@/services/contentSources/catalog';
const memory = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  cache: new Map<string, { bytes: Uint8Array; mime: string }>(),
  call: vi.fn(),
  request: vi.fn(),
  read: vi.fn(),
  library: [] as Book[],
  offline: false,
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({
      library: memory.library,
      getBookByHash: (hash: string) => memory.library.find((book) => book.hash === hash),
      setLibrary: (books: Book[]) => {
        memory.library = books;
      },
    }),
  },
}));
vi.mock('@/services/contentSources/instances', () => ({
  getSourceInstance: () => ({ pluginId: 'native.example', fingerprint: 'a'.repeat(64) }),
  loadSourceInstances: async () => {},
}));
vi.mock('@/services/contentSources/runtime', () => ({
  getSourceRuntime: async () => {
    if (memory.offline) throw new Error('Plugin was uninstalled');
    return {
      instance: { pluginId: 'native.example', fingerprint: 'a'.repeat(64) },
      call: (operation: string, payload: object, signal?: AbortSignal) => {
        pluginRequestSchema.parse({
          kind: 'request',
          protocolVersion: 2,
          requestId: 'fixture',
          operation,
          payload: {
            ...payload,
            context: { instance: 'fixture-lease', providerId: 'native', config: {} },
          },
        });
        return memory.call(operation, payload, signal);
      },
      lease: { context: { instance: 'lease' }, request: memory.request },
    };
  },
}));
vi.mock('@/services/plugins/persistence', () => ({
  readPluginRecord: async (key: string) => {
    memory.read(key);
    return memory.records.get(key);
  },
  writePluginRecords: async (records: Record<string, unknown>, remove: string[] = []) => {
    Object.entries(records).forEach(([key, value]) => memory.records.set(key, value));
    remove.forEach((key) => memory.records.delete(key));
  },
}));
vi.mock('@/services/plugins/cache', () => ({
  cacheKey: async (...parts: string[]) => parts.join('|'),
  readContentCache: async (key: string) => memory.cache.get(key),
  writeContentCache: async (key: string, bytes: Uint8Array, mime: string) => {
    memory.cache.set(key, { bytes, mime });
  },
  clearContentCache: async () => {
    memory.cache.clear();
  },
}));
const ref: SourceBookRef = {
  instanceId: '7fdbce26-4387-4a0e-80f1-f4e922ab23e2',
  pluginId: 'native.example',
  fingerprint: 'a'.repeat(64),
  work: { id: 'book', title: 'Book', author: '', kind: 'text' },
};
const first = { id: 'a', title: 'Chapter A', url: 'https://source.example/a' };
beforeEach(() => {
  memory.records.clear();
  memory.cache.clear();
  memory.call.mockReset();
  memory.request.mockReset();
  memory.read.mockClear();
  memory.library = [];
  memory.offline = false;
  vi.stubGlobal('Blob', NodeBlob);
});
describe('online directories and explicit downloads', () => {
  it('durably changes the full-text revision when a chapter is completed or removed offline', async () => {
    memory.call.mockImplementation(async (operation: string) =>
      operation === 'source.getChapters'
        ? { items: [first] }
        : { kind: 'html', html: '<p>Downloaded words</p>' },
    );
    const key = `source-search-revision:${sourceBookHash(ref.instanceId, ref.work.id)}`;
    await downloadSourceChapters(ref, ['a']);
    const completed = memory.records.get(key);
    expect(typeof completed).toBe('string');
    memory.offline = true;
    memory.call.mockClear();
    await removeSourceDownloadedChapter(ref, 'a');
    expect(typeof memory.records.get(key)).toBe('string');
    expect(memory.records.get(key)).not.toBe(completed);
    expect(memory.call).not.toHaveBeenCalled();
  });
  it('resumes verified resource checkpoints after an interrupted download and cache loss', async () => {
    memory.call.mockImplementation(
      async (operation: string, payload: { resource?: { id: string } }) =>
        operation === 'source.getChapters'
          ? { items: [first] }
          : operation === 'source.resolveChapter'
            ? { kind: 'pages', pages: [{ id: 'one' }, { id: 'two' }] }
            : { url: `https://source.example/${payload.resource!.id}` },
    );
    memory.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith('/two')) throw new Error('interrupted');
      return { status: 200, headers: {}, bytes: new Uint8Array([1, 2, 3]) };
    });
    await expect(downloadSourceChapters(ref, ['a'])).rejects.toThrow('interrupted');
    expect(
      [...memory.records.keys()].filter((key) => key.startsWith('source-download-bytes:')),
    ).toHaveLength(1);
    expect(await sourceChapterDownloaded(ref, 'a')).toBe(false);
    memory.cache.clear();
    memory.request
      .mockReset()
      .mockResolvedValue({ status: 200, headers: {}, bytes: new Uint8Array([4, 5, 6]) });
    await downloadSourceChapters(ref, ['a']);
    expect(memory.request).toHaveBeenCalledTimes(1);
    expect(memory.request.mock.calls[0]![0].url).toBe('https://source.example/two');
    expect(await sourceChapterDownloaded(ref, 'a')).toBe(true);
    memory.offline = true;
    expect(
      new Uint8Array(await (await loadSourceResource(ref, { id: 'one' }, first)).arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each([
    0, 1,
  ])('cancels directory subscriber %i without aborting the other reader', async (cancelled) => {
    let finish!: (result: { items: (typeof first)[] }) => void;
    let networkSignal!: AbortSignal;
    memory.call.mockImplementation((_operation: string, _input: unknown, signal: AbortSignal) => {
      networkSignal = signal;
      return new Promise((resolve, reject) => {
        finish = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const controllers = [new AbortController(), new AbortController()];
    const outcomes = controllers.map((controller) =>
      listSourceChapters(ref, { signal: controller.signal }).then(
        () => 'completed',
        (error: Error) => error.name,
      ),
    );
    await vi.waitFor(() => expect(memory.call).toHaveBeenCalledTimes(1));
    controllers[cancelled]!.abort();
    try {
      expect(
        await Promise.race([
          outcomes[cancelled],
          new Promise((resolve) => setTimeout(() => resolve('still waiting'), 100)),
        ]),
      ).toBe('AbortError');
      expect(networkSignal.aborted).toBe(false);
    } finally {
      finish({ items: [first] });
    }
    expect(await outcomes[1 - cancelled]).toBe('completed');
  });
  it('treats an unmapped image called constructor as a relative URL', () => {
    expect(
      chapterResources({ kind: 'html', html: '<img src="constructor">', resources: {} }, first),
    ).toEqual([
      { id: 'https://source.example/constructor', url: 'https://source.example/constructor' },
    ]);
  });
  it('does not replace an old directory when a later pagination request fails', async () => {
    memory.call.mockResolvedValueOnce({ items: [first] });
    expect(await listSourceChapters(ref)).toHaveLength(1);
    memory.call
      .mockResolvedValueOnce({ items: [{ id: 'b', title: 'B' }], nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('server unavailable'));
    await expect(listSourceChapters(ref, { refresh: true })).rejects.toThrow('server unavailable');
    expect((await listSourceChapters(ref)).map((chapter) => chapter.id)).toEqual(['a']);
  });
  it('reads a complete chapter and image after the plugin and temporary cache are removed', async () => {
    memory.call.mockImplementation(async (operation: string) => {
      if (operation === 'source.getChapters') return { items: [first] };
      if (operation === 'source.resolveChapter')
        return {
          kind: 'html',
          html: '<p>Offline text</p><img src="https://source.example/image.png">',
        };
      if (operation === 'source.resolveResource')
        return { url: 'https://source.example/image.png', mimeType: 'image/png' };
      throw new Error('Unexpected operation');
    });
    memory.request.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/png' },
      bytes: new Uint8Array([137, 80, 78, 71]),
    });
    await downloadSourceChapters(ref, ['a']);
    memory.read.mockClear();
    expect(await sourceChapterDownloaded(ref, 'a')).toBe(true);
    expect(memory.read.mock.calls).toHaveLength(1);
    expect(memory.read.mock.calls[0]![0]).toMatch(/^source-download:.*:status$/);
    memory.offline = true;
    memory.cache.clear();
    memory.call.mockClear();
    expect((await resolveSourceChapter(ref, first)).kind).toBe('html');
    const image = await loadSourceResource(
      ref,
      { id: 'https://source.example/image.png', url: 'https://source.example/image.png' },
      first,
    );
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(memory.call).not.toHaveBeenCalled();
    const stored = [...memory.records.entries()].find(([key]) =>
      key.startsWith('source-download-bytes:'),
    )![1] as Uint8Array;
    stored[0] = 0;
    await expect(
      loadSourceResource(ref, { id: 'https://source.example/image.png' }, first),
    ).rejects.toThrow(/integrity/);
    await removeSourceDownloadedChapter(ref, first.id);
    expect(await sourceChapterDownloaded(ref, first.id)).toBe(false);
    expect([...memory.records.keys()].some((key) => key.startsWith('source-download'))).toBe(false);
    expect(await listSourceChapters(ref)).toHaveLength(1);
  });
  it('does not mark a chapter downloaded when a resource fails', async () => {
    memory.call.mockImplementation(async (operation: string) =>
      operation === 'source.getChapters'
        ? { items: [first] }
        : operation === 'source.resolveChapter'
          ? { kind: 'pages', pages: [{ id: 'p', url: 'https://source.example/p' }] }
          : { url: 'https://source.example/p' },
    );
    memory.request.mockRejectedValue(new Error('network disconnected'));
    await expect(downloadSourceChapters(ref, ['a'])).rejects.toThrow('network disconnected');
    expect(await sourceChapterDownloaded(ref, 'a')).toBe(false);
  });
  it('retains and removes resources whose stable IDs match JavaScript prototype keys', async () => {
    memory.call.mockImplementation(async (operation: string) =>
      operation === 'source.getChapters'
        ? { items: [first] }
        : operation === 'source.resolveChapter'
          ? { kind: 'pages', pages: [{ id: '__proto__', url: 'https://source.example/page' }] }
          : { url: 'https://source.example/page' },
    );
    memory.request.mockResolvedValue({
      status: 200,
      headers: {},
      bytes: new Uint8Array([1, 2, 3]),
    });
    await downloadSourceChapters(ref, ['a']);
    // IndexedDB stores a structured clone, which never retains a custom prototype.
    for (const [key, value] of memory.records) memory.records.set(key, structuredClone(value));
    memory.offline = true;
    memory.cache.clear();
    const page = await loadSourceResource(ref, { id: '__proto__' }, first);
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    await removeSourceDownloadedChapter(ref, 'a');
    expect([...memory.records.keys()].some((key) => key.startsWith('source-download'))).toBe(false);
  });
  it('serializes concurrent favorites so both works survive the library save', async () => {
    memory.call.mockImplementation(
      async (_operation: string, { work }: { work: SourceBookRef['work'] }) => work,
    );
    let finishFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const appService = { saveLibraryBooks: vi.fn(async () => {}) };
    appService.saveLibraryBooks.mockImplementationOnce(() => firstSave);
    const adding = [
      addSourceWork(appService, ref.instanceId, ref.work),
      addSourceWork(appService, ref.instanceId, { ...ref.work, id: 'second', title: 'Second' }),
    ];
    await vi.waitFor(() => expect(appService.saveLibraryBooks).toHaveBeenCalledTimes(1));
    finishFirst();
    await Promise.all(adding);
    expect(memory.library.map((book) => book.title).sort()).toEqual(['Book', 'Second']);
    expect(appService.saveLibraryBooks).toHaveBeenLastCalledWith(memory.library);
  });
});
