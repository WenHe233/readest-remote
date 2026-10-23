import type { ChapterContent, ReadingLocator, ResourceRef } from '@readest/plugin-sdk';
import { CFI, type BookDoc, type TOCItem } from '@/libs/document';
import { openPageStreamBook } from '@/libs/pageStream';
import { md5 } from '@/utils/md5';
import type { SourceBookRef, ChapterEntry } from './catalog';
import type { LazySection, SourceBookDocument } from './sourceBook';

type ChapterLoader = (chapter: ChapterEntry, signal: AbortSignal) => Promise<ChapterContent>;
type ResourceLoader = (
  resource: ResourceRef,
  chapter: ChapterEntry,
  signal: AbortSignal,
) => Promise<Blob>;
type PageSection = LazySection & {
  chapter: ChapterEntry;
  pageIndex: number;
  resource?: ResourceRef;
  pendingChapter?: boolean;
};
type Request = {
  key: string;
  controller: AbortController;
  foreground: boolean;
  run: () => Promise<Blob>;
  promise: Promise<Blob>;
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
};
type ChapterLookup = {
  promise: Promise<void>;
  controller: AbortController;
  subscribers: Set<symbol>;
  settled: boolean;
};

/** Only descriptors grow with the directory. Images are owned by the existing FXL section lifecycle. */
export function makeSourceComicBook(
  ref: SourceBookRef,
  chapters: ChapterEntry[],
  loadChapter: ChapterLoader,
  loadResource: ResourceLoader,
  invalidateResource?: (resource: ResourceRef, chapter: ChapterEntry) => Promise<void>,
): SourceBookDocument {
  const lifetime = new AbortController();
  const changes = new EventTarget();
  const chapterLoads = new Map<string, ChapterLookup>();
  let navigation = new AbortController();
  let preloading = new AbortController();
  const contents = new Map<string, ResourceRef[]>();
  const comicBooks: BookDoc[] = [];
  const savedLocators = new Map<
    string,
    { locator: ReadingLocator; restored: (cfi: string) => void }
  >();
  const aliases = new Map<string, string>();
  const requests = new Map<string, Request>();
  const queue: Request[] = [];
  let active = 0;
  let preloadPages = 2;
  let generation = 0;
  let visible: PageSection | undefined;
  const abortError = () => new DOMException('Reading operation cancelled', 'AbortError');
  const pageCFI = (chapter: ChapterEntry, page: number, resource?: ResourceRef) =>
    CFI.joinIndir(
      CFI.fake.fromIndex(chapter.slot),
      `/4/${(page + 1) * 2}${resource ? `[source-${md5(resource.id)}]` : ''}`,
    );
  const keyOf = (chapter: ChapterEntry, resource: ResourceRef) =>
    JSON.stringify([chapter.id, resource.id]);
  const pump = () => {
    while (active < 2 && queue.length) {
      queue.sort((a, b) => Number(b.foreground) - Number(a.foreground));
      const request = queue.shift()!;
      if (request.controller.signal.aborted) continue;
      active++;
      const cancelled = new Promise<never>((_, reject) => {
        request.controller.signal.addEventListener('abort', () => reject(abortError()), {
          once: true,
        });
      });
      void Promise.race([request.run(), cancelled])
        .then(request.resolve, request.reject)
        .finally(() => {
          if (requests.get(request.key) === request) requests.delete(request.key);
          active--;
          pump();
        });
    }
  };
  const cancelPreloads = (keep?: string) => {
    for (const request of requests.values()) {
      if (!request.foreground && request.key !== keep) {
        request.controller.abort();
        request.reject(abortError());
        requests.delete(request.key);
      }
    }
  };
  const requestImage = (
    chapter: ChapterEntry,
    resource: ResourceRef,
    foreground: boolean,
    signal?: AbortSignal,
  ) => {
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    const key = keyOf(chapter, resource);
    if (foreground) cancelPreloads(key);
    let request = requests.get(key);
    if (!request) {
      const controller = new AbortController();
      let resolve!: Request['resolve'];
      let reject!: Request['reject'];
      const promise = new Promise<Blob>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      request = {
        key,
        controller,
        foreground,
        promise,
        resolve,
        reject,
        run: () => loadResource(resource, chapter, controller.signal),
      };
      requests.set(key, request);
      queue.push(request);
    }
    if (foreground) request.foreground = true;
    const current = request;
    const cancel = () => {
      current.controller.abort();
      current.reject(abortError());
    };
    signal?.addEventListener('abort', cancel, { once: true });
    pump();
    return current.promise.finally(() => signal?.removeEventListener('abort', cancel));
  };
  const makePlaceholder = (chapter: ChapterEntry): PageSection => {
    const section: PageSection = {
      chapter,
      pageIndex: 0,
      pendingChapter: true,
      id: `${chapter.slot}:0`,
      href: String(chapter.slot),
      cfi: pageCFI(chapter, 0),
      size: 1,
      linear: chapter.removed ? 'no' : 'yes',
      async load() {
        await ensureChapter(chapter);
        return section.load();
      },
      async loadContent() {
        await ensureChapter(chapter);
        return section.loadContent();
      },
      async createDocument() {
        await ensureChapter(chapter);
        return section.createDocument();
      },
      unload() {},
    };
    return section;
  };
  const sections: PageSection[] = chapters
    .filter((chapter) => !chapter.removed)
    .map(makePlaceholder);
  const subscribe = (lookup: ChapterLookup, signal: AbortSignal): Promise<void> => {
    const subscriber = Symbol();
    lookup.subscribers.add(subscriber);
    return new Promise((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener('abort', cancel);
        lookup.subscribers.delete(subscriber);
        if (!lookup.settled && !lookup.subscribers.size) lookup.controller.abort();
        return true;
      };
      const cancel = () => {
        if (release()) reject(signal.reason ?? abortError());
      };
      signal.addEventListener('abort', cancel, { once: true });
      lookup.promise.then(
        () => {
          if (release()) resolve();
        },
        (error: unknown) => {
          if (release()) reject(error);
        },
      );
      if (signal.aborted) cancel();
    });
  };
  const ensureChapter = (
    chapter: ChapterEntry,
    signal: AbortSignal = navigation.signal,
  ): Promise<void> => {
    lifetime.signal.throwIfAborted();
    signal.throwIfAborted();
    if (contents.has(chapter.id)) return Promise.resolve();
    const running = chapterLoads.get(chapter.id);
    if (running && !running.controller.signal.aborted) return subscribe(running, signal);
    const controller = new AbortController();
    const abort = () => controller.abort(lifetime.signal.reason);
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const operation = (async () => {
      const content = await loadChapter(chapter, controller.signal);
      controller.signal.throwIfAborted();
      if (content.kind !== 'pages' || !content.pages.length)
        throw new Error('SOURCE_CONTENT_INVALID');
      const controllers = new Map<number, AbortController>();
      const { book } = await openPageStreamBook(
        { count: content.pages.length, title: chapter.title, author: ref.work.author ?? '' },
        (index) =>
          requestImage(chapter, content.pages[index]!, true, controllers.get(index)?.signal),
        {},
      );
      controller.signal.throwIfAborted();
      comicBooks.push(book);
      const first =
        sections.find((section) => section.chapter.id === chapter.id) ?? makePlaceholder(chapter);
      const pages = book.sections.map((raw, pageIndex): PageSection => {
        const original = raw as LazySection;
        let loading: Promise<string> | undefined;
        let url: string | undefined;
        const section: PageSection = pageIndex === 0 ? first : makePlaceholder(chapter);
        Object.assign(section, {
          chapter,
          pageIndex,
          resource: content.pages[pageIndex],
          pendingChapter: false,
          id: `${chapter.slot}:${pageIndex}`,
          href: `${chapter.slot}#${pageIndex}`,
          cfi: pageCFI(chapter, pageIndex, content.pages[pageIndex]),
          async load() {
            lifetime.signal.throwIfAborted();
            if (url) return url;
            if (loading) return loading;
            const controller = new AbortController();
            controllers.set(pageIndex, controller);
            loading = original
              .load()
              .then((loaded) => {
                if (controller.signal.aborted || lifetime.signal.aborted) {
                  original.unload();
                  throw abortError();
                }
                section.pageSpread = original.pageSpread;
                return (url = loaded);
              })
              .finally(() => {
                loading = undefined;
              });
            return loading;
          },
          async loadContent() {
            return (await fetch(await section.load())).text();
          },
          async createDocument() {
            return new DOMParser().parseFromString(await section.loadContent(), 'text/html');
          },
          unload() {
            controllers.get(pageIndex)?.abort();
            controllers.delete(pageIndex);
            original.unload();
            url = undefined;
          },
        });
        return section;
      });
      contents.set(chapter.id, content.pages);
      const existingIndex = sections.indexOf(first);
      if (existingIndex >= 0) sections.splice(existingIndex, 1, ...pages);
      else {
        // Removed chapters remain addressable from saved locations/downloads, but
        // do not enter the normal reading order until explicitly opened.
        const next = sections.findIndex(
          (section) => chapters.indexOf(section.chapter) > chapters.indexOf(chapter),
        );
        sections.splice(next < 0 ? sections.length : next, 0, ...pages);
      }
      changes.dispatchEvent(new Event('sectionschange'));
    })().finally(() => {
      lookup.settled = true;
      lifetime.signal.removeEventListener('abort', abort);
      if (chapterLoads.get(chapter.id) === lookup) chapterLoads.delete(chapter.id);
    });
    const lookup: ChapterLookup = {
      promise: operation,
      controller,
      subscribers: new Set(),
      settled: false,
    };
    chapterLoads.set(chapter.id, lookup);
    return subscribe(lookup, signal);
  };
  const prefetch = async (section: PageSection) => {
    const currentGeneration = ++generation;
    preloading.abort();
    preloading = new AbortController();
    const signal = preloading.signal;
    cancelPreloads();
    if (!preloadPages || !section.resource) return;
    let remaining = preloadPages;
    let index = sections.indexOf(section) + 1;
    let nextChapterPrepared = false;
    while (remaining > 0 && index < sections.length) {
      if (lifetime.signal.aborted || currentGeneration !== generation) return;
      let next = sections[index]!;
      if (next.chapter.removed) {
        index++;
        continue;
      }
      if (next.pendingChapter) {
        if (nextChapterPrepared) break;
        nextChapterPrepared = true;
        await ensureChapter(next.chapter, signal);
        if (lifetime.signal.aborted || currentGeneration !== generation) return;
        next = sections[index]!;
      }
      if (next.resource) {
        void requestImage(next.chapter, next.resource, false).catch(() => {});
        remaining--;
      }
      index++;
    }
  };
  const resolveCFI = (cfi: string) => {
    cfi = aliases.get(cfi) ?? cfi;
    const resolved = (index: number) => ({
      index,
      anchor: (document: Document) => {
        if (cfi.split('!').length > 2) return CFI.toRange(document, CFI.parse(cfi));
        const range = document.createRange();
        range.selectNode(document.querySelector('img') ?? document.body);
        return range;
      },
    });
    let index = sections.findIndex((section) => section.cfi === cfi);
    if (index >= 0) return resolved(index);
    // x1 stored chapter-slot CFIs with a synthetic page element. Keep these readable.
    const match = /^epubcfi\(\/6\/(\d+)(?:!\/4\/(\d+))?/.exec(cfi);
    if (!match) return null;
    const slot = Number(match[1]) / 2 - 1;
    const page = Math.max(0, Number(match[2] ?? 2) / 2 - 1);
    const resourceHash = /\[source-([a-f0-9]{32})\]/.exec(cfi)?.[1];
    if (resourceHash) {
      index = sections.findIndex(
        (section) =>
          section.chapter.slot === slot &&
          section.resource &&
          md5(section.resource.id) === resourceHash,
      );
      if (index >= 0) return resolved(index);
    }
    index = sections.findIndex(
      (section) => section.chapter.slot === slot && section.pageIndex === page,
    );
    if (index < 0) index = sections.findIndex((section) => section.chapter.slot === slot);
    return index < 0 ? null : resolved(index);
  };
  const restoreLocator = async (locator: ReadingLocator, signal: AbortSignal) => {
    if (locator.workId !== ref.work.id) return;
    const chapter = chapters.find((item) => item.id === locator.chapterId);
    if (!chapter) return;
    await ensureChapter(chapter, signal);
    const pages = contents.get(chapter.id)!;
    const byId = locator.resourceId
      ? pages.findIndex((page) => page.id === locator.resourceId)
      : -1;
    const page = Math.min(byId >= 0 ? byId : (locator.pageIndex ?? 0), pages.length - 1);
    return {
      cfi: pageCFI(chapter, page, pages[page]),
      approximate: (!!locator.resourceId && byId < 0) || (locator.pageIndex ?? 0) >= pages.length,
    };
  };
  const doc: SourceBookDocument = {
    sourceReference: ref,
    sourceChapters: chapters,
    sections,
    metadata: {
      title: ref.work.title,
      author: ref.work.author,
      language: ref.work.language ?? '',
      identifier: `source:${ref.instanceId}:${ref.work.id}`,
    },
    rendition: { layout: 'pre-paginated' },
    dir: 'ltr',
    sectionsTarget: changes,
    // FXL still renders its visible window; byte prefetch is owned by the source scheduler.
    networkStreaming: true,
    cancelPendingLoads() {
      generation++;
      navigation.abort();
      navigation = new AbortController();
      preloading.abort();
      preloading = new AbortController();
      for (const request of requests.values()) {
        request.controller.abort();
        request.reject(abortError());
      }
      requests.clear();
      queue.length = 0;
    },
    toc: chapters
      .filter((chapter) => !chapter.removed)
      .map(
        (chapter, id) =>
          ({ id, index: id, label: chapter.title, href: String(chapter.slot) }) satisfies TOCItem,
      ),
    splitTOCHref: (href) => [href.split('#')[0]! + ':0', href.split('#')[1] ?? ''],
    getTOCFragment: (document: Document) => document.documentElement,
    resolveHref(href: string) {
      const [slot, page = '0'] = href.split('#');
      const index = sections.findIndex(
        (section) =>
          section.chapter.slot === Number(slot) &&
          (section.pendingChapter || section.pageIndex === Number(page)),
      );
      return index < 0 ? null : { index };
    },
    resolveCFI,
    async prepareNavigation(target: string | number) {
      if (typeof target !== 'string' && typeof target !== 'number') return;
      const signal = navigation.signal;
      signal.throwIfAborted();
      const saved = typeof target === 'string' ? savedLocators.get(target) : undefined;
      if (saved) {
        const restored = await restoreLocator(saved.locator, signal);
        signal.throwIfAborted();
        if (restored) {
          aliases.set(String(target), restored.cfi);
          saved.restored(restored.cfi);
        }
      }
      const resolved =
        typeof target === 'number'
          ? { index: target }
          : CFI.isCFI.test(target)
            ? resolveCFI(target)
            : doc.resolveHref?.(target);
      const section = resolved ? sections[resolved.index] : undefined;
      if (section?.pendingChapter) await ensureChapter(section.chapter, signal);
    },
    registerLocator(cfi, locator, restored) {
      savedLocators.set(cfi, { locator, restored });
    },
    async retrySection(target) {
      const resolved =
        typeof target === 'number'
          ? { index: target }
          : CFI.isCFI.test(target)
            ? resolveCFI(target)
            : doc.resolveHref(target);
      const section = resolved ? sections[resolved.index] : undefined;
      section?.unload();
      if (section?.resource) await invalidateResource?.(section.resource, section.chapter);
    },
    restoreLocator(locator) {
      return restoreLocator(locator, lifetime.signal);
    },
    getSourceLocator(index) {
      const section = sections[index];
      if (!section?.resource) return;
      return {
        workId: ref.work.id,
        chapterId: section.chapter.id,
        resourceId: section.resource.id,
        pageIndex: section.pageIndex,
        cfi: section.cfi,
        modified: Date.now(),
      };
    },
    getSourceProgress(index) {
      const section = sections[index];
      const pages = section && contents.get(section.chapter.id);
      if (!section || !pages) return;
      const active = chapters.filter((chapter) => !chapter.removed);
      const chapterIndex = active.findIndex((chapter) => chapter.id === section.chapter.id);
      return {
        chapter: chapterIndex + 1,
        chapters: active.length,
        page: section.pageIndex + 1,
        pages: pages.length,
        complete: chapterIndex === active.length - 1 && section.pageIndex === pages.length - 1,
      };
    },
    setPreloadPages(value) {
      preloadPages = [0, 2, 5, 10].includes(value) ? value : 2;
      if (visible) void prefetch(visible).catch(() => {});
    },
    onVisibleSection(index) {
      const section = sections[index];
      if (!section?.resource || visible === section) return;
      visible = section;
      void prefetch(section).catch(() => {});
    },
    getCover: async () =>
      ref.work.cover
        ? (await import('./covers')).loadSourceCover(ref, lifetime.signal).catch(() => null)
        : null,
    destroy() {
      lifetime.abort();
      navigation.abort();
      preloading.abort();
      generation++;
      for (const request of requests.values()) {
        request.controller.abort();
        request.reject(abortError());
      }
      requests.clear();
      queue.length = 0;
      for (const section of sections) section.unload();
      for (const book of comicBooks) void book.destroy?.();
    },
  };
  return doc;
}
