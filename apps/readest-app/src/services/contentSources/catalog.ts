import { create } from 'zustand';
import { z } from 'zod';
import {
  chapterContentSchema,
  workSchema,
  type Work,
  type Chapter,
  type ChapterContent,
  type ResourceRef,
} from '@readest/plugin-sdk';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { useLibraryStore } from '@/store/libraryStore';
import { md5 } from '@/utils/md5';
import { sanitizeHtml } from '@/utils/sanitize';
import { readPluginRecord, writePluginRecords } from '../plugins/persistence';
import { cacheKey, clearContentCache, readContentCache, writeContentCache } from '../plugins/cache';
import { getSourceInstance, loadSourceInstances } from './instances';
import { getSourceRuntime } from './runtime';
import { normalizeSourceError, SourceOperationError } from './errors';
import type { SourceCoverHost } from './covers';
import { publishSourceSearchRevision, sourceSearchRevisionKey } from './searchRevision';
import { reconcileSourceChapters, type ChapterEntry } from './catalogState';
export type { ChapterEntry } from './catalogState';

const refSchema = z.object({
  instanceId: z.string().uuid(),
  pluginId: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  work: workSchema,
});
export type SourceBookRef = z.infer<typeof refSchema>;
export const sourceBookHash = (instanceId: string, workId: string) =>
  md5(JSON.stringify(['content-source', instanceId, workId]));
export function getSourceBookRef(book: Book): SourceBookRef | undefined {
  const value = refSchema.safeParse(book.sourceBook ?? book.metadata?.['sourceBook']);
  return value.success ? value.data : undefined;
}
interface Directory {
  entries: ChapterEntry[];
  checkedAt: number;
  work: Work;
}
interface StoredResource {
  key: string;
  mime: string;
  digest: string;
  size?: number;
}
interface DownloadedChapter {
  content: ChapterContent;
  contentDigest: string;
  resources: Record<string, StoredResource>;
  completedAt: number;
}
interface StagedChapter extends Omit<DownloadedChapter, 'completedAt'> {
  updatedAt: number;
}
const directoryKey = (ref: SourceBookRef) =>
  `source-directory:${sourceBookHash(ref.instanceId, ref.work.id)}`;
const downloadedKey = (ref: SourceBookRef, chapterId: string) =>
  `source-download:${sourceBookHash(ref.instanceId, ref.work.id)}:${md5(chapterId)}`;
interface DirectoryScan {
  promise: Promise<ChapterEntry[]>;
  controller: AbortController;
  subscribers: Set<symbol>;
}
const scans = new Map<string, DirectoryScan>();

function subscribeToDirectory(scan: DirectoryScan, signal?: AbortSignal): Promise<ChapterEntry[]> {
  const subscriber = Symbol();
  scan.subscribers.add(subscriber);
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      scan.subscribers.delete(subscriber);
      if (!scan.subscribers.size) scan.controller.abort();
      return true;
    };
    const cancel = () => {
      if (release()) reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    scan.promise.then(
      (entries) => {
        if (release()) resolve(entries);
      },
      (error: unknown) => {
        if (release()) reject(error);
      },
    );
    if (signal?.aborted) cancel();
  });
}
const libraryWrites = new WeakMap<object, Promise<unknown>>();
// Persistent slots and deletion markers belong to the host, outside the public RPC contract.
const providerChapter = ({ id, title, url, revision, group, data }: Chapter): Chapter => ({
  id,
  title,
  url,
  revision,
  group,
  data,
});
const digest = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');

async function checkedRuntime(ref: SourceBookRef) {
  const target = await getSourceRuntime(ref.instanceId);
  if (target.instance.pluginId !== ref.pluginId || target.instance.fingerprint !== ref.fingerprint)
    throw new Error('Book source ownership changed.');
  return target;
}
export async function listSourceChapters(
  ref: SourceBookRef,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<ChapterEntry[]> {
  options.signal?.throwIfAborted();
  const key = directoryKey(ref);
  const previous = await readPluginRecord<Directory>(key);
  options.signal?.throwIfAborted();
  if (!options.refresh && previous) return previous.entries;
  const running = scans.get(key);
  if (running && !running.controller.signal.aborted)
    return subscribeToDirectory(running, options.signal);
  const controller = new AbortController();
  const scan: DirectoryScan = {
    controller,
    subscribers: new Set(),
    promise: (async () => {
      const target = await checkedRuntime(ref);
      let cursor: string | undefined;
      const cursors = new Set<string>();
      const chapters: Chapter[] = [];
      for (let page = 0; page < 1000; page++) {
        controller.signal.throwIfAborted();
        const result = await target.call(
          'source.getChapters',
          { work: ref.work, cursor },
          controller.signal,
        );
        chapters.push(...result.items);
        if (chapters.length > 100000)
          throw new Error('Source directory exceeds the chapter limit.');
        if (result.nextCursor === undefined) {
          if (!chapters.length) throw new Error('The source returned an empty chapter directory.');
          const entries = reconcileSourceChapters(previous?.entries ?? [], chapters);
          controller.signal.throwIfAborted();
          await writePluginRecords({
            [key]: { entries, checkedAt: Date.now(), work: ref.work } satisfies Directory,
          });
          if (options.refresh) await clearContentCache(sourceBookHash(ref.instanceId, ref.work.id));
          return entries;
        }
        if (!result.nextCursor || cursors.has(result.nextCursor))
          throw new Error('Source directory pagination did not advance.');
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error('Source directory did not finish.');
    })().finally(() => {
      if (scans.get(key) === scan) scans.delete(key);
    }),
  };
  scans.set(key, scan);
  return subscribeToDirectory(scan, options.signal);
}

export async function addSourceWork(
  appService: Pick<AppService, 'saveLibraryBooks'> & Partial<SourceCoverHost>,
  instanceId: string,
  input: Work,
): Promise<Book> {
  await loadSourceInstances();
  const instance = getSourceInstance(instanceId);
  if (!instance) throw new Error('Source instance is unavailable.');
  const target = await getSourceRuntime(instanceId);
  const work = await target.call('source.getWork', { work: input });
  const hash = sourceBookHash(instanceId, input.id);
  if (work.id !== input.id) throw new Error('Source changed the work ID while loading details.');
  const save = (libraryWrites.get(appService) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const old = useLibraryStore.getState().getBookByHash(hash);
      const sourceBook: SourceBookRef = {
        instanceId,
        pluginId: instance.pluginId,
        fingerprint: instance.fingerprint,
        work,
      };
      const book: Book = {
        ...old,
        hash,
        format: work.kind === 'comic' ? 'SOURCE_COMIC' : 'SOURCE_TEXT',
        sourceBook,
        title: old?.metadataUpdatedAt ? old.title : work.title,
        author: old?.metadataUpdatedAt ? old.author : work.author,
        tags: old?.metadataUpdatedAt ? old.tags : work.tags,
        primaryLanguage: work.language,
        metadata: {
          ...old?.metadata,
          title: work.title,
          author: work.author,
          language: work.language ?? old?.metadata?.language ?? '',
          description: work.description,
          identifier: `readest-source:${hash}`,
          sourceBook,
        },
        createdAt: old?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
      };
      const books = [
        book,
        ...useLibraryStore.getState().library.filter((item) => item.hash !== hash),
      ];
      await appService.saveLibraryBooks(books);
      useLibraryStore.getState().setLibrary(books);
      return book;
    });
  libraryWrites.set(appService, save);
  try {
    const book = await save;
    if (
      appService.exists &&
      appService.createDir &&
      appService.writeFile &&
      appService.generateCoverImageUrl
    ) {
      // A missing image must not prevent the work from being added to the library.
      void import('./covers')
        .then(({ ensureSourceCover }) => ensureSourceCover(appService as SourceCoverHost, book))
        .catch(() => {});
    }
    return book;
  } finally {
    if (libraryWrites.get(appService) === save) libraryWrites.delete(appService);
  }
}

export async function sourceChapterDownloaded(
  ref: SourceBookRef,
  chapterId: string,
): Promise<boolean> {
  return !!(
    await readPluginRecord<{ completedAt: number }>(downloadedKey(ref, chapterId) + ':status')
  )?.completedAt;
}
export async function resolveSourceChapter(
  ref: SourceBookRef,
  chapter: Chapter,
  signal?: AbortSignal,
): Promise<ChapterContent> {
  signal?.throwIfAborted();
  const pinned = await readPluginRecord<DownloadedChapter>(downloadedKey(ref, chapter.id));
  if (pinned) {
    if (
      (await digest(new TextEncoder().encode(JSON.stringify(pinned.content)))) !==
      pinned.contentDigest
    )
      throw new Error(
        'Downloaded chapter failed its integrity check. Remove its download and download it again.',
      );
    return chapterContentSchema.parse(pinned.content);
  }
  const key = await cacheKey(
    sourceBookHash(ref.instanceId, ref.work.id),
    chapter.revision ?? '',
    `chapter:${chapter.id}`,
  );
  const cached = await readContentCache(key);
  if (cached) return chapterContentSchema.parse(JSON.parse(new TextDecoder().decode(cached.bytes)));
  const target = await checkedRuntime(ref);
  const content = await target.call(
    'source.resolveChapter',
    { work: ref.work, chapter: providerChapter(chapter) },
    signal,
  );
  if (
    (content.kind === 'html' && !content.html.trim()) ||
    (content.kind === 'pages' && !content.pages.length)
  )
    throw new Error('The source returned empty chapter content.');
  if (content.kind === 'html') content.html = sanitizeHtml(content.html);
  await writeContentCache(
    key,
    new TextEncoder().encode(JSON.stringify(content)),
    'application/json',
  );
  return content;
}

export async function loadSourceResource(
  ref: SourceBookRef,
  resource: ResourceRef,
  chapter?: Chapter,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  if (chapter) {
    const pinned = await readPluginRecord<DownloadedChapter>(downloadedKey(ref, chapter.id));
    const saved =
      pinned && Object.hasOwn(pinned.resources, resource.id)
        ? pinned.resources[resource.id]
        : undefined;
    if (saved) {
      const bytes = await readPluginRecord<Uint8Array>(saved.key);
      if (!bytes || (await digest(bytes)) !== saved.digest)
        throw new Error(
          'Downloaded resource failed its integrity check. Remove its download and download it again.',
        );
      return new Blob([new Uint8Array(bytes)], { type: saved.mime });
    }
    if (pinned) throw new Error('This resource is not available in the downloaded chapter.');
  }
  const key = await cacheKey(
    sourceBookHash(ref.instanceId, ref.work.id),
    chapter?.revision ?? ref.work.revision ?? '',
    `resource:${chapter?.id ?? 'cover'}:${resource.id}`,
  );
  const cached = await readContentCache(key);
  if (cached) return new Blob([new Uint8Array(cached.bytes)], { type: cached.mime });
  const target = await checkedRuntime(ref);
  for (let attempt = 0; attempt < 2; attempt++) {
    const resolved = await target.call(
      'source.resolveResource',
      { work: ref.work, chapter: chapter && providerChapter(chapter), resource },
      signal,
    );
    const response = await target.lease.request(
      { instance: target.lease.context.instance, url: resolved.url, headers: resolved.headers },
      signal,
    );
    if ([401, 403, 404, 410].includes(response.status) && attempt === 0) continue;
    if (response.status < 200 || response.status >= 300)
      throw new SourceOperationError('SOURCE_HTTP_STATUS', 'resource', { status: response.status });
    const mime =
      resolved.mimeType ??
      response.headers['content-type']?.split(';')[0] ??
      'application/octet-stream';
    await writeContentCache(key, response.bytes, mime);
    return new Blob([new Uint8Array(response.bytes)], { type: mime });
  }
  throw new Error('Source resource could not be refreshed.');
}

/** Retry a failed render without deleting an explicitly downloaded chapter. */
export async function invalidateSourceResource(
  ref: SourceBookRef,
  resource: ResourceRef,
  chapter?: Chapter,
): Promise<void> {
  const key = await cacheKey(
    sourceBookHash(ref.instanceId, ref.work.id),
    chapter?.revision ?? ref.work.revision ?? '',
    `resource:${chapter?.id ?? 'cover'}:${resource.id}`,
  );
  await writePluginRecords({}, ['cache-meta:' + key, 'cache-data:' + key]);
}

export function chapterResources(content: ChapterContent, chapter: Chapter): ResourceRef[] {
  if (content.kind === 'pages') return content.pages;
  const resources = new Map<string, ResourceRef>();
  for (const resource of Object.values(content.resources ?? {}))
    resources.set(resource.id, resource);
  // Template contents are inert; discovery must not start requests outside the broker.
  const template = document.createElement('template');
  template.innerHTML = sanitizeHtml(content.html);
  for (const image of template.content.querySelectorAll('img[src]')) {
    const source = image.getAttribute('src')!;
    if (source.startsWith('data:')) continue;
    const mapped =
      content.resources && Object.hasOwn(content.resources, source)
        ? content.resources[source]
        : undefined;
    if (mapped) {
      resources.set(mapped.id, mapped);
      continue;
    }
    try {
      const url = new URL(source, chapter.url).href;
      resources.set(url, { id: url, url });
    } catch {
      throw new Error('A chapter image has no resolvable resource URL.');
    }
  }
  return [...resources.values()];
}

export interface SourceDownloadProgress {
  completed: number;
  total: number;
  chapterId?: string;
  phase: 'downloading' | 'completed' | 'cancelled' | 'failed';
  error?: string;
  resourcesCompleted?: number;
  resourcesTotal?: number;
}
export const useSourceDownloads = create<{ tasks: Record<string, SourceDownloadProgress> }>(() => ({
  tasks: {},
}));
export async function downloadSourceChapters(
  ref: SourceBookRef,
  chapterIds: string[],
  signal?: AbortSignal,
  onProgress?: (progress: SourceDownloadProgress) => void,
): Promise<void> {
  const entries = await listSourceChapters(ref, { signal });
  const selected = chapterIds.map((id) => {
    const chapter = entries.find((item) => item.id === id);
    if (!chapter) throw new Error('Chapter is missing from the saved directory.');
    return chapter;
  });
  const progress: SourceDownloadProgress = {
    completed: 0,
    total: selected.length,
    phase: 'downloading',
  };
  const report = () => {
    const snapshot = { ...progress };
    useSourceDownloads.setState((state) => ({
      tasks: { ...state.tasks, [sourceBookHash(ref.instanceId, ref.work.id)]: snapshot },
    }));
    onProgress?.(snapshot);
  };
  report();
  try {
    for (const chapter of selected) {
      signal?.throwIfAborted();
      progress.chapterId = chapter.id;
      report();
      if (!(await sourceChapterDownloaded(ref, chapter.id))) {
        const content = await resolveSourceChapter(ref, chapter, signal);
        const contentDigest = await digest(new TextEncoder().encode(JSON.stringify(content)));
        const key = downloadedKey(ref, chapter.id);
        const stagingKey = key.replace('source-download:', 'source-download-stage:');
        const previous = await readPluginRecord<StagedChapter>(stagingKey);
        const resources: Record<string, StoredResource> = Object.create(null);
        if (previous?.contentDigest === contentDigest) Object.assign(resources, previous.resources);
        const pending = chapterResources(content, chapter);
        progress.resourcesCompleted = 0;
        progress.resourcesTotal = pending.length;
        // A changed chapter cannot inherit checkpoints from an older body.
        if (previous && previous.contentDigest !== contentDigest) {
          await writePluginRecords({}, [
            stagingKey,
            ...Object.values(previous.resources).map((resource) => resource.key),
          ]);
        }
        for (const resource of pending) {
          signal?.throwIfAborted();
          const saved =
            previous?.contentDigest === contentDigest &&
            Object.hasOwn(previous.resources, resource.id)
              ? previous.resources[resource.id]
              : undefined;
          if (saved) {
            const bytes = await readPluginRecord<Uint8Array>(saved.key);
            if (bytes && (await digest(bytes)) === saved.digest) {
              resources[resource.id] = { ...saved, size: bytes.byteLength };
              progress.resourcesCompleted!++;
              report();
              continue;
            }
          }
          const blob = await loadSourceResource(ref, resource, chapter, signal);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const resourceKey = `source-download-bytes:${sourceBookHash(ref.instanceId, ref.work.id)}:${md5(chapter.id)}:${md5(resource.id)}`;
          resources[resource.id] = {
            key: resourceKey,
            mime: blob.type,
            digest: await digest(bytes),
            size: bytes.byteLength,
          };
          signal?.throwIfAborted();
          // Persist one resource at a time. Both the bytes and checkpoint are
          // atomic, so suspension never advertises an uncommitted resource.
          await writePluginRecords({
            [resourceKey]: bytes,
            [stagingKey]: {
              content,
              contentDigest,
              resources: { ...resources },
              updatedAt: Date.now(),
            } satisfies StagedChapter,
          });
          progress.resourcesCompleted!++;
          report();
        }
        signal?.throwIfAborted();
        const completedAt = Date.now();
        const bookHash = sourceBookHash(ref.instanceId, ref.work.id);
        const searchRevision = crypto.randomUUID();
        // Publish the completion marker only when all checkpoints are durable.
        await writePluginRecords(
          {
            [sourceSearchRevisionKey(bookHash)]: searchRevision,
            [key + ':status']: { completedAt },
            [key]: {
              content,
              contentDigest,
              resources,
              completedAt,
            } satisfies DownloadedChapter,
          },
          [stagingKey],
        );
        publishSourceSearchRevision(bookHash, searchRevision);
      }
      progress.completed++;
      report();
    }
    progress.phase = 'completed';
    report();
  } catch (error) {
    progress.phase = signal?.aborted ? 'cancelled' : 'failed';
    progress.error = normalizeSourceError(error, 'download').code;
    report();
    throw error;
  }
}
export async function removeSourceDownloadedChapter(
  ref: SourceBookRef,
  chapterId: string,
): Promise<void> {
  const key = downloadedKey(ref, chapterId);
  const chapter = await readPluginRecord<DownloadedChapter>(key);
  const stagingKey = key.replace('source-download:', 'source-download-stage:');
  const staged = await readPluginRecord<StagedChapter>(stagingKey);
  const bookHash = sourceBookHash(ref.instanceId, ref.work.id);
  const searchRevision = crypto.randomUUID();
  await writePluginRecords({ [sourceSearchRevisionKey(bookHash)]: searchRevision }, [
    key,
    key + ':status',
    stagingKey,
    ...Object.values(chapter?.resources ?? {}).map((resource) => resource.key),
    ...Object.values(staged?.resources ?? {}).map((resource) => resource.key),
  ]);
  publishSourceSearchRevision(bookHash, searchRevision);
}
