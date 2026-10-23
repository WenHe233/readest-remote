import { useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  useSourceDownloadQueue,
  initializeSourceDownloads,
  pauseSourceDownload,
  resumeSourceDownload,
  cancelSourceDownload,
  getSourceStorageUsage,
  clearSourceTemporaryCache,
  clearIncompleteSourceDownloads,
} from '@/services/contentSources/downloads';
import { sourceErrorMessage } from '@/services/contentSources/errors';
import { BoxedList, SettingsRow } from './primitives';

const bytesLabel = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
export default function SourceDownloadManager() {
  const _ = useTranslation();
  const tasks = useSourceDownloadQueue((state) => state.tasks);
  const [usage, setUsage] = useState({ temporary: 0, incomplete: 0, completed: 0 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void initializeSourceDownloads().catch((failure: unknown) =>
      setError(sourceErrorMessage(failure, _)),
    );
  }, [_]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void getSourceStorageUsage()
        .then((value) => {
          if (!cancelled) setUsage(value);
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tasks]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      setUsage(await getSourceStorageUsage());
    } catch (failure) {
      setError(sourceErrorMessage(failure, _));
    } finally {
      setBusy(false);
    }
  };
  const labels = {
    queued: _('Queued'),
    running: _('Downloading'),
    paused: _('Paused'),
    failed: _('Failed'),
    completed: _('Completed'),
    cancelled: _('Cancelled'),
  };
  return (
    <div className='space-y-4'>
      {error && (
        <p role='alert' className='text-error px-4'>
          {error}
        </p>
      )}
      <BoxedList
        title={_('Source storage')}
        description={_(
          'Temporary cache can be cleared without deleting downloads or reading progress.',
        )}
      >
        <SettingsRow label={_('Temporary cache')} description={bytesLabel(usage.temporary)}>
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            disabled={busy}
            onClick={() => void act(clearSourceTemporaryCache)}
          >
            {_('Clear')}
          </button>
        </SettingsRow>
        <SettingsRow label={_('Incomplete downloads')} description={bytesLabel(usage.incomplete)}>
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            disabled={busy || !usage.incomplete}
            onClick={() => void act(clearIncompleteSourceDownloads)}
          >
            {_('Clear')}
          </button>
        </SettingsRow>
        <SettingsRow label={_('Completed downloads')} description={bytesLabel(usage.completed)} />
      </BoxedList>
      {Object.keys(tasks).length > 0 && (
        <BoxedList
          title={_('Chapter downloads')}
          description={_(
            'Downloads pause when the app is suspended and resume when it returns to the foreground.',
          )}
        >
          {Object.values(tasks)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((task) => (
              <SettingsRow
                key={task.id}
                label={task.ref.work.title}
                responsive
                description={
                  task.error
                    ? sourceErrorMessage(task.error, _)
                    : `${labels[task.state]} · ${task.progress.completed}/${task.progress.total}${task.progress.resourcesTotal ? ` · ${task.progress.resourcesCompleted ?? 0}/${task.progress.resourcesTotal} ${_('images')}` : ''}`
                }
              >
                <div className='flex flex-wrap gap-2'>
                  {['running', 'queued'].includes(task.state) && (
                    <button
                      type='button'
                      className='btn btn-ghost btn-sm eink-bordered'
                      disabled={busy}
                      onClick={() => void act(() => pauseSourceDownload(task.id))}
                    >
                      {_('Pause')}
                    </button>
                  )}
                  {['paused', 'failed', 'cancelled'].includes(task.state) && (
                    <button
                      type='button'
                      className='btn btn-ghost btn-sm eink-bordered'
                      disabled={busy}
                      onClick={() => void act(() => resumeSourceDownload(task.id))}
                    >
                      {_('Resume')}
                    </button>
                  )}
                  {!['completed', 'cancelled'].includes(task.state) && (
                    <button
                      type='button'
                      className='btn btn-ghost btn-sm eink-bordered'
                      disabled={busy}
                      onClick={() => void act(() => cancelSourceDownload(task.id))}
                    >
                      {_('Cancel')}
                    </button>
                  )}
                </div>
              </SettingsRow>
            ))}
        </BoxedList>
      )}
    </div>
  );
}
