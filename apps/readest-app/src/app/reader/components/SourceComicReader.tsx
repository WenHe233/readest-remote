import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceRef } from '@readest/plugin-sdk';
import { CFI } from '@/libs/document';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { loadSourceResource, resolveSourceChapter } from '@/services/contentSources/catalog';
import type { SourceBookDocument } from '@/services/contentSources/sourceBook';
import type { Insets } from '@/types/misc';

/** One chapter's image descriptors and one visible image are loaded at a time. */
export default function SourceComicReader({
  bookKey,
  bookDoc,
  insets,
  onCloseBook,
  onGoToLibrary,
}: {
  bookKey: string;
  bookDoc: SourceBookDocument;
  insets: Insets;
  onCloseBook: (key: string) => void;
  onGoToLibrary: () => void;
}) {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const chapters = bookDoc.sourceChapters;
  const initial = useRef(useBookDataStore.getState().getConfig(bookKey)?.sourceLocator);
  const [chapterId, setChapterId] = useState(
    initial.current?.chapterId ??
      chapters.find((chapter) => !chapter.removed)?.id ??
      chapters[0]?.id ??
      '',
  );
  const [pageIndex, setPageIndex] = useState(initial.current?.pageIndex ?? 0);
  const [loaded, setLoaded] = useState<{ chapterId: string; pages: ResourceRef[] }>();
  const [imageUrl, setImageUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [bookmarked, setBookmarked] = useState(false);
  const chapterIndex = chapters.findIndex((chapter) => chapter.id === chapterId);
  const chapter = chapters[chapterIndex];
  const pages = loaded?.chapterId === chapterId ? loaded.pages : undefined;
  const resource = pages?.[pageIndex];
  const saveQueue = useRef(Promise.resolve());
  const persist = useCallback(() => {
    const config = useBookDataStore.getState().getConfig(bookKey);
    if (!config) return;
    const snapshot = { ...config };
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(() =>
        useBookDataStore
          .getState()
          .saveConfig(envConfig, bookKey, snapshot, useSettingsStore.getState().settings),
      )
      .catch(() => setError('SOURCE_SAVE_FAILED'));
  }, [bookKey, envConfig]);

  useEffect(() => {
    if (!chapter) return;
    const abort = new AbortController();
    setLoaded(undefined);
    setError(undefined);
    void resolveSourceChapter(bookDoc.sourceReference, chapter, abort.signal)
      .then((content) => {
        if (abort.signal.aborted) return;
        if (content.kind !== 'pages' || !content.pages.length)
          throw new Error('SOURCE_CONTENT_INVALID');
        setLoaded({ chapterId: chapter.id, pages: content.pages });
        setPageIndex((index) => Math.min(index, content.pages.length - 1));
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError((failure as { code?: string }).code ?? 'SOURCE_CHAPTER_FAILED');
      });
    return () => abort.abort();
  }, [bookDoc, chapter, retry]);

  useEffect(() => {
    setImageUrl(undefined);
    if (!chapter || !resource) return;
    const abort = new AbortController();
    let url: string | undefined;
    void loadSourceResource(bookDoc.sourceReference, resource, chapter, abort.signal)
      .then((blob) => {
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
        setError(undefined);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError((failure as { code?: string }).code ?? 'SOURCE_IMAGE_FAILED');
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [bookDoc, chapter, resource, retry]);

  useEffect(() => {
    if (!chapter || !pages || !imageUrl) return;
    const cfi = CFI.joinIndir(CFI.fake.fromIndex(chapter.slot), `/4/${(pageIndex + 1) * 2}`);
    const store = useBookDataStore.getState();
    store.setConfig(bookKey, {
      location: cfi,
      // Estimate unvisited chapter sizes from this chapter; the stable locator remains authoritative.
      progress: [chapterIndex * pages.length + pageIndex + 1, chapters.length * pages.length],
      sourceLocator: {
        workId: bookDoc.sourceReference.work.id,
        chapterId,
        pageIndex,
        cfi,
        modified: Date.now(),
      },
    });
    setBookmarked(
      !!store
        .getConfig(bookKey)
        ?.booknotes?.some(
          (note) => note.type === 'bookmark' && note.cfi === cfi && !note.deletedAt,
        ),
    );
    useReaderStore.getState().setViewInited(bookKey, true);
    const timer = setTimeout(persist, 500);
    return () => clearTimeout(timer);
  }, [
    bookKey,
    bookDoc,
    chapter,
    chapterId,
    chapterIndex,
    chapters.length,
    pages,
    pageIndex,
    imageUrl,
    persist,
  ]);

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') persist();
    };
    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      persist();
      window.removeEventListener('pagehide', persist);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [persist]);

  const changeChapter = (id: string, initialPage = 0) => {
    persist();
    setPageIndex(initialPage);
    setChapterId(id);
  };
  const turn = (direction: number) => {
    if (!pages) return;
    if (pageIndex + direction >= 0 && pageIndex + direction < pages.length)
      setPageIndex(pageIndex + direction);
    else {
      let index = chapterIndex + direction;
      while (chapters[index]?.removed) index += direction;
      if (chapters[index])
        changeChapter(chapters[index]!.id, direction < 0 ? Number.MAX_SAFE_INTEGER : 0);
    }
  };
  const bookmark = () => {
    const store = useBookDataStore.getState();
    const config = store.getConfig(bookKey);
    if (!config?.location) return;
    const notes = (config.booknotes ?? []).map((note) => ({ ...note }));
    const existing = notes.find(
      (note) => note.type === 'bookmark' && note.cfi === config.location && !note.deletedAt,
    );
    const now = Date.now();
    if (existing) {
      existing.deletedAt = now;
      existing.updatedAt = now;
    } else
      notes.push({
        id: crypto.randomUUID(),
        type: 'bookmark',
        cfi: config.location,
        note: chapter?.title ?? '',
        createdAt: now,
        updatedAt: now,
        sourceLocator: config.sourceLocator,
      });
    store.updateBooknotes(bookKey, notes);
    setBookmarked(!existing);
    persist();
  };
  const bookmarks = (useBookDataStore.getState().getConfig(bookKey)?.booknotes ?? []).filter(
    (note) => note.type === 'bookmark' && !note.deletedAt && note.sourceLocator,
  );
  return (
    <div
      className='bg-base-100 text-base-content flex h-full flex-col'
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingInlineStart: insets.left,
        paddingInlineEnd: insets.right,
      }}
    >
      <header className='eink-bordered border-base-300 flex flex-wrap items-center gap-2 border-b p-2'>
        <button
          className='btn btn-ghost btn-sm'
          onClick={() => {
            persist();
            onGoToLibrary();
          }}
        >
          {_('Library')}
        </button>
        <span className='min-w-0 flex-1 truncate'>{bookDoc.sourceReference.work.title}</span>
        <button
          className='btn btn-ghost btn-sm'
          onClick={bookmark}
          disabled={!imageUrl}
          aria-pressed={bookmarked}
        >
          {bookmarked ? _('Remove Bookmark') : _('Add Bookmark')}
        </button>
        <button
          className='btn btn-ghost btn-sm'
          onClick={() => {
            persist();
            onCloseBook(bookKey);
          }}
        >
          {_('Close')}
        </button>
      </header>
      <div className='flex flex-wrap items-center gap-2 p-2'>
        <label className='flex min-w-0 flex-1 items-center gap-2'>
          {_('Chapters')}
          <select
            className='select select-bordered eink-bordered min-w-0 flex-1'
            value={chapterId}
            onChange={(event) => changeChapter(event.target.value)}
          >
            {chapters.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
                {item.removed ? ` (${_('Removed')})` : ''}
              </option>
            ))}
          </select>
        </label>
        {bookmarks.length > 0 && (
          <select
            className='select select-bordered eink-bordered'
            value=''
            aria-label={_('Bookmarks')}
            onChange={(event) => {
              const note = bookmarks.find((item) => item.id === event.target.value);
              if (note?.sourceLocator) {
                persist();
                setChapterId(note.sourceLocator.chapterId);
                setPageIndex(note.sourceLocator.pageIndex ?? 0);
              }
            }}
          >
            <option value=''>{_('Bookmarks')}</option>
            {bookmarks.map((note) => (
              <option key={note.id} value={note.id}>
                {note.note} · {(note.sourceLocator?.pageIndex ?? 0) + 1}
              </option>
            ))}
          </select>
        )}
      </div>
      <main
        className='relative flex min-h-0 flex-1 items-center justify-center overflow-auto'
        aria-busy={!imageUrl && !error}
      >
        {error ? (
          <div role='alert' className='p-4 text-center'>
            <p>{_('Unable to load this page')}</p>
            <p className='text-sm'>{error}</p>
            <button
              className='btn btn-contrast mt-3'
              onClick={() => setRetry((value) => value + 1)}
            >
              {_('Retry')}
            </button>
          </div>
        ) : imageUrl ? (
          <img
            src={imageUrl}
            alt={`${chapter?.title ?? ''} · ${pageIndex + 1}`}
            className='max-h-full max-w-full object-contain'
          />
        ) : (
          <p role='status'>{_('Loading...')}</p>
        )}
      </main>
      <footer className='eink-bordered border-base-300 flex flex-wrap items-center justify-center gap-2 border-t p-2'>
        <button
          className='btn btn-ghost btn-sm'
          disabled={chapterIndex <= 0}
          onClick={() => changeChapter(chapters[chapterIndex - 1]!.id)}
        >
          {_('Previous Chapter')}
        </button>
        <button
          className='btn btn-contrast btn-sm'
          disabled={!pages || (chapterIndex === 0 && pageIndex === 0)}
          onClick={() => turn(-1)}
        >
          {_('Previous Page')}
        </button>
        <span className='text-sm tabular-nums'>
          {pages ? `${pageIndex + 1} / ${pages.length}` : '…'}
        </span>
        <button
          className='btn btn-contrast btn-sm'
          disabled={
            !pages || (chapterIndex === chapters.length - 1 && pageIndex === pages.length - 1)
          }
          onClick={() => turn(1)}
        >
          {_('Next Page')}
        </button>
        <button
          className='btn btn-ghost btn-sm'
          disabled={chapterIndex >= chapters.length - 1}
          onClick={() => changeChapter(chapters[chapterIndex + 1]!.id)}
        >
          {_('Next Chapter')}
        </button>
      </footer>
    </div>
  );
}
