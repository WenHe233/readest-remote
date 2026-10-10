import type { ContentDescriptor, ResourceDescriptor } from '@readest/plugin-sdk';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { DocumentLoader, type BookDoc } from '@/libs/document';
import { RemoteFile } from '@/utils/file';
import { getLocalBookFilename } from '@/utils/book';
import { getExternalSource } from './bookSource';
import { getLibraryRuntime, findInstalledPlugin } from './manager';
import { readPluginRecord, writePluginRecords } from './persistence';
import { readBoundedBody, type ConnectionLease } from './httpBroker';
import { cacheKey, readContentCache, writeContentCache, PLUGIN_RANGE_CHUNK } from './cache';
import { getPluginDeviceConfig } from './connections';
import type { WidePagesOptions } from '@/utils/spread';
import { openPageStreamBook } from '@/services/opds/pseStream';

export function substituteResource(
  resource: ResourceDescriptor,
  token: string,
  value: string,
): ResourceDescriptor {
  return {
    ...resource,
    path: resource.path.replaceAll(token, value),
    query: resource.query
      ? Object.fromEntries(
          Object.entries(resource.query).map(([k, v]) => [
            k,
            typeof v === 'string' ? v.replaceAll(token, value) : v,
          ]),
        )
      : undefined,
  };
}
export function validateByteRange(
  response: Response,
  start: number,
  end: number,
  size: number,
): void {
  const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  if (
    response.status !== 206 ||
    !match ||
    Number(match[1]) !== start ||
    Number(match[2]) !== end ||
    Number(match[3]) !== size
  )
    throw new Error(
      'Server did not return the requested byte range. Refresh the library or download the original file.',
    );
}
export async function externalContent(book: Book) {
  const source = getExternalSource(book);
  if (!source) throw new Error('External book source is missing');
  const target = await getLibraryRuntime(source.connectionId);
  if (
    target.connection.pluginId !== source.pluginId ||
    target.connection.fingerprint !== source.fingerprint ||
    target.connection.sourceId !== source.sourceId
  )
    throw new Error('Book source does not match the authorized connection');
  const descriptorKey =
    'descriptor:' +
    (await cacheKey(
      book.hash,
      source.item.revision,
      findInstalledPlugin(source.pluginId)!.activeHash,
    ));
  const cached = await readPluginRecord<{
    descriptor: ContentDescriptor;
    slots: Record<string, string>;
  }>(descriptorKey);
  let descriptor: ContentDescriptor;
  if (cached) {
    const rebind = (resource: ResourceDescriptor): ResourceDescriptor => ({
      ...resource,
      auth: resource.auth?.map((binding) => {
        const name = Object.keys(cached.slots).find((key) => cached.slots[key] === binding.secret);
        const secret = name && target.lease.context.secrets[name];
        if (!secret) throw new Error('Connection credential is unavailable');
        return { ...binding, secret };
      }),
    });
    descriptor = { ...cached.descriptor, resource: rebind(cached.descriptor.resource) };
    if (cached.descriptor.download) descriptor.download = rebind(cached.descriptor.download);
  } else {
    descriptor = await target.runtime.call(
      'library.resolveContent',
      { context: target.lease.context, book: source.item },
      { signal: AbortSignal.timeout(45_000) },
    );
    await writePluginRecords({
      [descriptorKey]: { descriptor, slots: target.lease.context.secrets },
    }).catch(() => {});
  }
  return { ...target, descriptor, source };
}
export function createPluginRangeFetcher(
  book: Book,
  descriptor: Extract<ContentDescriptor, { kind: 'remote-file' }>,
  lease: ConnectionLease,
  cacheEnabled = true,
): typeof fetch {
  const source = getExternalSource(book)!;
  const pending = new Map<number, Promise<Uint8Array>>();
  const chunk = (start: number, signal?: AbortSignal): Promise<Uint8Array> => {
    const old = pending.get(start);
    if (old) return old;
    const task = (async () => {
      const end = Math.min(descriptor.size - 1, start + PLUGIN_RANGE_CHUNK - 1);
      const key = await cacheKey(book.hash, source.item.revision, `range:${start}:${end}`);
      if (cacheEnabled) {
        const cached = await readContentCache(key);
        if (cached && cached.bytes.length === end - start + 1) return cached.bytes;
      }
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        const response = await lease.request(
          {
            ...descriptor.resource,
            connection: lease.context.connection,
            headers: { ...descriptor.resource.headers, Range: `bytes=${start}-${end}` },
          },
          signal,
        );
        if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
          await response.body?.cancel();
          continue;
        }
        try {
          validateByteRange(response, start, end, descriptor.size);
        } catch (error) {
          await response.body?.cancel();
          throw error;
        }
        try {
          const bytes = await readBoundedBody(response, end - start + 1);
          if (bytes.length !== end - start + 1) throw new Error('Incomplete byte range');
          if (cacheEnabled) await writeContentCache(key, bytes, 'application/octet-stream');
          return bytes;
        } catch (error) {
          last = error;
        }
      }
      throw last;
    })();
    pending.set(start, task);
    void task.finally(() => pending.delete(start)).catch(() => {});
    return task;
  };
  return async (_input, init) => {
    if (init?.method === 'HEAD')
      return new Response(null, {
        headers: {
          'content-length': String(descriptor.size),
          'content-type': book.format === 'PDF' ? 'application/pdf' : 'application/epub+zip',
        },
      });
    const range = new Headers(init?.headers).get('Range')?.match(/^bytes=(\d+)-(\d+)$/u);
    if (!range) throw new Error('Streaming content requires an explicit byte range');
    const start = Number(range[1]),
      end = Math.min(Number(range[2]), descriptor.size - 1);
    if (start > end || end - start > 32 * 1024 * 1024) throw new Error('Invalid streaming range');
    const output = new Uint8Array(end - start + 1);
    for (
      let offset = Math.floor(start / PLUGIN_RANGE_CHUNK) * PLUGIN_RANGE_CHUNK;
      offset <= end;
      offset += PLUGIN_RANGE_CHUNK
    ) {
      const bytes = await chunk(offset, init?.signal ?? undefined);
      const from = Math.max(start, offset),
        to = Math.min(end + 1, offset + bytes.length);
      output.set(bytes.subarray(from - offset, to - offset), from - start);
    }
    return new Response(output, {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/${descriptor.size}`,
        'content-length': String(output.length),
      },
    });
  };
}
async function resourceBytes(
  book: Book,
  lease: ConnectionLease,
  resource: ResourceDescriptor,
  cacheEnabled: boolean,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const source = getExternalSource(book)!;
  const key = await cacheKey(
    book.hash,
    source.item.revision,
    JSON.stringify({ path: resource.path, query: resource.query }),
  );
  if (cacheEnabled) {
    const cached = await readContentCache(key);
    if (cached) return cached;
  }
  const response = await lease.request({ ...resource, connection: lease.context.connection });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Resource returned HTTP ${response.status}`);
  }
  const bytes = await readBoundedBody(response, 32 * 1024 * 1024);
  const mime = response.headers.get('content-type') || 'application/octet-stream';
  if (cacheEnabled) await writeContentCache(key, bytes, mime);
  return { bytes, mime };
}
export async function openExternalBook(
  appService: AppService,
  book: Book,
  widePages?: WidePagesOptions,
): Promise<{ book: BookDoc; file: File | null }> {
  const managed = getLocalBookFilename(book);
  if (await appService.exists(managed, 'Books')) {
    const file = await appService.openFile(managed, 'Books');
    return { book: (await new DocumentLoader(file, { widePages }).open()).book, file };
  }
  const { descriptor, lease, source } = await externalContent(book);
  const cacheEnabled = (await getPluginDeviceConfig(source.connectionId)).cacheEnabled !== false;
  if (descriptor.kind === 'remote-file') {
    const fetcher = createPluginRangeFetcher(book, descriptor, lease, cacheEnabled);
    const file = await new RemoteFile(
      `https://plugin-content.invalid/${book.hash}`,
      `${book.hash}.${book.format.toLowerCase()}`,
      '',
      Date.now(),
      fetcher,
    ).open();
    try {
      return {
        book: (await new DocumentLoader(file, { widePages, streaming: true }).open()).book,
        file,
      };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  if (descriptor.kind === 'pages') {
    const doc = await openPageStreamBook(
      { count: descriptor.pageCount, title: book.title, author: book.author },
      async (index) => {
        const item = await resourceBytes(
          book,
          lease,
          substituteResource(descriptor.resource, '{page}', String(index + descriptor.firstPage)),
          cacheEnabled,
        );
        if (!item) throw new Error('Page is unavailable');
        return new Blob([new Uint8Array(item.bytes)], { type: item.mime });
      },
      widePages,
    );
    return { book: doc.book, file: null };
  }
  const texts = new Map<string, string | null>(Object.entries(descriptor.inlineResources ?? {}));
  const sizes = new Map<string, number>();
  const load = async (path: string) =>
    resourceBytes(
      book,
      lease,
      substituteResource(
        descriptor.resource,
        '{path}',
        path.split('/').map(encodeURIComponent).join('/'),
      ),
      cacheEnabled,
    );
  const loadText = async (path: string): Promise<string | null> => {
    if (texts.has(path)) return texts.get(path)!;
    const data = await load(path);
    const value = data ? new TextDecoder().decode(data.bytes) : null;
    if (data) sizes.set(path, data.bytes.length);
    texts.set(path, value);
    return value;
  };
  const parser = new DOMParser();
  const container = parser.parseFromString(
    (await loadText('META-INF/container.xml')) ?? '',
    'application/xml',
  );
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB container is unavailable');
  const opf = parser.parseFromString((await loadText(opfPath)) ?? '', 'application/xml');
  const entries = [
    { filename: 'META-INF/container.xml' },
    { filename: opfPath },
    ...Array.from(opf.querySelectorAll('manifest > item')).map((item) => ({
      filename: decodeURIComponent(
        new URL(item.getAttribute('href') || '', `https://epub.invalid/${opfPath}`).pathname.slice(
          1,
        ),
      ),
    })),
  ];
  const loader = {
    entries,
    sha1: undefined,
    loadText,
    loadBlob: async (path: string) => {
      const data = await load(path);
      return data ? new Blob([new Uint8Array(data.bytes)], { type: data.mime }) : null;
    },
    getSize: (path: string) => sizes.get(path) ?? 1,
  };
  const { EPUB } = await import('foliate-js/epub.js');
  return { book: (await new EPUB(loader).init()) as unknown as BookDoc, file: null };
}
