import type { RemoteBook } from '@readest/plugin-sdk';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import { useLibraryStore } from '@/store/libraryStore';
import { md5 } from '@/utils/md5';
import { getCoverFilename, getDir } from '@/utils/book';
import { getExternalSource } from './bookSource';
import { getLibraryRuntime, loadPluginManager, findInstalledPlugin } from './manager';
import { loadPluginConnections, usePluginConnections } from './connections';
import { readBoundedBody } from './httpBroker';
import { readPluginRecord, writePluginRecords } from './persistence';
import type { PluginConnection } from './types';
import { create } from 'zustand';
import { anySignal } from '@/utils/abort';

export interface ExternalLibrarySyncTask {
  phase: 'catalog' | 'covers' | 'completed' | 'failed' | 'cancelled';
  books: number;
  covers: number;
  totalCovers: number;
  error?: string;
}
export const useExternalLibrarySync = create<{ tasks: Record<string, ExternalLibrarySyncTask> }>(
  () => ({ tasks: {} }),
);
const syncing = new Map<string, Promise<number>>();
const controllers = new Map<string, AbortController>();
export const cancelExternalLibrarySync = (id: string): void => controllers.get(id)?.abort();
const setTask = (id: string, task: ExternalLibrarySyncTask) =>
  useExternalLibrarySync.setState((state) => ({ tasks: { ...state.tasks, [id]: task } }));

type CoverUpdate = Pick<Book, 'hash' | 'coverImageUrl' | 'coverDownloadedAt'>;
const applyCovers = (updates: Map<string, CoverUpdate>) => {
  if (!updates.size) return;
  useLibraryStore.getState().setLibrary(
    useLibraryStore.getState().library.map((book) => {
      const update = updates.get(book.hash);
      return update && !book.coverUpdatedAt ? { ...book, ...update } : book;
    }),
  );
  updates.clear();
};
export function reconcileExternalCatalog(
  connection: PluginConnection,
  items: RemoteBook[],
  library: Book[],
  now = Date.now(),
): Book[] {
  const merged = new Map(library.map((b) => [b.hash, b]));
  const seen = new Set<string>();
  for (const item of items) {
    const hash = md5(
      [
        'plugin',
        connection.pluginId,
        connection.fingerprint,
        connection.id,
        connection.sourceId,
        item.id,
      ].join(':'),
    );
    seen.add(hash);
    const old = merged.get(hash);
    const source = {
      pluginId: connection.pluginId,
      fingerprint: connection.fingerprint,
      sourceId: connection.sourceId,
      connectionId: connection.id,
      item,
    };
    const keep = !!old?.metadataUpdatedAt;
    const book: Book = {
      ...old,
      hash,
      format: item.format,
      title: keep ? old!.title : item.title,
      author: keep ? old!.author : item.author,
      tags: keep ? old!.tags : item.tags,
      primaryLanguage: keep ? old!.primaryLanguage : item.language,
      sourceTitle: item.title,
      externalSource: source,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    };
    book.metadata = {
      ...(keep
        ? old?.metadata
        : {
            title: item.title,
            author: item.author,
            language: item.language ?? '',
            description: item.description,
            series: item.series,
          }),
      title: book.title,
      author: book.author,
      language: book.primaryLanguage ?? '',
      externalSource: source,
    };
    if (
      old &&
      JSON.stringify({ ...old, updatedAt: 0 }) === JSON.stringify({ ...book, updatedAt: 0 })
    )
      book.updatedAt = old.updatedAt;
    merged.set(hash, book);
  }
  for (const book of library) {
    const source = getExternalSource(book);
    if (source?.connectionId !== connection.id || seen.has(book.hash)) continue;
    const missing = { ...source, unavailable: true };
    merged.set(book.hash, {
      ...book,
      externalSource: missing,
      metadata: book.metadata ? { ...book.metadata, externalSource: missing } : undefined,
    });
  }
  return [...merged.values()];
}
export async function fetchExternalCover(
  app: AppService,
  book: Book,
  signal?: AbortSignal,
  onCover?: (update: CoverUpdate) => void,
): Promise<void> {
  signal?.throwIfAborted();
  const source = getExternalSource(book);
  if (!source) return;
  const publishCover = async () => {
    const current = useLibraryStore.getState().getBookByHash(book.hash);
    if (!current) return;
    const url = await app.generateCoverImageUrl(current);
    signal?.throwIfAborted();
    const update = { hash: book.hash, coverImageUrl: url, coverDownloadedAt: Date.now() };
    if (onCover) onCover(update);
    else applyCovers(new Map([[book.hash, update]]));
  };
  const versionKey = 'cover-revision:' + book.hash;
  if (await app.exists(getCoverFilename(book), 'Books')) {
    if (
      book.coverUpdatedAt ||
      (await readPluginRecord<string>(versionKey)) === source.item.revision
    ) {
      // A cancelled batch may have saved the file before publishing its URL.
      if (!book.coverImageUrl) await publishCover();
      return;
    }
  }
  const target = await getLibraryRuntime(source.connectionId);
  const abort = anySignal(signal, AbortSignal.timeout(30_000));
  const resource = await target.runtime
    .call(
      'library.getCover',
      { context: target.lease.context, book: source.item },
      { signal: abort.signal },
    )
    .finally(abort.cleanup);
  signal?.throwIfAborted();
  if (!resource) return;
  const response = await target.lease.request(
    {
      ...resource,
      connection: target.lease.context.connection,
    },
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel();
    return;
  }
  const mime = response.headers.get('content-type') ?? '';
  if (!/^image\/(jpeg|png|webp|gif)/iu.test(mime)) {
    await response.body?.cancel();
    return;
  }
  const bytes = await readBoundedBody(response, 8 * 1024 * 1024);
  signal?.throwIfAborted();
  if (useLibraryStore.getState().getBookByHash(book.hash)?.coverUpdatedAt) return;
  await app.createDir(getDir(book), 'Books', true);
  signal?.throwIfAborted();
  await app.writeFile(getCoverFilename(book), 'Books', new Uint8Array(bytes).buffer);
  await writePluginRecords({ [versionKey]: source.item.revision });
  await publishCover();
}
export function syncExternalLibrary(app: AppService, connectionId: string): Promise<number> {
  const running = syncing.get(connectionId);
  if (running) {
    // A connection edit cancels its previous lease. Queue the replacement
    // behind cleanup instead of returning that cancelled job to Save.
    return controllers.get(connectionId)?.signal.aborted
      ? running.catch(() => {}).then(() => syncExternalLibrary(app, connectionId))
      : running;
  }
  const controller = new AbortController();
  controllers.set(connectionId, controller);
  const connection = usePluginConnections.getState().connections.find((c) => c.id === connectionId);
  const unsubscribe = usePluginConnections.subscribe((state) => {
    if (state.connections.find((c) => c.id === connectionId) !== connection) controller.abort();
  });
  const task: ExternalLibrarySyncTask = { phase: 'catalog', books: 0, covers: 0, totalCovers: 0 };
  const publish = () => setTask(connectionId, { ...task });
  publish();
  const updates = new Map<string, CoverUpdate>();
  let coverTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(coverTimer);
    coverTimer = undefined;
    if (!controller.signal.aborted) applyCovers(updates);
    else updates.clear();
  };
  const queueCover = (update: CoverUpdate) => {
    updates.set(update.hash, update);
    coverTimer ??= setTimeout(flush, 150);
  };
  const job = (async () => {
    try {
      const target = await getLibraryRuntime(connectionId);
      controller.signal.throwIfAborted();
      if (!target.connection.libraryIds.length) return 0;
      const items: RemoteBook[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100000; page++) {
        controller.signal.throwIfAborted();
        const abort = anySignal(controller.signal, AbortSignal.timeout(60_000));
        const result = await target.runtime
          .call(
            'library.syncCatalog',
            { context: target.lease.context, libraryIds: target.connection.libraryIds, cursor },
            { signal: abort.signal },
          )
          .finally(abort.cleanup);
        controller.signal.throwIfAborted();
        if (result.books.some((b) => !target.connection.libraryIds.includes(b.libraryId)))
          throw new Error('Plugin returned a book outside selected libraries');
        items.push(...result.books);
        task.books = items.length;
        publish();
        if (items.length > 100000) throw new Error('Catalog exceeds book limit');
        if (result.complete) break;
        if (!result.nextCursor || cursors.has(result.nextCursor))
          throw new Error('Plugin catalog cursor did not advance');
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
        if (page === 99999) throw new Error('Catalog did not complete');
      }
      // Re-read the live library after the final await to retain edits made while
      // the server was scanning. Never commit removals after a partial scan.
      const books = reconcileExternalCatalog(
        target.connection,
        items,
        useLibraryStore.getState().library,
      );
      useLibraryStore.getState().setLibrary(books);
      await app.saveLibraryBooks(books);
      controller.signal.throwIfAborted();
      await writePluginRecords({ [`catalog-checked:${connectionId}`]: Date.now() });
      // Covers are small API resources; no EPUB is opened to populate the shelf.
      let next = 0;
      const owned = books.filter(
        (b) =>
          getExternalSource(b)?.connectionId === connectionId && !getExternalSource(b)?.unavailable,
      );
      task.phase = 'covers';
      task.totalCovers = owned.length;
      publish();
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < owned.length) {
            if (controller.signal.aborted) return;
            const book = owned[next++]!;
            try {
              await fetchExternalCover(app, book, controller.signal, queueCover);
            } catch {
              /* Missing covers do not invalidate a completed catalog. */
            }
            task.covers++;
            publish();
          }
        }),
      );
      controller.signal.throwIfAborted();
      flush();
      await app.saveLibraryBooks(useLibraryStore.getState().library);
      controller.signal.throwIfAborted();
      return items.length;
    } catch (error) {
      task.phase = controller.signal.aborted ? 'cancelled' : 'failed';
      if (!controller.signal.aborted)
        task.error = error instanceof Error ? error.message : 'Library sync failed';
      publish();
      if (controller.signal.aborted) throw new DOMException('Library sync cancelled', 'AbortError');
      throw error;
    } finally {
      clearTimeout(coverTimer);
      updates.clear();
      unsubscribe();
      controllers.delete(connectionId);
    }
  })();
  const completed = job
    .then((count) => {
      task.phase = 'completed';
      publish();
      return count;
    })
    .finally(() => {
      syncing.delete(connectionId);
    });
  syncing.set(connectionId, completed);
  return completed;
}
export async function syncExternalLibraries(app: AppService): Promise<void> {
  await Promise.all([loadPluginManager(), loadPluginConnections()]);
  for (const connection of usePluginConnections.getState().connections) {
    if (connection.deletedAt || !findInstalledPlugin(connection.pluginId)?.enabled) continue;
    try {
      await syncExternalLibrary(app, connection.id);
    } catch (error) {
      console.warn(
        'External library sync failed',
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }
}
