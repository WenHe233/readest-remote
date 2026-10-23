import type { ChapterContent } from '@readest/plugin-sdk';
import { readPluginRecord } from '@/services/plugins/persistence';
import { md5 } from '@/utils/md5';
import { sourceBookHash, type ChapterEntry, type SourceBookRef } from './catalog';

/** Search has no runtime fallback: only committed chapter downloads can contribute text. */
export async function* loadDownloadedSourceText(
  source: SourceBookRef,
  signal?: AbortSignal,
): AsyncGenerator<{ chapter: ChapterEntry; text: string }, void> {
  const hash = sourceBookHash(source.instanceId, source.work.id);
  const directory = await readPluginRecord<{ entries: ChapterEntry[] }>(`source-directory:${hash}`);
  for (const chapter of directory?.entries ?? []) {
    signal?.throwIfAborted();
    const saved = await readPluginRecord<{ completedAt?: number; content: ChapterContent }>(
      `source-download:${hash}:${md5(chapter.id)}`,
    );
    if (!saved?.completedAt || saved.content.kind !== 'html') continue;
    const template = document.createElement('template');
    template.innerHTML = saved.content.html;
    template.content.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
    yield { chapter, text: template.content.textContent ?? '' };
  }
  signal?.throwIfAborted();
}
