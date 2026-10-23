// Capability modules subscribe here without making the plugin manager depend on their runtimes.
const listeners = new Set<(pluginId: string) => void>();
const epochs = new Map<string, number>();
const resetting = new Set<string>();
export const pluginLifecycleEpoch = (id: string): number => epochs.get(id) ?? 0;
export const isPluginDataResetting = (id: string): boolean => resetting.has(id);
export function onPluginStopped(listener: (pluginId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function stopPluginDependents(id: string): void {
  epochs.set(id, pluginLifecycleEpoch(id) + 1);
  for (const listener of listeners) listener(id);
}
export function beginPluginDataReset(id: string): () => void {
  resetting.add(id);
  return () => {
    resetting.delete(id);
  };
}
