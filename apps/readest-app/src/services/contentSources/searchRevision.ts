import { create } from 'zustand';
import { readPluginRecord } from '../plugins/persistence';

export const sourceSearchRevisionKey = (bookHash: string) => `source-search-revision:${bookHash}`;
export const useSourceSearchRevisions = create<{ revisions: Record<string, string> }>(() => ({
  revisions: {},
}));

/** Call only after the chapter/revision transaction commits. */
export function publishSourceSearchRevision(bookHash: string, revision: string): void {
  useSourceSearchRevisions.setState((state) => ({
    revisions: { ...state.revisions, [bookHash]: revision },
  }));
}

/** Re-read on mount to see downloads changed by another window or a previous process. */
export async function loadSourceSearchRevisions(bookHashes: string[]): Promise<void> {
  const rows = await Promise.all(
    [...new Set(bookHashes)].map(async (hash) => {
      const observed = useSourceSearchRevisions.getState().revisions[hash];
      const saved = await readPluginRecord<unknown>(sourceSearchRevisionKey(hash));
      return { hash, observed, saved: typeof saved === 'string' ? saved : '' };
    }),
  );
  useSourceSearchRevisions.setState((state) => {
    const revisions = { ...state.revisions };
    for (const { hash, observed, saved } of rows) {
      // A download committed while the read was pending; do not restore its older revision.
      if (state.revisions[hash] === observed) revisions[hash] = saved;
    }
    return { revisions };
  });
}
