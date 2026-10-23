import { useEffect, useState } from 'react';
import Dialog from '@/components/Dialog';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useAppRouter } from '@/hooks/useAppRouter';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { navigateToReader } from '@/utils/nav';
import { getSourceRuntime } from '@/services/contentSources/runtime';
import { useSourceInstances } from '@/services/contentSources/instances';
import {
  addSourceWork,
  listSourceChapters,
  sourceBookHash,
  sourceChapterDownloaded,
  removeSourceDownloadedChapter,
  useSourceDownloads,
  type SourceBookRef,
  type ChapterEntry,
} from '@/services/contentSources/catalog';
import {
  normalizeSourceError,
  sourceErrorMessage,
  type SourceOperationError,
} from '@/services/contentSources/errors';
import SourceCover from './SourceCover';

export default function SourceWorkDetails({
  source,
  onClose,
}: {
  source: SourceBookRef;
  onClose: () => void;
}) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const router = useAppRouter();
  const settings = useSettingsStore((state) => state.settings);
  const library = useLibraryStore((state) => state.library);
  const instance = useSourceInstances((state) =>
    state.instances.find((item) => item.id === source.instanceId),
  );
  const saved = library.find(
    (book) => book.hash === sourceBookHash(source.instanceId, source.work.id) && !book.deletedAt,
  );
  const [detail, setDetail] = useState(source);
  const [chapters, setChapters] = useState<ChapterEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [downloaded, setDownloaded] = useState<Record<string, boolean>>({});
  const [visible, setVisible] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SourceOperationError>();
  const [status, setStatus] = useState('');
  const download = useSourceDownloads(
    (state) => state.tasks[sourceBookHash(source.instanceId, source.work.id)],
  );
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    void (async () => {
      const work = saved
        ? source.work
        : await (await getSourceRuntime(source.instanceId)).call(
            'source.getWork',
            { work: source.work },
            controller.signal,
          );
      const ref = { ...source, work };
      setDetail(ref);
      const entries = await listSourceChapters(ref, { signal: controller.signal });
      if (!controller.signal.aborted) setChapters(entries);
    })()
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(normalizeSourceError(failure, 'runtime'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [source.instanceId, source.work.id]);
  useEffect(() => {
    let disposed = false;
    void Promise.all(
      chapters
        .slice(0, visible)
        .map(
          async (chapter) =>
            [chapter.id, await sourceChapterDownloaded(detail, chapter.id)] as const,
        ),
    )
      .then((rows) => {
        if (!disposed) setDownloaded(Object.fromEntries(rows));
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(normalizeSourceError(failure, 'runtime'));
      });
    return () => {
      disposed = true;
    };
  }, [chapters, visible, detail, download?.completed]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(normalizeSourceError(failure, 'runtime'));
    } finally {
      setBusy(false);
    }
  };
  const collect = async () => {
    if (!appService) throw new Error('Application is unavailable');
    return saved ?? addSourceWork(appService, detail.instanceId, detail.work);
  };
  const read = async (chapter?: ChapterEntry) => {
    const book = await collect();
    if (chapter && appService) {
      const config = await appService.loadBookConfig(book, settings);
      config.sourceLocator = {
        workId: detail.work.id,
        chapterId: chapter.id,
        modified: Date.now(),
      };
      await appService.saveBookConfig(book, config, settings);
    }
    onClose();
    navigateToReader(router, [book.hash]);
  };
  return (
    <Dialog isOpen portal aboveKeyboard title={_('Book details')} onClose={onClose}>
      <div className='flex flex-col gap-4'>
        <div className='flex gap-4'>
          <SourceCover source={detail} />
          <div className='min-w-0'>
            <h2 className='text-lg font-semibold'>{detail.work.title}</h2>
            <p>{detail.work.author}</p>
            <p className='text-base-content/60 text-sm'>
              {instance?.name ?? _('Source unavailable')}
            </p>
          </div>
        </div>
        {detail.work.description && (
          <p className='text-base-content/70 whitespace-pre-wrap text-sm'>
            {detail.work.description}
          </p>
        )}
        {error && (
          <p role='alert' className='text-error text-sm'>
            {sourceErrorMessage(error, _)} ({error.code})
          </p>
        )}
        {status && (
          <p role='status' className='text-sm'>
            {status}
          </p>
        )}
        {download && (
          <p role='status' className='text-sm'>
            {_('Downloaded chapters')}: {download.completed}/{download.total}
          </p>
        )}
        <div className='flex flex-wrap gap-2'>
          <button
            type='button'
            className='btn btn-sm btn-contrast'
            disabled={busy}
            onClick={() => void act(() => read())}
          >
            {_('Read')}
          </button>
          <button
            type='button'
            className='btn btn-sm btn-ghost eink-bordered'
            disabled={busy || !!saved}
            onClick={() =>
              void act(async () => {
                await collect();
                setStatus(_('Added to library'));
              })
            }
          >
            {saved ? _('In library') : _('Add to library')}
          </button>
          <button
            type='button'
            className='btn btn-sm btn-ghost eink-bordered'
            disabled={busy || !instance?.enabled}
            onClick={() =>
              void act(async () => {
                setChapters(await listSourceChapters(detail, { refresh: true }));
                setStatus(_('Chapters updated'));
              })
            }
          >
            {_('Check for updates')}
          </button>
        </div>
        <div className='flex flex-wrap gap-2'>
          <button
            type='button'
            className='btn btn-xs btn-ghost eink-bordered'
            onClick={() =>
              setSelected(
                chapters.filter((chapter) => !chapter.removed).map((chapter) => chapter.id),
              )
            }
          >
            {_('Select all')}
          </button>
          <button
            type='button'
            className='btn btn-xs btn-ghost eink-bordered'
            onClick={() => setSelected([])}
          >
            {_('Clear selection')}
          </button>
          <button
            type='button'
            className='btn btn-xs btn-contrast'
            disabled={busy || !selected.length}
            onClick={() =>
              void act(async () => {
                await collect();
                const { enqueueSourceDownloads } = await import(
                  '@/services/contentSources/downloads'
                );
                await enqueueSourceDownloads(detail, selected);
                setStatus(_('Added to downloads'));
              })
            }
          >
            {_('Download selected')}
          </button>
          <button
            type='button'
            className='btn btn-xs btn-ghost eink-bordered'
            disabled={busy || !selected.some((id) => downloaded[id])}
            onClick={() =>
              void act(async () => {
                for (const id of selected)
                  if (downloaded[id]) await removeSourceDownloadedChapter(detail, id);
                setDownloaded((old) => ({
                  ...old,
                  ...Object.fromEntries(selected.map((id) => [id, false])),
                }));
              })
            }
          >
            {_('Remove selected downloads')}
          </button>
        </div>
        <ul className='eink-bordered divide-base-200 divide-y rounded-lg border border-base-200'>
          {chapters.slice(0, visible).map((chapter) => (
            <li key={chapter.id} className='flex items-center gap-3 p-3'>
              <input
                type='checkbox'
                className='checkbox checkbox-sm'
                aria-label={_('Select {{title}}', { title: chapter.title })}
                checked={selected.includes(chapter.id)}
                disabled={!!chapter.removed && !downloaded[chapter.id]}
                onChange={() =>
                  setSelected((old) =>
                    old.includes(chapter.id)
                      ? old.filter((id) => id !== chapter.id)
                      : [...old, chapter.id],
                  )
                }
              />
              <button
                type='button'
                className='min-w-0 grow text-start'
                disabled={busy || (!!chapter.removed && !downloaded[chapter.id])}
                onClick={() => void act(() => read(chapter))}
              >
                <span className='block'>{chapter.title}</span>
                <span className='text-base-content/60 text-xs'>
                  {downloaded[chapter.id]
                    ? _('Downloaded')
                    : chapter.removed
                      ? _('Removed from source')
                      : chapter.group}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {visible < chapters.length && (
          <button
            type='button'
            className='btn btn-sm btn-ghost eink-bordered'
            onClick={() => setVisible((count) => count + 100)}
          >
            {_('Load more')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
