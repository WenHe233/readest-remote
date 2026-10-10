import type { ReadingPosition } from '@readest/plugin-sdk';
import type { Book, BookProgress } from '@/types/book';
import type { BookDoc } from '@/libs/document';
import type { FoliateView } from '@/types/view';
import { getXPointerFromCFI, getCFIFromXPointer, normalizeProgressXPointer } from '@/utils/xcfi';
import { getExternalSource } from './bookSource';
import { getLibraryRuntime } from './manager';
import { listPluginRecords, readPluginRecord, writePluginRecords } from './persistence';
export interface SavedPluginProgress {
  position: ReadingPosition;
  pending: boolean;
}
export const getSavedPluginProgress = (hash: string) =>
  readPluginRecord<SavedPluginProgress>('progress:' + hash);
export const savePluginProgress = (hash: string, position: ReadingPosition, pending: boolean) =>
  writePluginRecords({ ['progress:' + hash]: { position, pending } });
export function progressDecision(
  local: ReadingPosition | null,
  remote: ReadingPosition | null,
): 'local' | 'remote' | 'ask' | 'none' {
  if (!remote) return local ? 'local' : 'none';
  if (!local) return 'remote';
  const sameAnchor =
    local.kind === 'epub' &&
    remote.kind === 'epub' &&
    ((!!local.xpath && local.xpath === remote.xpath) ||
      (!!local.href &&
        local.href === remote.href &&
        !!local.fragment &&
        local.fragment === remote.fragment) ||
      (!!local.cfi && local.cfi === remote.cfi));
  const different =
    local.kind === 'page' && remote.kind === 'page'
      ? local.pageIndex !== remote.pageIndex
      : !sameAnchor && Math.abs(local.fraction - remote.fraction) > 0.01;
  if (different && (remote.approximate || remote.modified > local.modified)) return 'ask';
  if (remote.approximate && !local.approximate) return 'local';
  return remote.modified > local.modified ? 'remote' : 'local';
}
function selector(element: Element | null): string | undefined {
  if (!element) return;
  const parts: string[] = [];
  for (
    let node: Element | null = element;
    node && node.tagName.toLowerCase() !== 'html';
    node = node.parentElement
  ) {
    if (node.id) {
      parts.unshift('#' + CSS.escape(node.id));
      break;
    }
    const name = node.tagName.toLowerCase();
    const siblings = Array.from(node.parentElement?.children ?? []).filter(
      (e) => e.tagName === node!.tagName,
    );
    parts.unshift(
      name + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''),
    );
  }
  return parts.join(' > ');
}
export async function capturePluginPosition(
  book: Book,
  doc: BookDoc,
  progress: BookProgress,
  view: FoliateView,
): Promise<ReadingPosition> {
  const fraction = Math.min(1, Math.max(0, progress.fraction));
  const modified = Date.now();
  if (book.format !== 'EPUB')
    return { kind: 'page', pageIndex: progress.index, fraction, modified, cfi: progress.location };
  const pointer = await getXPointerFromCFI(
    progress.location,
    progress.range?.startContainer?.ownerDocument ?? undefined,
    progress.index,
    doc,
  );
  const boundaries = view.getSectionFractions();
  const start = boundaries[progress.index] ?? 0,
    end = boundaries[progress.index + 1] ?? 1;
  const node = progress.range?.startContainer;
  const element =
    node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
  return {
    kind: 'epub',
    cfi: progress.location,
    href: doc.sections[progress.index]?.id || progress.sectionHref,
    spineIndex: progress.index,
    xpath: normalizeProgressXPointer(pointer.xpointer),
    fragment: selector(element),
    sectionProgress: Math.max(0, Math.min(1, (fraction - start) / Math.max(0.000001, end - start))),
    fraction,
    modified,
  };
}
export async function resolvePluginPosition(
  position: ReadingPosition,
  doc: BookDoc,
  view: FoliateView,
): Promise<ReadingPosition> {
  if (position.kind === 'page') {
    const requested =
      position.pageIndex ?? Math.round(position.fraction * Math.max(0, doc.sections.length - 1));
    const pageIndex = Math.max(0, Math.min(doc.sections.length - 1, requested));
    // Fixed-layout readers navigate by page directly. They do not always have
    // an EPUB CFI progress resolver, and that must not downgrade an exact page.
    return {
      ...position,
      pageIndex,
      cfi: undefined,
      approximate: position.pageIndex === undefined || pageIndex !== requested,
    };
  }
  let cfi = position.cfi;
  let index = position.spineIndex;
  try {
    if (position.xpath) {
      if (position.xpath.startsWith('/body/DocFragment['))
        cfi = await getCFIFromXPointer(position.xpath, undefined, undefined, doc);
      else if (index !== undefined && doc.sections[index]) {
        const section = await doc.sections[index]!.createDocument();
        // Server web readers also save element XPath expressions such as
        // id("chapter-heading"). These are scoped by the supplied spine index.
        const id = position.xpath.match(/^id\(\s*(['"])(.*?)\1\s*\)$/u)?.[2];
        const node =
          id !== undefined
            ? section.getElementById(id)
            : section.evaluate(
                position.xpath,
                section,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null,
              ).singleNodeValue;
        if (node) {
          const range = section.createRange();
          range.selectNodeContents(node);
          range.collapse(true);
          cfi = view.getCFI(index, range);
        }
      }
    } else if (position.href) {
      const clean = (href: string) =>
        decodeURIComponent(href.split('#')[0] ?? '').replace(/^\//u, '');
      index = doc.sections.findIndex((s) => clean(s.id) === clean(position.href!));
      if (index >= 0 && position.fragment) {
        const section = await doc.sections[index]!.createDocument();
        const node = section.querySelector(position.fragment);
        if (node) {
          const range = section.createRange();
          range.selectNodeContents(node);
          range.collapse(true);
          cfi = view.getCFI(index, range);
        }
      }
      if (index < 0) index = undefined;
    }
    if (cfi) {
      const result = await view.getCFIProgress(cfi);
      if (result)
        return {
          ...position,
          cfi,
          fraction: result.fraction,
          approximate: false,
          spineIndex: index ?? position.spineIndex,
        };
    }
  } catch {
    /* A missing anchor is surfaced as approximate in the conflict dialog. */
  }
  if (index !== undefined) {
    const fractions = view.getSectionFractions();
    const start = fractions[index] ?? 0,
      end = fractions[index + 1] ?? 1;
    return {
      ...position,
      cfi: undefined,
      spineIndex: index,
      fraction: start + (end - start) * (position.sectionProgress ?? 0),
      approximate: true,
    };
  }
  return { ...position, cfi: undefined, approximate: true };
}
const pushes = new Map<string, Promise<void>>();
export async function pushPluginPosition(book: Book, position: ReadingPosition): Promise<void> {
  const source = getExternalSource(book);
  if (!source) return;
  await savePluginProgress(book.hash, position, true);
  const job = (pushes.get(book.hash) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const saved = await getSavedPluginProgress(book.hash);
      if (!saved?.pending) return;
      const latest = saved.position;
      const target = await getLibraryRuntime(source.connectionId);
      if (
        target.connection.pluginId !== source.pluginId ||
        target.connection.fingerprint !== source.fingerprint
      )
        throw new Error('Book source does not match its connection');
      await target.runtime.call(
        'library.pushProgress',
        {
          context: target.lease.context,
          book: source.item,
          progress: latest,
        },
        { signal: AbortSignal.timeout(30_000) },
      );
      const current = await getSavedPluginProgress(book.hash);
      if (current?.position.modified === latest.modified && current.position.cfi === latest.cfi)
        await savePluginProgress(book.hash, latest, false);
    });
  pushes.set(book.hash, job);
  try {
    await job;
  } finally {
    if (pushes.get(book.hash) === job) pushes.delete(book.hash);
  }
}

/** Retry closed-book queues after checking the server. Open books use their conflict dialog. */
export async function retryQueuedPluginProgress(
  books: Book[],
  openHashes: Set<string>,
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const { key, value } of await listPluginRecords<SavedPluginProgress>('progress:')) {
    const hash = key.slice('progress:'.length);
    if (!value.pending || openHashes.has(hash)) continue;
    const book = books.find((b) => b.hash === hash && !b.deletedAt);
    const source = book && getExternalSource(book);
    if (!book || !source) continue;
    try {
      const target = await getLibraryRuntime(source.connectionId);
      if (
        target.connection.pluginId !== source.pluginId ||
        target.connection.fingerprint !== source.fingerprint
      )
        continue;
      const remote = await target.runtime.call(
        'library.pullProgress',
        { context: target.lease.context, book: source.item },
        { signal: AbortSignal.timeout(30_000) },
      );
      const current = await getSavedPluginProgress(hash);
      if (!current?.pending || JSON.stringify(current.position) !== JSON.stringify(value.position))
        continue;
      const decision = progressDecision(value.position, remote);
      if (decision === 'ask' || decision === 'remote') {
        conflicts.push(book.title);
        continue;
      }
      await pushPluginPosition(book, value.position);
    } catch {
      /* Leave the queue intact while the source is unavailable. */
    }
  }
  return conflicts;
}
