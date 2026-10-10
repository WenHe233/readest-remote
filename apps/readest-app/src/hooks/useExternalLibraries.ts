import { retryQueuedPluginProgress } from '@/services/plugins/progress';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { eventDispatcher } from '@/utils/event';
import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { usePluginIngress } from './usePluginIngress';
import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { syncExternalLibraries } from '@/services/plugins/library';
export function useExternalLibraries(): void {
  usePluginIngress();
  const _ = useTranslation();
  const { appService } = useEnv();
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);
  useEffect(() => {
    if (!appService || !libraryLoaded) return;
    let running = false;
    const sync = async () => {
      if (running) return;
      running = true;
      try {
        await syncExternalLibraries(appService);
        const open = new Set(
          useReaderStore.getState().bookKeys.flatMap((key) => {
            const book = useBookDataStore.getState().getBookData(key)?.book;
            return book ? [book.hash] : [];
          }),
        );
        const conflicts = await retryQueuedPluginProgress(useLibraryStore.getState().library, open);
        if (conflicts.length)
          eventDispatcher.dispatch('toast', {
            type: 'info',
            timeout: 8000,
            message: _('Open these books to resolve server progress: {{titles}}', {
              titles: conflicts.slice(0, 3).join(', '),
            }),
          });
      } catch (error) {
        console.warn(
          'External plugins could not initialize',
          error instanceof Error ? error.message : 'Unknown error',
        );
      } finally {
        running = false;
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 5 * 60 * 1000);
    window.addEventListener('online', sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', sync);
    };
  }, [appService, libraryLoaded]);
}
