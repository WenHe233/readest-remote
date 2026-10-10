import type { BundledPluginDefinition } from './catalog';
import type { PluginWorkerLike } from './runtime';
const definitions = new Map<string, BundledPluginDefinition>();
const workers = new Map<string, Set<PluginWorkerLike>>();
const storageGrants = new Map<string, () => boolean>();
export function assertExternalStoragePermission(id: string): void {
  const allowed = storageGrants.get(id);
  if (allowed && !allowed()) throw new Error('Plugin storage permission denied');
}
export const externalPluginDefinitions = (): BundledPluginDefinition[] => [...definitions.values()];
export function unregisterExternalPlugin(id: string): void {
  definitions.delete(id);
  storageGrants.delete(id);
  for (const worker of [...(workers.get(id) ?? [])]) {
    worker.onerror?.(new ErrorEvent('error', { message: 'Plugin execution was revoked' }));
    worker.terminate();
  }
  workers.delete(id);
}
export function registerExternalPlugin(
  definition: BundledPluginDefinition,
  storageAllowed = () => false,
): void {
  const id = definition.manifest.id;
  unregisterExternalPlugin(id);
  const registered: BundledPluginDefinition = {
    ...definition,
    createWorker(role) {
      if (definitions.get(id) !== registered) throw new Error('Plugin execution was revoked');
      const worker = definition.createWorker(role);
      const group = workers.get(id) ?? new Set();
      workers.set(id, group);
      group.add(worker);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        group.delete(worker);
        terminate();
      };
      return worker;
    },
  };
  definitions.set(id, registered);
  storageGrants.set(id, storageAllowed);
}
