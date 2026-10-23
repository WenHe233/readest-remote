import { create } from 'zustand';
import { listPluginRecords, readPluginRecord, writePluginRecords } from '../plugins/persistence';
import { clearContentCache, getContentCacheBytes } from '../plugins/cache';
import {
  downloadSourceChapters,
  sourceBookHash,
  type SourceBookRef,
  type SourceDownloadProgress,
} from './catalog';
import { normalizeSourceError, type SourceOperationError } from './errors';

export interface SourceDownloadTask {
  id: string;
  ref: SourceBookRef;
  chapterIds: string[];
  state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progress: SourceDownloadProgress;
  error?: Pick<SourceOperationError, 'code' | 'stage' | 'status' | 'retryable'>;
  createdAt: number;
  updatedAt: number;
}
export const useSourceDownloadQueue = create<{ tasks: Record<string, SourceDownloadTask> }>(() => ({
  tasks: {},
}));
const prefix = 'source-download-task:';
let loaded: Promise<void> | undefined;
let writes: Promise<void> = Promise.resolve();
let active: { id: string; controller: AbortController; done: Promise<void> } | undefined;
let pumping = false;
let controls: Promise<unknown> = Promise.resolve();
let services = 0;
let serviceStopped = false;
const foreground = () =>
  !serviceStopped && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
const control = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = controls.catch(() => {}).then(operation);
  controls = result.catch(() => {});
  return result;
};

function save(task: SourceDownloadTask): Promise<void> {
  useSourceDownloadQueue.setState((state) => ({ tasks: { ...state.tasks, [task.id]: task } }));
  const snapshot = structuredClone(task);
  const operation = writes
    .catch(() => {})
    .then(() => writePluginRecords({ [prefix + task.id]: snapshot }));
  writes = operation;
  return operation;
}
function update(id: string, patch: Partial<SourceDownloadTask>) {
  const task = useSourceDownloadQueue.getState().tasks[id];
  return task ? save({ ...task, ...patch, updatedAt: Date.now() }) : Promise.resolve();
}

async function run(task: SourceDownloadTask, controller: AbortController): Promise<void> {
  const { signal } = controller;
  try {
    await update(task.id, { state: 'running', error: undefined });
    signal.throwIfAborted();
    await downloadSourceChapters(task.ref, task.chapterIds, signal, (progress) => {
      if (useSourceDownloadQueue.getState().tasks[task.id]?.state === 'running') {
        void update(task.id, { progress }).catch(() => {
          controller.abort();
        });
      }
    });
    if (!signal.aborted && useSourceDownloadQueue.getState().tasks[task.id]?.state === 'running')
      await update(task.id, { state: 'completed' });
  } catch (error) {
    if (useSourceDownloadQueue.getState().tasks[task.id]?.state === 'running') {
      const { code, stage, status, retryable } = normalizeSourceError(error, 'download');
      await update(task.id, { state: 'failed', error: { code, stage, status, retryable } });
    }
  } finally {
    await writes.catch(() => {});
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (foreground()) {
      const task = Object.values(useSourceDownloadQueue.getState().tasks).find(
        (item) => item.state === 'queued',
      );
      if (!task) break;
      const controller = new AbortController();
      const done = run(task, controller);
      const running = { id: task.id, controller, done };
      active = running;
      try {
        await done;
      } finally {
        // A failed checkpoint (for example full storage) must not leave a
        // rejected run attached to the task and make every later retry fail.
        if (active === running) active = undefined;
      }
    }
  } finally {
    pumping = false;
  }
}
const kick = () => {
  void pump().catch(() => {});
};

export function initializeSourceDownloads(): Promise<void> {
  return (loaded ??= (async () => {
    const rows = await listPluginRecords<SourceDownloadTask>(prefix);
    const tasks: Record<string, SourceDownloadTask> = Object.create(null);
    for (const { value } of rows) {
      tasks[value.id] = { ...value, state: value.state === 'running' ? 'queued' : value.state };
    }
    useSourceDownloadQueue.setState({ tasks });
    kick();
  })().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  }));
}

async function enqueue(ref: SourceBookRef, chapterIds: string[]): Promise<string> {
  await initializeSourceDownloads();
  if (!chapterIds.length) throw new Error('Select chapters to download.');
  const hash = sourceBookHash(ref.instanceId, ref.work.id);
  const existing = Object.values(useSourceDownloadQueue.getState().tasks).find(
    (task) =>
      sourceBookHash(task.ref.instanceId, task.ref.work.id) === hash &&
      ['running', 'queued', 'paused', 'failed'].includes(task.state),
  );
  // Stop before changing the work set, then resume verified per-resource checkpoints.
  if (existing) await pause(existing.id);
  const id = existing?.id ?? crypto.randomUUID();
  const ids = [...new Set([...(existing?.chapterIds ?? []), ...chapterIds])];
  await save({
    id,
    ref,
    chapterIds: ids,
    state: 'queued',
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    progress: { completed: 0, total: ids.length, phase: 'downloading' },
  });
  kick();
  return id;
}
async function pause(id: string): Promise<void> {
  const running = active?.id === id ? active : undefined;
  const saved = update(id, { state: 'paused' });
  // Network cancellation must not wait behind progress writes in IndexedDB.
  running?.controller.abort();
  await saved;
  await running?.done;
}
async function resume(id: string): Promise<void> {
  await initializeSourceDownloads();
  if (useSourceDownloadQueue.getState().tasks[id]?.state === 'running') return;
  if (active?.id === id) await active.done;
  await update(id, { state: 'queued', error: undefined });
  kick();
}
async function cancel(id: string): Promise<void> {
  await pause(id);
  await update(id, { state: 'cancelled' });
}
export const enqueueSourceDownloads = (ref: SourceBookRef, chapterIds: string[]) =>
  control(() => enqueue(ref, chapterIds));
export const pauseSourceDownload = (id: string) => control(() => pause(id));
export const resumeSourceDownload = (id: string) => control(() => resume(id));
export const cancelSourceDownload = (id: string) => control(() => cancel(id));

/** App-shell lifetime, independent from the source management dialog. */
export function startSourceDownloadService(): () => void {
  services++;
  serviceStopped = false;
  void initializeSourceDownloads().catch(() => {});
  kick();
  const visibility = () => {
    if (foreground()) {
      kick();
      return;
    }
    if (active) {
      const task = active;
      // Preserve intent to continue on foreground/restart while retaining all
      // committed checkpoints. No guarantee of iOS background execution.
      if (useSourceDownloadQueue.getState().tasks[task.id]?.state === 'running')
        void update(task.id, { state: 'queued' }).catch(() => {});
      task.controller.abort();
    }
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('online', kick);
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('online', kick);
    services--;
    if (services > 0) return;
    serviceStopped = true;
    if (active) {
      if (useSourceDownloadQueue.getState().tasks[active.id]?.state === 'running')
        void update(active.id, { state: 'queued' }).catch(() => {});
      active.controller.abort();
    }
  };
}

interface StoredChapterSize {
  content: unknown;
  resources: Record<string, { key: string; size?: number }>;
}
export async function getSourceStorageUsage(): Promise<{
  temporary: number;
  incomplete: number;
  completed: number;
}> {
  const total = async (recordPrefix: string) => {
    let size = 0;
    for (const { value } of await listPluginRecords<StoredChapterSize>(recordPrefix)) {
      if (!value.resources) continue; // x1 status marker.
      size += new TextEncoder().encode(JSON.stringify(value.content)).byteLength;
      for (const resource of Object.values(value.resources)) {
        // x1 migration reads one resource at a time, never an entire chapter.
        size +=
          resource.size ?? (await readPluginRecord<Uint8Array>(resource.key))?.byteLength ?? 0;
      }
    }
    return size;
  };
  return {
    temporary: await getContentCacheBytes(),
    incomplete: await total('source-download-stage:'),
    completed: await total('source-download:'),
  };
}
export const clearSourceTemporaryCache = () => clearContentCache();
async function clearIncomplete(): Promise<void> {
  await initializeSourceDownloads();
  for (const task of Object.values(useSourceDownloadQueue.getState().tasks)) {
    if (task.state !== 'completed') await cancel(task.id);
  }
  const rows = await listPluginRecords<StoredChapterSize>('source-download-stage:');
  await writePluginRecords(
    {},
    rows.flatMap(({ key, value }) => [
      key,
      ...Object.values(value.resources).map((resource) => resource.key),
    ]),
  );
}
export const clearIncompleteSourceDownloads = () => control(clearIncomplete);
