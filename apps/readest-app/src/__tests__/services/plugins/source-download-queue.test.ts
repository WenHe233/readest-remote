import { beforeEach, expect, it, vi } from 'vitest';
import type { SourceBookRef, SourceDownloadProgress } from '@/services/contentSources/catalog';

const memory = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  download: vi.fn(),
  write: vi.fn(),
}));
vi.mock('@/services/plugins/persistence', () => ({
  listPluginRecords: async (prefix: string) =>
    [...memory.records]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) })),
  writePluginRecords: async (records: Record<string, unknown>, remove: string[] = []) => {
    await memory.write(records);
    Object.entries(records).forEach(([key, value]) =>
      memory.records.set(key, structuredClone(value)),
    );
    remove.forEach((key) => memory.records.delete(key));
  },
}));
vi.mock('@/services/contentSources/catalog', () => ({
  sourceBookHash: (instance: string, work: string) => `${instance}:${work}`,
  downloadSourceChapters: memory.download,
}));
vi.mock('@/services/plugins/cache', () => ({
  getContentCacheBytes: async () => 0,
  clearContentCache: async () => {},
}));
const ref: SourceBookRef = {
  instanceId: '7fdbce26-4387-4a0e-80f1-f4e922ab23e2',
  pluginId: 'example.plugin',
  fingerprint: 'a'.repeat(64),
  work: { id: 'book', title: 'Book', author: '', kind: 'comic' },
};
beforeEach(() => {
  vi.resetModules();
  memory.records.clear();
  memory.download.mockReset();
  memory.write.mockReset().mockResolvedValue(undefined);
});

it('aborts a paused download before waiting for slow task persistence', async () => {
  let signal!: AbortSignal;
  let finish!: () => void;
  memory.download.mockImplementation((_ref, _ids, currentSignal: AbortSignal) => {
    signal = currentSignal;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const queue = await import('@/services/contentSources/downloads');
  const id = await queue.enqueueSourceDownloads(ref, ['a']);
  await vi.waitFor(() => expect(memory.download).toHaveBeenCalledTimes(1));
  let flush!: () => void;
  memory.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        flush = resolve;
      }),
  );
  const pausing = queue.pauseSourceDownload(id);
  try {
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    finish();
    expect(queue.useSourceDownloadQueue.getState().tasks[id]?.state).toBe('paused');
  } finally {
    finish();
    flush();
    await pausing;
  }
  expect(queue.useSourceDownloadQueue.getState().tasks[id]?.state).toBe('paused');
});

it('merges concurrent additions to the same running work without losing chapters', async () => {
  memory.download.mockImplementation(
    (_ref, _ids, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const queue = await import('@/services/contentSources/downloads');
  const id = await queue.enqueueSourceDownloads(ref, ['a']);
  await vi.waitFor(() => expect(memory.download).toHaveBeenCalledTimes(1));
  const ids = await Promise.all([
    queue.enqueueSourceDownloads(ref, ['b']),
    queue.enqueueSourceDownloads(ref, ['c']),
  ]);
  await queue.pauseSourceDownload(id);
  expect(ids).toEqual([id, id]);
  expect(queue.useSourceDownloadQueue.getState().tasks[id]?.chapterIds).toEqual(['a', 'b', 'c']);
});

it('does not restart work when the app-shell download service unmounts', async () => {
  memory.download.mockImplementation(
    (_ref, _ids, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const queue = await import('@/services/contentSources/downloads');
  const stop = queue.startSourceDownloadService();
  const id = await queue.enqueueSourceDownloads(ref, ['a']);
  await vi.waitFor(() => expect(memory.download).toHaveBeenCalledTimes(1));
  stop();
  await vi.waitFor(() =>
    expect(queue.useSourceDownloadQueue.getState().tasks[id]?.state).toBe('queued'),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(memory.download).toHaveBeenCalledTimes(1);
  const stopAgain = queue.startSourceDownloadService();
  await vi.waitFor(() => expect(memory.download).toHaveBeenCalledTimes(2));
  await queue.pauseSourceDownload(id);
  stopAgain();
  expect(queue.useSourceDownloadQueue.getState().tasks[id]?.state).toBe('paused');
});

it('persists a queue independently of the caller, pauses and resumes with the same task identity', async () => {
  memory.download.mockImplementationOnce(
    (_ref: SourceBookRef, _ids: string[], signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  );
  const queue = await import('@/services/contentSources/downloads');
  const id = await queue.enqueueSourceDownloads(ref, ['chapter']);
  await vi.waitFor(() => expect(memory.download).toHaveBeenCalledTimes(1));
  await queue.pauseSourceDownload(id);
  expect(queue.useSourceDownloadQueue.getState().tasks[id]?.state).toBe('paused');
  expect([...memory.records.values()]).toContainEqual(
    expect.objectContaining({ id, state: 'paused' }),
  );
  memory.download.mockResolvedValue(undefined);
  await queue.resumeSourceDownload(id);
  await vi.waitFor(() =>
    expect(queue.useSourceDownloadQueue.getState().tasks[id]?.state).toBe('completed'),
  );
  expect(memory.download).toHaveBeenCalledTimes(2);
});

it('resumes after progress and failed-state persistence both run out of storage', async () => {
  let reportProgress!: (progress: SourceDownloadProgress) => void;
  memory.download.mockImplementationOnce(
    (
      _ref: SourceBookRef,
      _ids: string[],
      signal: AbortSignal,
      progress: (value: SourceDownloadProgress) => void,
    ) => {
      reportProgress = progress;
      return new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  );
  const queue = await import('@/services/contentSources/downloads');
  const id = await queue.enqueueSourceDownloads(ref, ['chapter']);
  await vi.waitFor(() => expect(memory.download).toHaveBeenCalledTimes(1));

  memory.write.mockRejectedValue(new DOMException('Storage quota exceeded', 'QuotaExceededError'));
  reportProgress({ completed: 0, total: 1, phase: 'downloading' });
  await vi.waitFor(() => {
    expect(queue.useSourceDownloadQueue.getState().tasks[id]?.state).toBe('failed');
    expect(memory.write).toHaveBeenCalledWith({
      [`source-download-task:${id}`]: expect.objectContaining({ id, state: 'failed' }),
    });
  });

  memory.write.mockResolvedValue(undefined);
  memory.download.mockResolvedValue(undefined);
  await expect(queue.resumeSourceDownload(id)).resolves.toBeUndefined();
  await vi.waitFor(() =>
    expect(queue.useSourceDownloadQueue.getState().tasks[id]?.state).toBe('completed'),
  );
  expect(memory.download).toHaveBeenCalledTimes(2);
});

it('recovers an interrupted persisted task after restart without requeuing manually paused tasks', async () => {
  const base = {
    ref,
    chapterIds: ['chapter'],
    createdAt: 1,
    updatedAt: 1,
    progress: { completed: 0, total: 1, phase: 'downloading' },
  };
  memory.records.set('source-download-task:running', { ...base, id: 'running', state: 'running' });
  memory.records.set('source-download-task:paused', { ...base, id: 'paused', state: 'paused' });
  memory.download.mockResolvedValue(undefined);
  const queue = await import('@/services/contentSources/downloads');
  await queue.initializeSourceDownloads();
  await vi.waitFor(() =>
    expect(queue.useSourceDownloadQueue.getState().tasks['running']?.state).toBe('completed'),
  );
  expect(queue.useSourceDownloadQueue.getState().tasks['paused']?.state).toBe('paused');
  expect(memory.download).toHaveBeenCalledTimes(1);
});
