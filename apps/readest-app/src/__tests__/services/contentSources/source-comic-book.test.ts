import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSourceBook, restoreSourceLocator } from '@/services/contentSources/sourceBook';
import type { SourceBookRef, ChapterEntry } from '@/services/contentSources/catalog';
import type { ResourceRef } from '@readest/plugin-sdk';

const ref = {
  instanceId: 'one',
  work: { id: 'comic', kind: 'comic', title: 'Comic' },
} as SourceBookRef;
const chapters: ChapterEntry[] = [
  { id: 'a', title: 'Chapter A', slot: 4 },
  { id: 'b', title: 'Chapter B', slot: 9 },
];
const documents: ReturnType<typeof makeSourceBook>[] = [];
function fixture() {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const loadChapter = vi.fn(async (chapter: ChapterEntry) => ({
    kind: 'pages' as const,
    pages:
      chapter.id === 'a' ? [{ id: 'first' }, { id: 'second' }, { id: 'third' }] : [{ id: 'last' }],
  }));
  const loadResource = vi.fn(
    async (_resource: ResourceRef, _chapter: ChapterEntry, _signal: AbortSignal) =>
      new Blob(['image'], { type: 'image/png' }),
  );
  const doc = makeSourceBook(ref, chapters, loadChapter, loadResource);
  documents.push(doc);
  return { doc, loadChapter, loadResource };
}
afterEach(() => {
  documents.splice(0).forEach((doc) => doc.destroy?.());
  vi.restoreAllMocks();
});
describe('network comic document', () => {
  it('cancels an obsolete chapter lookup before starting the next chapter', async () => {
    let oldSignal!: AbortSignal;
    const load = vi.fn(async (chapter: ChapterEntry, signal: AbortSignal) => {
      if (chapter.id === 'a') {
        oldSignal = signal;
        return new Promise<never>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      expect(oldSignal.aborted).toBe(true);
      return { kind: 'pages' as const, pages: [{ id: 'next' }] };
    });
    const doc = makeSourceBook(ref, chapters, load, async () => new Blob());
    documents.push(doc);
    const old = doc.prepareNavigation!(String(chapters[0]!.slot));
    const cancelled = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    doc.cancelPendingLoads?.();
    await cancelled;
    await doc.prepareNavigation!(String(chapters[1]!.slot));
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('keeps a shared chapter lookup alive for reading-position restoration', async () => {
    let coreSignal!: AbortSignal;
    let finish!: () => void;
    const load = vi.fn((_chapter: ChapterEntry, signal: AbortSignal) => {
      coreSignal = signal;
      return new Promise<{ kind: 'pages'; pages: ResourceRef[] }>((resolve) => {
        finish = () => resolve({ kind: 'pages', pages: [{ id: 'one' }] });
      });
    });
    const doc = makeSourceBook(ref, chapters, load, async () => new Blob());
    documents.push(doc);
    const navigating = doc.prepareNavigation!('4');
    const cancelled = expect(navigating).rejects.toMatchObject({ name: 'AbortError' });
    const restoring = restoreSourceLocator(doc, {
      workId: 'comic',
      chapterId: 'a',
      pageIndex: 0,
      modified: 1,
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    doc.cancelPendingLoads?.();
    await cancelled;
    expect(coreSignal.aborted).toBe(false);
    finish();
    expect((await restoring)?.cfi).toBe(doc.sections[0]!.cfi);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('aborts chapter lookups and restoration subscribers when the book closes', async () => {
    let signal!: AbortSignal;
    const load = vi.fn((_chapter: ChapterEntry, current: AbortSignal) => {
      signal = current;
      return new Promise<never>((_resolve, reject) =>
        current.addEventListener('abort', () => reject(current.reason), { once: true }),
      );
    });
    const doc = makeSourceBook(ref, chapters, load, async () => new Blob());
    documents.push(doc);
    const restoring = restoreSourceLocator(doc, { workId: 'comic', chapterId: 'a', modified: 1 });
    const cancelled = expect(restoring).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await doc.destroy?.();
    await cancelled;
    expect(signal.aborted).toBe(true);
  });
  it('uses the existing fixed-layout viewer and loads one image, not the complete chapter', async () => {
    const { doc, loadChapter, loadResource } = fixture();
    expect(doc.rendition.layout).toBe('pre-paginated');
    await doc.sections[0]!.load();
    expect(loadChapter).toHaveBeenCalledTimes(1);
    expect(loadResource).toHaveBeenCalledTimes(1);
    expect(doc.sections).toHaveLength(4);
    await doc.sections[1]!.load();
    expect(loadChapter).toHaveBeenCalledTimes(1);
    expect(loadResource).toHaveBeenCalledTimes(2);
  });
  it('restores old chapter/page locators without resolving unrelated chapters', async () => {
    const { doc, loadChapter } = fixture();
    const restored = await restoreSourceLocator(doc, {
      workId: 'comic',
      chapterId: 'a',
      pageIndex: 1,
      modified: 1,
    });
    expect(restored?.cfi).toBe(doc.sections[1]?.cfi);
    expect(loadChapter).toHaveBeenCalledTimes(1);
  });
  it('preloads the selected number of image bytes without creating image URLs', async () => {
    const { doc, loadResource } = fixture();
    await doc.sections[0]!.load();
    const urls = vi.mocked(URL.createObjectURL).mock.calls.length;
    doc.onVisibleSection?.(0);
    await vi.waitFor(() => expect(loadResource).toHaveBeenCalledTimes(3));
    expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBe(urls);
    doc.setPreloadPages?.(0);
    doc.onVisibleSection?.(1);
    await Promise.resolve();
    expect(loadResource).toHaveBeenCalledTimes(3);
  });
  it('limits concurrency and aborts prefetch when a foreground page is requested', async () => {
    const { doc, loadResource } = fixture();
    await doc.sections[0]!.load();
    const pending: Array<{ signal: AbortSignal; resolve: (blob: Blob) => void }> = [];
    loadResource.mockImplementation(
      (_resource, _chapter, signal) => new Promise((resolve) => pending.push({ signal, resolve })),
    );
    doc.setPreloadPages?.(5);
    doc.onVisibleSection?.(0);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const loading = doc.sections[1]!.load();
    expect(pending[0]!.signal.aborted).toBe(false);
    expect(pending[1]!.signal.aborted).toBe(true);
    pending[0]!.resolve(new Blob(['image']));
    await loading;
    await doc.destroy?.();
    expect(pending.slice(1).every((request) => request.signal.aborted)).toBe(true);
  });
  it('uses stable resource identities when pages were inserted and migrates bookmarks lazily', async () => {
    const { doc, loadChapter } = fixture();
    const old = 'epubcfi(/6/10!/4/2)';
    const restored = vi.fn();
    doc.registerLocator?.(
      old,
      { workId: 'comic', chapterId: 'a', resourceId: 'third', pageIndex: 0, modified: 1 },
      restored,
    );
    expect(loadChapter).not.toHaveBeenCalled();
    await doc.prepareNavigation?.(old);
    expect(restored).toHaveBeenCalledWith(doc.sections[2]!.cfi);
    expect(doc.resolveCFI?.(old)?.index).toBe(2);
    expect(doc.getSourceProgress?.(2)).toEqual({
      chapter: 1,
      chapters: 2,
      page: 3,
      pages: 3,
      complete: false,
    });
  });
  it('cancels an unloaded page and never creates a Blob URL from its late response', async () => {
    const { doc, loadResource } = fixture();
    let finish!: (blob: Blob) => void;
    loadResource.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = doc.sections[0]!;
    const loading = first.load();
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(loadResource).toHaveBeenCalledTimes(1));
    first.unload();
    await rejected;
    finish(new Blob(['late']));
    await Promise.resolve();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
