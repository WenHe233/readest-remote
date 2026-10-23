import type { ChapterContent, ReadingLocator, ResourceRef } from '@readest/plugin-sdk';
import { CFI, type BookDoc, type SectionItem } from '@/libs/document';
import { sanitizeHtml } from '@/utils/sanitize';
import type { SourceBookRef, ChapterEntry } from './catalog';
import { makeSourceComicBook } from './sourceComicBook';

export interface SourceBookDocument extends BookDoc {
  sourceReference: SourceBookRef;
  sourceChapters: ChapterEntry[];
  sections: LazySection[];
  resolveHref(href: string): { index: number } | null;
  getTOCFragment(document: Document, id?: string): Element | null;
  registerLocator?(cfi: string, locator: ReadingLocator, restored: (cfi: string) => void): void;
  restoreLocator?(
    locator: ReadingLocator,
  ): Promise<{ cfi: string; approximate: boolean } | undefined>;
  getSourceLocator?(index: number): ReadingLocator | undefined;
  getSourceProgress?(
    index: number,
  ):
    | { chapter: number; chapters: number; page: number; pages: number; complete: boolean }
    | undefined;
  setPreloadPages?(pages: number): void;
  onVisibleSection?(index: number): void;
  retrySection?(target: string | number): Promise<void>;
}
export type LazySection = SectionItem & {
  load(): Promise<string>;
  loadContent(): Promise<string>;
  unload(): void;
};
const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Chapter order is presentation-only. Persistent slots are the CFI identity. */
export function makeSourceBook(
  ref: SourceBookRef,
  chapters: ChapterEntry[],
  loadChapter: (chapter: ChapterEntry, signal: AbortSignal) => Promise<ChapterContent>,
  loadResource: (
    resource: ResourceRef,
    chapter: ChapterEntry,
    signal: AbortSignal,
  ) => Promise<Blob>,
  invalidateResource?: (resource: ResourceRef, chapter: ChapterEntry) => Promise<void>,
): SourceBookDocument {
  if (ref.work.kind === 'comic')
    return makeSourceComicBook(ref, chapters, loadChapter, loadResource, invalidateResource);
  let destroyed = false;
  const transformTarget = new EventTarget();
  const sections: LazySection[] = chapters.map((chapter) => {
    type LoadedSection = {
      controller: AbortController;
      urls: Set<string>;
      html?: Promise<string>;
      url?: string;
      transformed?: Promise<string>;
    };
    let loaded: LoadedSection | undefined;
    const state = (): LoadedSection => {
      if (destroyed) throw new DOMException('Book was closed', 'AbortError');
      return (loaded ??= { controller: new AbortController(), urls: new Set() });
    };
    const release = (current: LoadedSection) => {
      current.controller.abort();
      for (const url of current.urls) URL.revokeObjectURL(url);
      current.urls.clear();
      if (loaded === current) loaded = undefined;
    };
    const ownedUrl = (current: LoadedSection, blob: Blob): string => {
      current.controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      current.urls.add(url);
      return url;
    };
    const chapterHtml = (current: LoadedSection): Promise<string> => {
      return (current.html ??= (async () => {
        const { signal } = current.controller;
        signal.throwIfAborted();
        const content = await loadChapter(chapter, signal);
        signal.throwIfAborted();
        const template = document.createElement('template');
        // Template contents are inert: DOMParser on HTML containing src may start network requests.
        template.innerHTML = sanitizeHtml(
          content.kind === 'html'
            ? content.html
            : content.pages.map((_, i) => `<img src="page-${i}" alt="${i + 1}">`).join(''),
        );
        const mappings =
          content.kind === 'html'
            ? (content.resources ?? {})
            : Object.fromEntries(content.pages.map((resource, i) => [`page-${i}`, resource]));
        for (const image of template.content.querySelectorAll('img')) {
          const source = image.getAttribute('src');
          image.removeAttribute('src');
          if (!source) continue;
          let resource = Object.hasOwn(mappings, source) ? mappings[source] : undefined;
          if (!resource) {
            try {
              const url = new URL(source, chapter.url);
              if (!['http:', 'https:'].includes(url.protocol)) continue;
              resource = { id: url.href, url: url.href };
            } catch {
              continue;
            }
          }
          const blob = await loadResource(resource, chapter, signal);
          image.setAttribute('src', ownedUrl(current, blob));
        }
        const serializer = new XMLSerializer();
        const body = [...template.content.childNodes]
          .map((node) => serializer.serializeToString(node))
          .join('');
        return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'"/><style>img{max-width:100%;height:auto}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid currentColor}</style></head><body><h1>${escapeHtml(chapter.title)}</h1>${body}</body></html>`;
      })().catch((error: unknown) => {
        release(current);
        throw error;
      }));
    };
    return {
      id: String(chapter.slot),
      href: String(chapter.slot),
      cfi: CFI.fake.fromIndex(chapter.slot),
      // A stable estimate avoids downloading every chapter just to measure its text.
      size: 4096,
      linear: chapter.removed ? 'no' : 'yes',
      async load() {
        const current = state();
        const html = await chapterHtml(current);
        current.controller.signal.throwIfAborted();
        return (current.url ??= ownedUrl(
          current,
          new Blob([html], { type: 'application/xhtml+xml' }),
        ));
      },
      loadContent() {
        const current = state();
        return (current.transformed ??= chapterHtml(current)
          .then(async (html) => {
            current.controller.signal.throwIfAborted();
            const detail = {
              data: html as string | Promise<string>,
              type: 'application/xhtml+xml',
              name: String(chapter.slot),
            };
            transformTarget.dispatchEvent(new CustomEvent('data', { detail }));
            const transformed = await detail.data;
            current.controller.signal.throwIfAborted();
            return transformed || html;
          })
          .catch((error: unknown) => {
            current.transformed = undefined;
            throw error;
          }));
      },
      unload() {
        if (loaded) release(loaded);
      },
      loadText: () => chapterHtml(state()),
      createDocument: async () =>
        new DOMParser().parseFromString(await chapterHtml(state()), 'application/xhtml+xml'),
    };
  });
  const doc = {
    sourceReference: ref,
    sourceChapters: chapters,
    metadata: {
      title: ref.work.title,
      author: ref.work.author,
      language: ref.work.language ?? '',
      identifier: `source:${ref.instanceId}:${ref.work.id}`,
    },
    rendition: { layout: 'reflowable' as const },
    dir: 'ltr',
    transformTarget,
    sections,
    toc: chapters
      .filter((chapter) => !chapter.removed)
      .map((chapter) => ({ label: chapter.title, href: String(chapter.slot) })),
    splitTOCHref: (href: string) => href.split('#'),
    getTOCFragment: (document: Document, id: string) => document.getElementById(id),
    resolveHref: (href: string) => {
      const [slot, fragment] = href.split('#');
      const index = sections.findIndex((section) => section.id === slot);
      return index < 0
        ? null
        : {
            index,
            anchor: (document: Document) => (fragment ? document.getElementById(fragment) : null),
          };
    },
    resolveCFI: (cfi: string) => {
      try {
        const parts = CFI.parse(cfi);
        const slot = CFI.fake.toIndex((parts.parent ?? parts).shift());
        const index = sections.findIndex((section) => section.id === String(slot));
        return index < 0
          ? null
          : { index, anchor: (document: Document) => CFI.toRange(document, parts) };
      } catch {
        return null;
      }
    },
    isExternal: (href: string) => /^(https?|mailto):/i.test(href),
    getCover: async () =>
      ref.work.cover ? (await import('./covers')).loadSourceCover(ref).catch(() => null) : null,
    destroy() {
      destroyed = true;
      for (const section of sections) section.unload();
    },
  };
  return doc as unknown as SourceBookDocument;
}

export async function openSourceBookDoc(ref: SourceBookRef): Promise<SourceBookDocument> {
  const catalog = await import('./catalog');
  const chapters = await catalog.listSourceChapters(ref);
  return makeSourceBook(
    ref,
    chapters,
    (chapter, signal) => catalog.resolveSourceChapter(ref, chapter, signal),
    (resource, chapter, signal) => catalog.loadSourceResource(ref, resource, chapter, signal),
    (resource, chapter) => catalog.invalidateSourceResource(ref, resource, chapter),
  );
}

export function captureSourceTextAnchor(range: Range): ReadingLocator['text'] {
  const document = range.startContainer.ownerDocument;
  if (!document?.body) return undefined;
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(document.body);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const text = document.body.textContent ?? '';
  const start = prefixRange.toString().length;
  return {
    exact: text.slice(start, start + 160),
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(start + 160, start + 192),
  };
}

export async function restoreSourceLocator(
  doc: SourceBookDocument,
  locator: ReadingLocator,
): Promise<{ cfi: string; approximate: boolean } | undefined> {
  if (locator.workId !== doc.sourceReference.work.id) return;
  if (doc.restoreLocator) return doc.restoreLocator(locator);
  const index = doc.sourceChapters.findIndex((chapter) => chapter.id === locator.chapterId);
  const section = doc.sections[index];
  if (!section) return;
  if (!locator.text?.exact) return { cfi: locator.cfi ?? section.cfi, approximate: false };
  const document = await section.createDocument();
  const full = document.body.textContent ?? '';
  const candidates: number[] = [];
  for (
    let pos = full.indexOf(locator.text.exact);
    pos >= 0;
    pos = full.indexOf(locator.text.exact, pos + 1)
  )
    candidates.push(pos);
  const start =
    candidates.find(
      (position) =>
        !locator.text?.prefix ||
        full.slice(Math.max(0, position - locator.text.prefix.length), position) ===
          locator.text.prefix,
    ) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (start === undefined) return { cfi: section.cfi, approximate: true };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node: Node | null;
  const range = document.createRange();
  let started = false;
  const end = start + locator.text.exact.length;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      break;
    }
    offset += length;
  }
  return { cfi: CFI.joinIndir(section.cfi, CFI.fromRange(range)), approximate: false };
}
