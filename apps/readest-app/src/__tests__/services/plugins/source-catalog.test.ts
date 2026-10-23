import { describe, expect, it } from 'vitest';
import { reconcileSourceChapters } from '@/services/contentSources/catalogState';

describe('stable online chapter identity', () => {
  it('retains slots after insertions/reorders and tombstones removed chapters', () => {
    const first = reconcileSourceChapters(
      [],
      [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
    );
    const second = reconcileSourceChapters(first, [
      { id: 'c', title: 'C' },
      { id: 'b', title: 'B renamed' },
    ]);
    expect(second.map(({ id, slot, removed }) => ({ id, slot, removed: !!removed }))).toEqual([
      { id: 'c', slot: 2, removed: false },
      { id: 'b', slot: 1, removed: false },
      { id: 'a', slot: 0, removed: true },
    ]);
    expect(
      reconcileSourceChapters(second, [{ id: 'a', title: 'A restored' }]).find(
        (chapter) => chapter.id === 'a',
      )?.slot,
    ).toBe(0);
  });
  it('does not silently accept a duplicate chapter identity or an empty replacement', () => {
    expect(() =>
      reconcileSourceChapters(
        [],
        [
          { id: 'a', title: 'First' },
          { id: 'a', title: 'Different' },
        ],
      ),
    ).toThrow(/duplicate/i);
    expect(() => reconcileSourceChapters([{ id: 'a', title: 'A', slot: 0 }], [])).toThrow(/empty/i);
  });
});
