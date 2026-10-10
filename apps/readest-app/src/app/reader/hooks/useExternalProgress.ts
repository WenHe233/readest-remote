import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReadingPosition } from '@readest/plugin-sdk';
import { useBookDataStore } from '@/store/bookDataStore';
import { getBookProgress, useBookProgress } from '@/store/readerProgressStore';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { getExternalSource } from '@/services/plugins/bookSource';
import { getLibraryRuntime } from '@/services/plugins/manager';
import {
  capturePluginPosition,
  getSavedPluginProgress,
  progressDecision,
  pushPluginPosition,
  resolvePluginPosition,
  savePluginProgress,
} from '@/services/plugins/progress';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import type { SyncDetails } from './useKOSync';

export function useExternalProgress(bookKey: string) {
  const _ = useTranslation();
  const progress = useBookProgress(bookKey);
  const book = useBookDataStore((s) => s.getBookData(bookKey)?.book);
  const source = book ? getExternalSource(book) : undefined;
  const [conflictDetails, setConflictDetails] = useState<SyncDetails | null>(null);
  const pendingRemote = useRef<ReadingPosition | null>(null);
  const ready = useRef(false),
    started = useRef(false),
    pulling = useRef(false),
    applying = useRef(false),
    alive = useRef(true);
  const lastLocation = useRef<string | undefined>(undefined);
  const moved = useRef(false);
  const pushRef = useRef<() => Promise<void>>(async () => {});
  const pullRef = useRef<() => Promise<void>>(async () => {});
  const debounced = useMemo(() => debounce(() => void pushRef.current(), 5000), []);
  const capture = async () => {
    const data = useBookDataStore.getState().getBookData(bookKey);
    const position = getBookProgress(bookKey);
    const view = useReaderStore.getState().getView(bookKey);
    if (
      !data?.book ||
      !data.bookDoc ||
      !position ||
      !view ||
      useReaderStore.getState().getViewState(bookKey)?.previewMode
    )
      return null;
    return {
      book: data.book,
      position: await capturePluginPosition(data.book, data.bookDoc, position, view),
    };
  };
  pushRef.current = async () => {
    if (!source || pendingRemote.current || applying.current || (!ready.current && !moved.current))
      return;
    try {
      const captured = await capture();
      if (!captured) return;
      if (ready.current) await pushPluginPosition(captured.book, captured.position);
      else await savePluginProgress(captured.book.hash, captured.position, true);
    } catch {
      ready.current = false; /* Persisted queue is retried after a conflict-aware pull. */
    }
  };
  const applyRemote = async (remote: ReadingPosition) => {
    const view = useReaderStore.getState().getView(bookKey);
    if (!view || !book) return;
    applying.current = true;
    try {
      if (remote.cfi) await Promise.resolve(view.goTo(remote.cfi));
      else if (remote.kind === 'page') await Promise.resolve(view.goTo(remote.pageIndex ?? 0));
      else await Promise.resolve(view.goToFraction(remote.fraction));
      await savePluginProgress(book.hash, remote, false);
      pendingRemote.current = null;
      if (alive.current) setConflictDetails(null);
      ready.current = true;
    } finally {
      applying.current = false;
    }
  };
  pullRef.current = async () => {
    if (!source || !book || pulling.current || pendingRemote.current) return;
    const data = useBookDataStore.getState().getBookData(bookKey);
    const view = useReaderStore.getState().getView(bookKey);
    const atStart = getBookProgress(bookKey)?.location;
    if (!data?.bookDoc || !view || !atStart) return;
    started.current = true;
    pulling.current = true;
    ready.current = false;
    try {
      const target = await getLibraryRuntime(source.connectionId);
      const raw = await target.runtime.call(
        'library.pullProgress',
        { context: target.lease.context, book: source.item },
        { signal: AbortSignal.timeout(30_000) },
      );
      const remote = raw ? await resolvePluginPosition(raw, data.bookDoc, view) : null;
      if (!alive.current || useReaderStore.getState().getViewState(bookKey)?.previewMode) return;
      if (getBookProgress(bookKey)?.location !== atStart) {
        ready.current = true;
        debounced();
        return;
      }
      const saved = await getSavedPluginProgress(book.hash);
      let local = saved?.position ?? null;
      if (!local && (data.config?.progress?.[0] ?? 0) > 1) {
        const captured = await capture();
        if (captured) local = { ...captured.position, modified: data.config?.updatedAt ?? 0 };
      }
      const decision = progressDecision(local, remote);
      if (decision === 'ask' && remote && local) {
        pendingRemote.current = remote;
        setConflictDetails({
          book,
          bookDoc: data.bookDoc,
          local: {
            cfi: local.cfi,
            preview: _('Approximately {{percentage}}%', {
              percentage: (local.fraction * 100).toFixed(2),
            }),
          },
          remote: {
            device: target.connection.name,
            percentage: remote.fraction,
            preview:
              (remote.approximate ? _('Approximate position') + ' ' : '') +
              _('Approximately {{percentage}}%', {
                percentage: (remote.fraction * 100).toFixed(2),
              }),
          },
        });
      } else if (decision === 'remote' && remote) await applyRemote(remote);
      else {
        ready.current = true;
        if (local && saved?.pending) await pushPluginPosition(book, local);
      }
    } catch {
      /* Offline reads stay usable. Keep the queue until a later pull. */
    } finally {
      pulling.current = false;
    }
  };
  useEffect(() => {
    if (source && progress && !started.current) void pullRef.current();
  }, [source, progress]);
  useEffect(() => {
    const previous = lastLocation.current;
    lastLocation.current = progress?.location;
    if (
      !previous ||
      previous === progress?.location ||
      !source ||
      !started.current ||
      applying.current ||
      pendingRemote.current
    )
      return;
    moved.current = true;
    if (progress?.location) debounced();
  }, [source, progress?.location, debounced]);
  useEffect(() => {
    alive.current = true;
    if (!source) return;
    const flush = (event: CustomEvent) => {
      if (event.detail.bookKey === bookKey) {
        debounced.cancel();
        void pushRef.current();
      }
    };
    const retry = () => void pullRef.current();
    eventDispatcher.on('sync-book-progress', flush);
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    return () => {
      alive.current = false;
      eventDispatcher.off('sync-book-progress', flush);
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
      debounced.cancel();
    };
  }, [bookKey, source, debounced]);
  return {
    conflictDetails,
    resolveWithLocal: () => {
      pendingRemote.current = null;
      setConflictDetails(null);
      ready.current = true;
      void pushRef.current();
    },
    resolveWithRemote: () => {
      const remote = pendingRemote.current;
      if (remote) void applyRemote(remote);
    },
  };
}
