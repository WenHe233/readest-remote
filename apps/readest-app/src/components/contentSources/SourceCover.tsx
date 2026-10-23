import { useEffect, useRef, useState } from 'react';
import type { SourceBookRef } from '@/services/contentSources/catalog';
import { loadSourceCover } from '@/services/contentSources/covers';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { invalidateSourceResource, sourceBookHash } from '@/services/contentSources/catalog';

export default function SourceCover({
  source,
  className = 'h-28 w-20',
}: {
  source: SourceBookRef;
  className?: string;
}) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const savedBook = useLibraryStore((state) =>
    state.library.find(
      (item) => item.hash === sourceBookHash(source.instanceId, source.work.id) && !item.deletedAt,
    ),
  );
  const savedCover = savedBook?.metadata?.coverImageUrl || savedBook?.coverImageUrl;
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = async () => {
    setFailed(false);
    try {
      if (savedCover && savedBook && appService) {
        setUrl(await appService.generateCoverImageUrl(savedBook));
        return;
      }
      if (source.work.cover) await invalidateSourceResource(source, source.work.cover);
      setAttempt((value) => value + 1);
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (savedCover) {
      setUrl(savedCover);
      setFailed(false);
      return;
    }
    if (!visible || !source.work.cover) return;
    const controller = new AbortController();
    let owned = '';
    setUrl('');
    setFailed(false);
    void loadSourceCover(source, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        owned = URL.createObjectURL(blob);
        setUrl(owned);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [
    savedCover,
    visible,
    source.instanceId,
    source.work.id,
    source.work.cover?.id,
    source.work.revision,
    attempt,
  ]);
  return (
    <div
      ref={element}
      className={`eink-bordered bg-base-200 relative flex shrink-0 items-center justify-center overflow-hidden rounded ${className}`}
    >
      <span aria-hidden className='text-base-content/50 px-1 text-center text-xs'>
        {source.work.title.slice(0, 16)}
      </span>
      {url && (
        <img
          src={url}
          alt=''
          className='absolute inset-0 h-full w-full object-cover'
          onError={() => {
            setUrl('');
            setFailed(true);
          }}
        />
      )}
      {failed && (
        <button
          type='button'
          className='btn btn-xs btn-ghost eink-bordered absolute inset-x-0 bottom-0 bg-base-100'
          onClick={(event) => {
            event.stopPropagation();
            void retry();
          }}
        >
          {_('Retry cover')}
        </button>
      )}
    </div>
  );
}
