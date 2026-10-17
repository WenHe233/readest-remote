import { useEnv } from '@/context/EnvContext';
import { useTranslation } from './useTranslation';
import { syncExternalLibrary } from '@/services/plugins/library';
import { eventDispatcher } from '@/utils/event';

export function usePluginLibrarySync() {
  const { appService } = useEnv();
  const _ = useTranslation();
  return (id: string) => {
    if (!appService) return;
    void syncExternalLibrary(appService, id).then(
      () => eventDispatcher.dispatch('toast', { type: 'success', message: _('Library synced') }),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        void eventDispatcher.dispatch('toast', {
          type: 'error',
          message: _('Library sync failed. Retry from Library connections.'),
        });
      },
    );
  };
}
