import { epubPackage, type EpubManifest } from './epub';
import {
  requestJson,
  type HttpRequest,
  type LibraryContext,
  type LibrarySource,
  type PluginWorkerOperationContext,
  type RemoteBook,
  type ResourceDescriptor,
} from '@readest/plugin-sdk';
interface BookDto {
  id: string;
  libraryId: string;
  name: string;
  sizeBytes: number;
  lastModified: string;
  fileHash?: string;
  media: { mediaType: string; pagesCount: number; status: string };
  metadata?: {
    title?: string;
    summary?: string;
    authors?: Array<{ name: string; role: string }>;
    tags?: string[];
  };
  readProgress?: { page: number; lastModified: string; completed: boolean };
}
const resource = (context: LibraryContext, path: string): ResourceDescriptor => ({
  path,
  auth: [{ secret: context.secrets['apiKey']!, in: 'header', name: 'X-API-Key' }],
});
const json = <T>(
  host: PluginWorkerOperationContext,
  context: LibraryContext,
  request: Omit<HttpRequest, 'connection'>,
) => requestJson<T>(host, context, { ...request, auth: resource(context, request.path).auth });
export function mapKomgaBook(book: BookDto): RemoteBook | null {
  if (book.media.status !== 'READY') return null;
  const media = book.media.mediaType;
  const format = media.includes('epub')
    ? 'EPUB'
    : media.includes('pdf')
      ? 'PDF'
      : media.includes('zip')
        ? 'CBZ'
        : null;
  if (!format) return null;
  return {
    id: book.id,
    libraryId: book.libraryId,
    title: book.metadata?.title || book.name,
    author: (book.metadata?.authors ?? []).map((a) => a.name).join(', '),
    format,
    size: book.sizeBytes,
    pageCount: Math.max(1, book.media.pagesCount),
    revision: `${book.fileHash || book.lastModified}:${book.sizeBytes}`,
    description: book.metadata?.summary || undefined,
    tags: book.metadata?.tags,
  };
}
export const komgaPlugin: LibrarySource = {
  'library.testConnection': async ({ context }, host) => {
    await json(host, context, { path: '/api/v1/libraries' });
    return { name: 'Komga' };
  },
  'library.listLibraries': async ({ context }, host) =>
    json<Array<{ id: string; name: string }>>(host, context, { path: '/api/v1/libraries' }).then(
      (rows) => rows.map((r) => ({ id: r.id, name: r.name })),
    ),
  'library.syncCatalog': async ({ context, libraryIds, cursor }, host) => {
    const current = cursor
      ? (JSON.parse(cursor) as { library: number; page: number })
      : { library: 0, page: 0 };
    const id = libraryIds[current.library];
    if (!id) return { books: [], complete: true };
    const page = await json<{ content: BookDto[]; last: boolean }>(host, context, {
      path: '/api/v1/books/list',
      method: 'POST',
      query: { page: current.page, size: 100, sort: 'id,asc' },
      json: { condition: { libraryId: { operator: 'is', value: id } } },
    });
    const next = page.last
      ? { library: current.library + 1, page: 0 }
      : { ...current, page: current.page + 1 };
    const complete = next.library >= libraryIds.length;
    return {
      books: page.content.flatMap((row) => {
        const book = mapKomgaBook(row);
        return book ? [book] : [];
      }),
      complete,
      ...(!complete ? { nextCursor: JSON.stringify(next) } : {}),
    };
  },
  'library.getBook': async ({ context, book }, host) => {
    const row = mapKomgaBook(
      await json<BookDto>(host, context, { path: `/api/v1/books/${encodeURIComponent(book.id)}` }),
    );
    if (!row) throw new Error('Book is unavailable');
    return row;
  },
  'library.resolveContent': async ({ context, book }, host) => {
    const base = `/api/v1/books/${encodeURIComponent(book.id)}`;
    const download = resource(context, base + '/file');
    if (book.format === 'EPUB')
      return {
        kind: 'epub-resources',
        inlineResources: epubPackage(
          await json<EpubManifest>(host, context, { path: base + '/manifest/epub' }),
          book.title,
          book.author,
        ),
        resource: resource(context, base + '/resource/{path}'),
        download,
      };
    return {
      kind: 'pages',
      pageCount: book.pageCount ?? 1,
      firstPage: 1,
      resource: { ...resource(context, base + '/pages/{page}'), headers: { Accept: 'image/*' } },
      download,
    };
  },
  'library.getCover': async ({ context, book }) =>
    resource(context, `/api/v1/books/${encodeURIComponent(book.id)}/thumbnail`),
  'library.pullProgress': async ({ context, book }, host) => {
    const base = `/api/v1/books/${encodeURIComponent(book.id)}`;
    if (book.format !== 'EPUB') {
      const row = await json<BookDto>(host, context, { path: base });
      const p = row.readProgress;
      if (!p) return null;
      const index = Math.max(0, p.page - 1);
      return {
        kind: 'page',
        pageIndex: index,
        fraction: p.completed ? 1 : index / Math.max(1, (book.pageCount ?? 1) - 1),
        modified: Date.parse(p.lastModified) || 0,
      };
    }
    const p = await json<
      | {
          modified: string;
          locator: {
            href: string;
            locations?: {
              fragments?: string[];
              fragment?: string[];
              progression?: number;
              totalProgression?: number;
            };
          };
        }
      | undefined
    >(host, context, { path: base + '/progression' });
    if (!p) return null;
    const loc = p.locator.locations;
    const fragment = loc?.fragments?.[0] || loc?.fragment?.[0];
    return {
      kind: 'epub',
      href: p.locator.href,
      fragment,
      sectionProgress: loc?.progression ?? 0,
      fraction: loc?.totalProgression ?? 0,
      modified: Date.parse(p.modified) || 0,
      approximate: !fragment,
    };
  },
  'library.pushProgress': async ({ context, book, progress }, host) => {
    const base = `/api/v1/books/${encodeURIComponent(book.id)}`;
    if (book.format === 'EPUB') {
      const positions = await json<{
        positions: {
          href: string;
          locations: { progression?: number; position?: number; totalProgression?: number };
        }[];
      }>(host, context, { path: base + '/positions' });
      const clean = (href: string) => decodeURIComponent(href.split('#')[0] ?? '');
      const section = positions.positions.filter(
        (p) => clean(p.href) === clean(progress.href ?? ''),
      );
      if (!section.length) throw new Error('EPUB section is unavailable on the server');
      const fraction = progress.sectionProgress ?? 0;
      const before = section.filter((p) => (p.locations.progression ?? 0) <= fraction);
      const anchor = before.at(-1) ?? section[0]!;
      // Komga validates against its server-generated position grid. In a short
      // chapter with one position, any nonzero fraction otherwise returns 400.
      await json(host, context, {
        path: base + '/progression',
        method: 'PUT',
        json: {
          modified: new Date(progress.modified).toISOString(),
          device: { id: context.connection, name: 'Readest Remote V2' },
          locator: {
            href: progress.href || '',
            type: 'application/xhtml+xml',
            locations: {
              fragments: progress.fragment ? [progress.fragment] : [],
              progression: anchor.locations.progression ?? 0,
              position: anchor.locations.position ?? 1,
              totalProgression: anchor.locations.totalProgression ?? progress.fraction,
            },
          },
        },
      });
    } else
      await json(host, context, {
        path: base + '/read-progress',
        method: 'PATCH',
        json: { page: (progress.pageIndex ?? 0) + 1, completed: progress.fraction >= 1 },
      });
    return { saved: true };
  },
};
