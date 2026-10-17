import { useTranslation } from '@/hooks/useTranslation';
import { usePluginLibrarySync } from '@/hooks/usePluginLibrarySync';
import { cancelExternalLibrarySync, useExternalLibrarySync } from '@/services/plugins/library';
import { usePluginConnections } from '@/services/plugins/connections';

export function PluginSyncStatus({ connectionId }: { connectionId: string }) {
  const _ = useTranslation();
  const task = useExternalLibrarySync((s) => s.tasks[connectionId]);
  const start = usePluginLibrarySync();
  if (!task) return null;
  const active = task.phase === 'catalog' || task.phase === 'covers';
  const label =
    task.phase === 'catalog'
      ? _('Scanning library: {{count}} books', { count: task.books })
      : task.phase === 'covers'
        ? _('Loading covers: {{done}} / {{total}}', { done: task.covers, total: task.totalCovers })
        : task.phase === 'completed'
          ? _('Library synced')
          : task.phase === 'cancelled'
            ? _('Sync cancelled')
            : _('Library sync failed');
  return (
    <div className='flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-sm'>
      <span role='status' className='min-w-0 break-words'>
        {label}
      </span>
      {active ? (
        <button
          type='button'
          className='btn btn-sm btn-ghost eink-bordered shrink-0'
          onClick={() => cancelExternalLibrarySync(connectionId)}
        >
          {_('Cancel')}
        </button>
      ) : (
        task.phase !== 'completed' && (
          <button
            type='button'
            className='btn btn-sm btn-ghost eink-bordered shrink-0'
            onClick={() => start(connectionId)}
          >
            {_('Retry')}
          </button>
        )
      )}
    </div>
  );
}

export function PluginSyncIndicator() {
  const tasks = useExternalLibrarySync((s) => s.tasks);
  const connections = usePluginConnections((s) => s.connections);
  const visible = connections.filter(
    (c) => !c.deletedAt && ['catalog', 'covers', 'failed'].includes(tasks[c.id]?.phase ?? ''),
  );
  if (!visible.length) return null;
  return (
    <div className='bg-base-100 border-base-300 max-h-36 overflow-y-auto border-b px-4'>
      {visible.map((c) => (
        <div key={c.id} className='flex min-w-0 flex-wrap items-center gap-x-3'>
          <span className='max-w-full truncate text-sm'>{c.name}</span>
          <div className='min-w-0 flex-1'>
            <PluginSyncStatus connectionId={c.id} />
          </div>
        </div>
      ))}
    </div>
  );
}
