import {
  requestJson,
  type HttpRequest,
  type HttpResponse,
  type LibraryContext,
  type LibrarySource,
  type PluginWorkerOperationContext,
  type RemoteBook,
  type ResourceDescriptor,
} from '@readest/plugin-sdk';
interface Series {
  id: number;
  name: string;
  localizedName?: string;
  libraryId: number;
}
interface Chapter {
  id: number;
  format: number;
  title?: string;
  titleName?: string;
  summary?: string;
  language?: string;
  lastModifiedUtc?: string;
  writers?: Array<{ name: string }>;
  tags?: Array<{ title: string }>;
  files?: Array<{
    id: number;
    bytes: number;
    pages: number;
    created: string;
    koreaderHash?: string;
    extension?: string;
    filePath?: string;
  }>;
}
interface Volume {
  id: number;
  chapters?: Chapter[];
}
interface Progress {
  pageNum: number;
  bookScrollId?: string | null;
  lastModifiedUtc?: string;
}
const auth = (context: LibraryContext, query = false): ResourceDescriptor['auth'] => [
  { secret: context.secrets['apiKey']!, in: 'header', name: 'x-api-key' },
  ...(query ? [{ secret: context.secrets['apiKey']!, in: 'query' as const, name: 'apiKey' }] : []),
];
const resource = (
  context: LibraryContext,
  path: string,
  query?: ResourceDescriptor['query'],
  keyQuery = false,
): ResourceDescriptor => ({ path, query, auth: auth(context, keyQuery) });
const json = <T>(
  host: PluginWorkerOperationContext,
  context: LibraryContext,
  request: Omit<HttpRequest, 'connection'>,
) => requestJson<T>(host, context, { ...request, auth: request.auth ?? auth(context) });
export function kavitaTime(value: string | undefined): number {
  const text = value?.trim() ?? '';
  const zoned = /(?:z|[+-]\d{2}:?\d{2})$/iu.test(text);
  return Math.max(0, Date.parse(text.includes('T') && !zoned ? text + 'Z' : text) || 0);
}
export function mapKavitaBook(series: Series, volume: Volume, chapter: Chapter): RemoteBook | null {
  const files = chapter.files ?? [];
  if (!files.length) return null;
  const format =
    chapter.format === 3
      ? 'EPUB'
      : chapter.format === 4
        ? 'PDF'
        : chapter.format === 1 || chapter.format === 0
          ? 'CBZ'
          : null;
  if (!format) return null;
  // Kavita's book reader opens the first file when alternate editions are
  // grouped under one chapter. Keep the same chapter identity and progress.
  const contentFiles = format === 'EPUB' || format === 'PDF' ? files.slice(0, 1) : files;
  return {
    id: String(chapter.id),
    libraryId: String(series.libraryId),
    format,
    title:
      chapter.titleName?.trim() ||
      chapter.title?.trim() ||
      series.localizedName ||
      series.name ||
      String(chapter.id),
    author: (chapter.writers ?? [])
      .map((p) => p.name)
      .filter(Boolean)
      .join(', '),
    revision: files.map((f) => `${f.id}:${f.bytes}:${f.created}:${f.koreaderHash ?? ''}`).join('|'),
    size: contentFiles.reduce((n, f) => n + f.bytes, 0),
    pageCount: Math.max(
      1,
      contentFiles.reduce((n, f) => n + f.pages, 0),
    ),
    language: chapter.language || undefined,
    description: chapter.summary || undefined,
    tags: (chapter.tags ?? []).map((t) => t.title),
    series: series.name,
    data: {
      seriesId: series.id,
      volumeId: volume.id,
      libraryId: series.libraryId,
      fileCount: files.length,
    },
  };
}
export const kavitaPlugin: LibrarySource = {
  'library.testConnection': async ({ context }, host) => {
    const info = await json<{ username?: string; kavitaVersion?: string }>(host, context, {
      ...resource(context, '/api/Plugin/authenticate', { pluginName: 'Readest Remote V2' }, true),
      method: 'POST',
    });
    return { name: info.username || 'Kavita', version: info.kavitaVersion };
  },
  'library.listLibraries': async ({ context }, host) =>
    (
      await json<Array<{ id: number; name: string }>>(host, context, {
        path: '/api/Library/libraries',
      })
    ).map((l) => ({ id: String(l.id), name: l.name })),
  'library.syncCatalog': async ({ context, libraryIds, cursor }, host) => {
    const current = cursor
      ? (JSON.parse(cursor) as { library: number; page: number })
      : { library: 0, page: 1 };
    const libraryId = libraryIds[current.library];
    if (!libraryId) return { books: [], complete: true };
    const response = (await host.call('http.request', {
      connection: context.connection,
      ...resource(context, '/api/Series/all-v2', { PageNumber: current.page, PageSize: 5 }),
      method: 'POST',
      json: {
        statements: [{ comparison: 0, field: 19, value: libraryId }],
        combination: 1,
        sortOptions: { sortField: 1, isAscending: true },
        entityType: 0,
        limitTo: 0,
      },
    })) as HttpResponse;
    if (response.status !== 200) throw new Error(`Kavita catalog returned HTTP ${response.status}`);
    const pagination = response.headers['pagination'];
    if (!pagination) throw new Error('Kavita Pagination header is unavailable');
    const pageInfo = JSON.parse(pagination) as { totalPages: number };
    const series = JSON.parse(new TextDecoder().decode(response.bytes)) as Series[];
    const books: RemoteBook[] = [];
    // Five series per RPC keeps both API concurrency and response size bounded.
    for (const item of series) {
      host.signal.throwIfAborted();
      const volumes = await json<Volume[]>(host, context, {
        path: '/api/Series/volumes',
        query: { seriesId: item.id },
      });
      for (const volume of volumes)
        for (const chapter of volume.chapters ?? []) {
          const mapped = mapKavitaBook({ ...item, libraryId: Number(libraryId) }, volume, chapter);
          if (mapped) books.push(mapped);
        }
    }
    const next =
      current.page < pageInfo.totalPages
        ? { ...current, page: current.page + 1 }
        : { library: current.library + 1, page: 1 };
    const complete = next.library >= libraryIds.length;
    return { books, complete, ...(!complete ? { nextCursor: JSON.stringify(next) } : {}) };
  },
  'library.getBook': async ({ context, book }, host) => {
    const seriesId = Number(book.data?.['seriesId']);
    const volumes = await json<Volume[]>(host, context, {
      path: '/api/Series/volumes',
      query: { seriesId },
    });
    for (const volume of volumes) {
      const chapter = volume.chapters?.find((item) => String(item.id) === book.id);
      if (!chapter) continue;
      const current = mapKavitaBook(
        { id: seriesId, name: book.series || book.title, libraryId: Number(book.libraryId) },
        volume,
        chapter,
      );
      if (current) return current;
    }
    throw new Error('Kavita book is unavailable');
  },
  'library.resolveContent': async ({ context, book }) => {
    // The cached-file endpoint returns the same original used by Kavita's
    // reader; Download/chapter would wrap multiple editions in an outer ZIP.
    const firstFile =
      (book.format === 'EPUB' || book.format === 'PDF') && Number(book.data?.['fileCount']) > 1;
    const download = firstFile
      ? resource(context, '/api/Reader/pdf', { chapterId: book.id }, true)
      : resource(context, '/api/Download/chapter', { chapterId: book.id });
    if (book.format === 'CBZ')
      return {
        kind: 'pages',
        pageCount: book.pageCount ?? 1,
        firstPage: 0,
        resource: resource(
          context,
          '/api/Reader/image',
          { chapterId: book.id, page: '{page}' },
          true,
        ),
        download,
      };
    const content =
      book.format === 'PDF'
        ? resource(context, '/api/Reader/pdf', { chapterId: book.id }, true)
        : download;
    return { kind: 'remote-file', resource: content, size: book.size ?? 0, download };
  },
  'library.getCover': async ({ context, book }) =>
    resource(context, '/api/Image/chapter-cover', { chapterId: book.id }, true),
  'library.pullProgress': async ({ context, book }, host) => {
    const progress = await json<Progress>(host, context, {
      path: '/api/Reader/get-progress',
      query: { chapterId: book.id },
    });
    const modified = kavitaTime(progress.lastModifiedUtc);
    if (!modified && !progress.pageNum && !progress.bookScrollId) return null;
    const index = Math.max(0, progress.pageNum || 0);
    const fraction = Math.min(1, index / Math.max(1, (book.pageCount ?? 1) - 1));
    if (book.format !== 'EPUB') return { kind: 'page', pageIndex: index, fraction, modified };
    const scroll = progress.bookScrollId;
    const xpath = scroll?.startsWith('//body')
      ? `/body/DocFragment[${index + 1}]/body${scroll.slice(6)}`
      : scroll || undefined;
    return { kind: 'epub', spineIndex: index, xpath, fraction, modified, approximate: !xpath };
  },
  'library.pushProgress': async ({ context, book, progress }, host) => {
    const index = book.format === 'EPUB' ? progress.spineIndex : progress.pageIndex;
    const match = progress.xpath?.match(/^\/body\/DocFragment\[\d+\]\/body(.*)$/u);
    const scroll = match
      ? '//body' + match[1]
      : progress.xpath?.startsWith('//body')
        ? progress.xpath
        : null;
    await json(host, context, {
      path: '/api/Reader/progress',
      method: 'POST',
      json: {
        volumeId: Number(book.data?.['volumeId'] ?? 0),
        chapterId: Number(book.id),
        seriesId: Number(book.data?.['seriesId'] ?? 0),
        libraryId: Number(book.libraryId),
        pageNum: Math.min(
          Math.max(0, Math.floor(index ?? 0)),
          Math.max(0, (book.pageCount ?? 1) - 1),
        ),
        bookScrollId: book.format === 'EPUB' ? scroll : null,
        lastModifiedUtc: new Date(progress.modified).toISOString(),
      },
    });
    return { saved: true };
  },
};
