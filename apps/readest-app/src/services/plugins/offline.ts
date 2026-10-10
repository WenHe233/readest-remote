import { DocumentLoader } from '@/libs/document';
import type { ClosableFile } from '@/utils/file';
import { create } from 'zustand';
import { open, rename } from '@tauri-apps/plugin-fs';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { ProgressHandler } from '@/utils/transfer';
import { getDir, getLocalBookFilename } from '@/utils/book';
import { isTauriAppPlatform } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import { externalContent } from './content';
import { clearContentCache } from './cache';
interface TransferState {
  progress: number;
  total: number;
  error?: string;
}
export const usePluginDownloads = create<{ downloads: Record<string, TransferState> }>(() => ({
  downloads: {},
}));
const active = new Map<string, AbortController>();
const jobs = new Map<string, Promise<void>>();
export const cancelExternalDownload = (hash: string): void => active.get(hash)?.abort();
export function downloadExternalBook(
  app: AppService,
  book: Book,
  onProgress?: ProgressHandler,
): Promise<void> {
  const old = jobs.get(book.hash);
  if (old) return old;
  const job = performDownload(app, book, onProgress).finally(() => jobs.delete(book.hash));
  jobs.set(book.hash, job);
  return job;
}
async function performDownload(
  app: AppService,
  book: Book,
  onProgress?: ProgressHandler,
): Promise<void> {
  if (active.has(book.hash)) return;
  const controller = new AbortController();
  active.set(book.hash, controller);
  const destination = getLocalBookFilename(book);
  const partial = destination + '.part';
  let done = 0;
  try {
    const { descriptor, lease, source } = await externalContent(book);
    const resource =
      descriptor.download ?? (descriptor.kind === 'remote-file' ? descriptor.resource : undefined);
    if (!resource) throw new Error('Original file download is unavailable');
    await app.createDir(getDir(book), 'Books', true);
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      controller.signal.throwIfAborted();
      done = 0;
      const response = await lease.request(
        { ...resource, connection: lease.context.connection },
        controller.signal,
        24 * 60 * 60 * 1000,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Download returned HTTP ${response.status}`);
      }
      const total = Number(response.headers.get('content-length')) || source.item.size || 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Download body is missing');
      const native = isTauriAppPlatform()
        ? await open(await app.resolveFilePath(partial, 'Books'), {
            write: true,
            create: true,
            truncate: true,
          })
        : undefined;
      const chunks: Uint8Array[] = [];
      const started = Date.now();
      const buffer = new Uint8Array(512 * 1024);
      let buffered = 0;
      const flush = async () => {
        if (!native) return;
        let offset = 0;
        while (offset < buffered) {
          const written = await native.write(buffer.subarray(offset, buffered));
          if (!written) throw new Error('Unable to write the downloaded file');
          offset += written;
        }
        buffered = 0;
      };
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const { value, done: ended } = await reader.read();
          if (ended) break;
          if (native) {
            let offset = 0;
            while (offset < value.length) {
              const size = Math.min(buffer.length - buffered, value.length - offset);
              buffer.set(value.subarray(offset, offset + size), buffered);
              buffered += size;
              offset += size;
              if (buffered === buffer.length) await flush();
            }
          } else chunks.push(value);
          done += value.length;
          const state = { progress: done, total };
          usePluginDownloads.setState((s) => ({
            downloads: { ...s.downloads, [book.hash]: state },
          }));
          onProgress?.({
            ...state,
            transferSpeed: done / Math.max(0.001, (Date.now() - started) / 1000),
          });
        }
        await flush();
        if (!done || (total && done !== total)) throw new Error('Downloaded file is incomplete');
        if (!native)
          await app.writeFile(
            partial,
            'Books',
            new File(
              chunks.map((c) => new Uint8Array(c)),
              book.hash,
            ),
          );
        await native?.close();
        controller.signal.throwIfAborted();
        const file = await app.openFile(partial, 'Books');
        // Preserve the original format hint while validating a temporary file.
        Object.defineProperty(file, 'name', {
          value: book.hash + '.' + book.format.toLowerCase(),
          configurable: true,
        });
        try {
          const parsed = await new DocumentLoader(file).open();
          try {
            if (parsed.format !== book.format)
              throw new Error('Downloaded file format does not match the library');
          } finally {
            await parsed.book.destroy?.();
          }
        } finally {
          await (file as ClosableFile).close?.();
        }
        controller.signal.throwIfAborted();
        if (isTauriAppPlatform())
          await rename(
            await app.resolveFilePath(partial, 'Books'),
            await app.resolveFilePath(destination, 'Books'),
          );
        else {
          await app.copyFile(partial, 'Books', destination, 'Books');
          await app.deleteFile(partial, 'Books');
        }
        const now = Date.now();
        book.externalDownloadedAt = now;
        book.downloadedAt = now;
        useLibraryStore
          .getState()
          .setLibrary(
            useLibraryStore
              .getState()
              .library.map((b) =>
                b.hash === book.hash ? { ...b, externalDownloadedAt: now, downloadedAt: now } : b,
              ),
          );
        await app.saveLibraryBooks(useLibraryStore.getState().library);
        return;
      } catch (error) {
        last = error;
        await reader.cancel().catch(() => {});
        await native?.close().catch(() => {});
        if (controller.signal.aborted) throw error;
      } finally {
        reader.releaseLock();
      }
    }
    throw last;
  } catch (error) {
    const message = controller.signal.aborted
      ? 'Download cancelled'
      : error instanceof Error
        ? error.message
        : 'Download failed';
    usePluginDownloads.setState((s) => ({
      downloads: { ...s.downloads, [book.hash]: { progress: done, total: 0, error: message } },
    }));
    throw new Error(message);
  } finally {
    active.delete(book.hash);
    if (await app.exists(partial, 'Books')) await app.deleteFile(partial, 'Books').catch(() => {});
  }
}
export async function removeExternalOfflineBook(app: AppService, book: Book): Promise<void> {
  cancelExternalDownload(book.hash);
  await jobs.get(book.hash)?.catch(() => {});
  const path = getLocalBookFilename(book);
  if (await app.exists(path, 'Books')) await app.deleteFile(path, 'Books');
  await clearContentCache(book.hash);
  book.externalDownloadedAt = undefined;
  book.downloadedAt = undefined;
  useLibraryStore
    .getState()
    .setLibrary(
      useLibraryStore
        .getState()
        .library.map((b) =>
          b.hash === book.hash
            ? { ...b, externalDownloadedAt: undefined, downloadedAt: undefined }
            : b,
        ),
    );
  await app.saveLibraryBooks(useLibraryStore.getState().library);
}
