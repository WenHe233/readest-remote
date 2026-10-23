import { useEffect, useMemo, useRef, useState } from 'react';
import type { Book } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSourceInstances } from '@/services/contentSources/instances';
import { getSourceRuntime } from '@/services/contentSources/runtime';
import {
  addSourceWork,
  getSourceBookRef,
  sourceBookHash,
  type SourceBookRef,
} from '@/services/contentSources/catalog';
import {
  matchesSearchScope,
  mergeSourceResults,
  type SearchScope,
  type SourceSearchResult,
} from '@/services/unifiedSearch';
import { readPluginRecord, writePluginRecords } from '@/services/plugins/persistence';
import { getLibraryRuntime } from '@/services/plugins/manager';
import { syncExternalLibrary, useExternalLibrarySync } from '@/services/plugins/library';
import SourceCover from '@/components/contentSources/SourceCover';
import SourceWorkDetails from '@/components/contentSources/SourceWorkDetails';
import { useOpenBook } from '../hooks/useOpenBook';
import {
  normalizeSourceError,
  sourceErrorMessage,
  type SourceOperationError,
} from '@/services/contentSources/errors';

interface SourcePage {
  items: SourceSearchResult[];
  cursor?: string;
  loading: boolean;
  error?: SourceOperationError;
}
export default function UnifiedSearchResults({
  books,
  query,
  scopes,
  submitted,
  handleBookDownload,
}: {
  books: Book[];
  query: string;
  scopes: SearchScope[];
  submitted: { id: number; query: string };
  handleBookDownload: (
    book: Book,
    options?: { redownload?: boolean; queued?: boolean },
  ) => Promise<boolean>;
}) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const instances = useSourceInstances((state) => state.instances);
  const syncTasks = useExternalLibrarySync((state) => state.tasks);
  const [pages, setPages] = useState<Record<string, SourcePage>>({});
  const [checkedAt, setCheckedAt] = useState<Record<string, number>>({});
  const [refreshErrors, setRefreshErrors] = useState<
    Record<string, SourceOperationError | undefined>
  >({});
  const [detail, setDetail] = useState<SourceBookRef>();
  const [loading, setLoading] = useState(false);
  const { openBook } = useOpenBook({ setLoading, handleBookDownload });
  const controllers = useRef(new Map<string, AbortController>());
  const generation = useRef(0);
  const scopeKey = scopes.map((scope) => scope.id).join('|');
  const sourceScopes = scopes.filter((scope) => scope.kind === 'source');
  const matching = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return books.filter(
      (book) =>
        !book.deletedAt &&
        `${book.title}\n${book.author}\n${book.tags?.join(' ') ?? ''}`
          .toLocaleLowerCase()
          .includes(term),
    );
  }, [books, query]);
  useEffect(() => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    generation.current++;
    setPages({});
    return () => {
      for (const controller of controllers.current.values()) controller.abort();
    };
  }, [query, scopeKey]);
  useEffect(() => {
    let disposed = false;
    void Promise.all(
      scopes
        .filter((scope) => scope.connectionId)
        .map(
          async (scope) =>
            [
              scope.connectionId!,
              (await readPluginRecord<number>(`catalog-checked:${scope.connectionId}`)) ?? 0,
            ] as const,
        ),
    ).then((items) => {
      if (!disposed) setCheckedAt(Object.fromEntries(items));
    });
    return () => {
      disposed = true;
    };
  }, [scopeKey, syncTasks]);
  const load = async (scope: SearchScope, cursor?: string) => {
    if (!scope.instanceId || !query.trim()) return;
    const id = scope.instanceId;
    const epoch = generation.current;
    controllers.current.get(id)?.abort();
    const controller = new AbortController();
    controllers.current.set(id, controller);
    setPages((old) => ({
      ...old,
      [id]: { items: old[id]?.items ?? [], cursor: old[id]?.cursor, loading: true },
    }));
    try {
      const result = await (await getSourceRuntime(id)).call(
        'source.search',
        { query: query.trim(), cursor },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        epoch !== generation.current ||
        controllers.current.get(id) !== controller
      )
        return;
      setPages((old) => ({
        ...old,
        [id]: {
          loading: false,
          items: mergeSourceResults(
            cursor ? (old[id]?.items ?? []) : [],
            result.items.map((work) => ({ instanceId: id, work })),
          ),
          cursor: result.nextCursor && result.nextCursor !== cursor ? result.nextCursor : undefined,
        },
      }));
    } catch (failure) {
      if (epoch !== generation.current || controllers.current.get(id) !== controller) return;
      setPages((old) => ({
        ...old,
        [id]: {
          items: old[id]?.items ?? [],
          cursor: old[id]?.cursor,
          loading: false,
          error: normalizeSourceError(
            controller.signal.aborted ? new DOMException('Cancelled', 'AbortError') : failure,
            'search',
          ),
        },
      }));
    } finally {
      if (controllers.current.get(id) === controller) controllers.current.delete(id);
    }
  };
  useEffect(() => {
    if (!submitted.id || submitted.query !== query.trim()) return;
    let index = 0;
    const epoch = generation.current;
    void Promise.all(
      Array.from({ length: Math.min(2, sourceScopes.length) }, async () => {
        while (index < sourceScopes.length && epoch === generation.current)
          await load(sourceScopes[index++]!);
      }),
    );
  }, [submitted.id]);
  const reference = (item: SourceSearchResult): SourceBookRef | undefined => {
    const instance = instances.find((source) => source.id === item.instanceId);
    return instance
      ? {
          instanceId: instance.id,
          pluginId: instance.pluginId,
          fingerprint: instance.fingerprint,
          work: item.work,
        }
      : undefined;
  };
  return (
    <div className='flex min-h-0 grow flex-col overflow-y-auto px-4 pb-6' aria-busy={loading}>
      {!scopes.length && <p className='py-4 text-sm'>{_('Choose at least one search scope')}</p>}
      {scopes.map((scope) => {
        const local = matching.filter((book) => matchesSearchScope(book, scope));
        const page = scope.instanceId ? pages[scope.instanceId] : undefined;
        const items =
          scope.kind === 'source'
            ? mergeSourceResults(
                local.flatMap((book) => {
                  const ref = getSourceBookRef(book);
                  return ref ? [{ instanceId: ref.instanceId, work: ref.work }] : [];
                }),
                page?.items ?? [],
              )
            : [];
        const task = scope.connectionId ? syncTasks[scope.connectionId] : undefined;
        const syncing = task?.phase === 'catalog' || task?.phase === 'covers';
        return (
          <section key={scope.id} className='border-base-200 border-b py-3'>
            <div className='flex flex-wrap items-center gap-2'>
              <h2 className='grow font-semibold'>{scope.name}</h2>
              {scope.connectionId && (
                <button
                  type='button'
                  className='btn btn-xs btn-ghost eink-bordered'
                  disabled={!appService || syncing}
                  onClick={() => {
                    const id = scope.connectionId!;
                    setRefreshErrors((old) => ({ ...old, [id]: undefined }));
                    void (async () => {
                      const runtime = await getLibraryRuntime(id);
                      const libraries = await runtime.runtime.call('library.listLibraries', {
                        context: runtime.lease.context,
                      });
                      await writePluginRecords({ [`connection-libraries:${id}`]: libraries });
                      await syncExternalLibrary(appService!, id);
                    })().catch((failure: unknown) =>
                      setRefreshErrors((old) => ({
                        ...old,
                        [id]: normalizeSourceError(failure, 'search'),
                      })),
                    );
                  }}
                >
                  {syncing ? _('Refreshing…') : _('Refresh catalog')}
                </button>
              )}
              {page?.loading && (
                <button
                  type='button'
                  className='btn btn-xs btn-ghost eink-bordered'
                  onClick={() => controllers.current.get(scope.instanceId!)?.abort()}
                >
                  {_('Cancel')}
                </button>
              )}
            </div>
            {scope.connectionId && (
              <p className='text-base-content/60 text-xs'>
                {checkedAt[scope.connectionId]
                  ? _('Catalog updated: {{time}}', {
                      time: new Date(checkedAt[scope.connectionId]!).toLocaleString(),
                    })
                  : _('Searching the catalog saved on this device')}
                {refreshErrors[scope.connectionId] &&
                  ` · ${sourceErrorMessage(refreshErrors[scope.connectionId], _)}`}
              </p>
            )}
            {scope.kind === 'source' && !page && (
              <p className='text-base-content/60 text-sm'>
                {_('Press Search to query this source')}
              </p>
            )}
            {page?.loading && (
              <p role='status' className='text-sm'>
                {_('Searching…')}
              </p>
            )}
            {page?.error && (
              <div role='status' className='flex items-center gap-2 text-sm'>
                <span>
                  {sourceErrorMessage(page.error, _)} ({page.error.code})
                </span>
                <button
                  type='button'
                  className='btn btn-xs btn-ghost eink-bordered'
                  onClick={() => void load(scope, page.cursor)}
                >
                  {_('Retry')}
                </button>
              </div>
            )}
            {scope.kind !== 'source' &&
              local.map((book) => (
                <button
                  type='button'
                  key={book.hash}
                  className='hover:bg-base-200 flex w-full items-center gap-3 rounded py-3 text-start'
                  onClick={() => void openBook(book)}
                >
                  <span className='eink-bordered bg-base-200 relative flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded text-xs'>
                    {book.title.slice(0, 12)}
                    {book.coverImageUrl && (
                      <img
                        src={book.coverImageUrl}
                        alt=''
                        loading='lazy'
                        className='absolute inset-0 h-full w-full object-cover'
                        onError={(event) => {
                          event.currentTarget.style.display = 'none';
                        }}
                      />
                    )}
                  </span>
                  <span className='min-w-0'>
                    <span className='line-clamp-2 font-medium'>{book.title}</span>
                    <span className='text-base-content/60 block text-sm'>{book.author}</span>
                    <span className='text-base-content/50 text-xs'>{scope.name}</span>
                  </span>
                </button>
              ))}
            {items.map((item) => {
              const ref = reference(item);
              if (!ref) return null;
              const saved = books.some(
                (book) =>
                  !book.deletedAt && book.hash === sourceBookHash(item.instanceId, item.work.id),
              );
              return (
                <div key={item.work.id} className='flex items-center gap-3 py-3'>
                  <SourceCover source={ref} className='h-24 w-16' />
                  <button
                    type='button'
                    className='min-w-0 grow text-start'
                    onClick={() => setDetail(ref)}
                  >
                    <span className='line-clamp-2 font-medium'>{item.work.title}</span>
                    <span className='text-base-content/60 block text-sm'>{item.work.author}</span>
                    <span className='text-base-content/50 text-xs'>{scope.name}</span>
                  </button>
                  <button
                    type='button'
                    className='btn btn-xs btn-ghost eink-bordered shrink-0'
                    disabled={saved || !appService}
                    onClick={() => {
                      void addSourceWork(appService!, ref.instanceId, ref.work).catch(
                        (failure: unknown) =>
                          setPages((old) => ({
                            ...old,
                            [item.instanceId]: {
                              ...old[item.instanceId],
                              items: old[item.instanceId]?.items ?? [],
                              loading: false,
                              error: normalizeSourceError(failure, 'runtime'),
                            },
                          })),
                      );
                    }}
                  >
                    {saved ? _('In library') : _('Add to library')}
                  </button>
                </div>
              );
            })}
            {!local.length &&
              !items.length &&
              !page?.loading &&
              (scope.kind !== 'source' || page) && (
                <p className='text-base-content/60 py-3 text-sm'>{_('No results')}</p>
              )}
            {page?.cursor && (
              <button
                type='button'
                className='btn btn-sm btn-ghost eink-bordered'
                disabled={page.loading}
                onClick={() => void load(scope, page.cursor)}
              >
                {_('Load more')}
              </button>
            )}
          </section>
        );
      })}
      {detail && <SourceWorkDetails source={detail} onClose={() => setDetail(undefined)} />}
    </div>
  );
}
