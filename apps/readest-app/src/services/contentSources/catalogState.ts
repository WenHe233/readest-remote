import type { Chapter } from '@readest/plugin-sdk';

export type ChapterEntry = Chapter & { slot: number; removed?: boolean };
export function reconcileSourceChapters(
  previous: ChapterEntry[],
  incoming: Chapter[],
): ChapterEntry[] {
  if (previous.length && !incoming.length)
    throw new Error('An empty chapter response cannot replace a saved directory.');
  const old = new Map(previous.map((chapter) => [chapter.id, chapter]));
  const seen = new Set<string>();
  let slot = previous.reduce((maximum, chapter) => Math.max(maximum, chapter.slot + 1), 0);
  const current = incoming.map((chapter) => {
    if (seen.has(chapter.id)) throw new Error('The directory contains a duplicate chapter ID.');
    seen.add(chapter.id);
    return { ...chapter, slot: old.get(chapter.id)?.slot ?? slot++ };
  });
  return [
    ...current,
    ...previous
      .filter((chapter) => !seen.has(chapter.id))
      .map((chapter) => ({ ...chapter, removed: true })),
  ];
}
