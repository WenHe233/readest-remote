const writes = new Map<string, Promise<unknown>>();
const manualVersions = new Map<string, number>();

export const bookCoverWriteVersion = (hash: string): number => manualVersions.get(hash) ?? 0;

/** Invalidate automatic downloads as soon as a manual edit starts, before its file is ready. */
export function beginManualCoverWrite(hash: string): void {
  manualVersions.set(hash, bookCoverWriteVersion(hash) + 1);
}

/** The user edit and automatic source cover must never write the same file concurrently. */
export function withBookCoverWrite<T>(hash: string, operation: () => Promise<T>): Promise<T> {
  const pending = (writes.get(hash) ?? Promise.resolve()).catch(() => {}).then(operation);
  const tracked = pending.finally(() => {
    if (writes.get(hash) === tracked) writes.delete(hash);
  });
  writes.set(hash, tracked);
  return tracked;
}
