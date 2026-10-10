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
const syncing = new Map<string, Promise<number>>();
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
export async function fetchExternalCover(app: AppService, book: Book): Promise<void> {
  const source = getExternalSource(book);
  if (!source) return;
  const versionKey = 'cover-revision:' + book.hash;
  if (await app.exists(getCoverFilename(book), 'Books')) {
    if (
      book.coverUpdatedAt ||
      (await readPluginRecord<string>(versionKey)) === source.item.revision
    )
      return;
  }
  const target = await getLibraryRuntime(source.connectionId);
  const resource = await target.runtime.call(
    'library.getCover',
    { context: target.lease.context, book: source.item },
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!resource) return;
  const response = await target.lease.request({
    ...resource,
    connection: target.lease.context.connection,
  });
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
  await app.createDir(getDir(book), 'Books', true);
  await app.writeFile(getCoverFilename(book), 'Books', new Uint8Array(bytes).buffer);
  await writePluginRecords({ [versionKey]: source.item.revision });
  const current = useLibraryStore.getState().getBookByHash(book.hash);
  if (current) {
    const url = await app.generateCoverImageUrl(current);
    useLibraryStore
      .getState()
      .setLibrary(
        useLibraryStore
          .getState()
          .library.map((b) =>
            b.hash === book.hash ? { ...b, coverImageUrl: url, coverDownloadedAt: Date.now() } : b,
          ),
      );
  }
}
export async function syncExternalLibrary(app: AppService, connectionId: string): Promise<number> {
  const running = syncing.get(connectionId);
  if (running) return running;
  const job = (async () => {
    const target = await getLibraryRuntime(connectionId);
    if (!target.connection.libraryIds.length) return 0;
    const items: RemoteBook[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100000; page++) {
      const result = await target.runtime.call(
        'library.syncCatalog',
        { context: target.lease.context, libraryIds: target.connection.libraryIds, cursor },
        { signal: AbortSignal.timeout(60_000) },
      );
      if (result.books.some((b) => !target.connection.libraryIds.includes(b.libraryId)))
        throw new Error('Plugin returned a book outside selected libraries');
      items.push(...result.books);
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
    // Covers are small API resources; no EPUB is opened to populate the shelf.
    let next = 0;
    const owned = books.filter(
      (b) =>
        getExternalSource(b)?.connectionId === connectionId && !getExternalSource(b)?.unavailable,
    );
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < owned.length) {
          const book = owned[next++]!;
          try {
            await fetchExternalCover(app, book);
          } catch {
            /* Missing covers do not invalidate a completed catalog. */
          }
        }
      }),
    );
    await app.saveLibraryBooks(useLibraryStore.getState().library);
    return items.length;
  })();
  syncing.set(connectionId, job);
  try {
    return await job;
  } finally {
    syncing.delete(connectionId);
  }
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
