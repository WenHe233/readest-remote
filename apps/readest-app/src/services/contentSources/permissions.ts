import { create } from 'zustand';
import { getSourceInstance, saveSourceInstance } from './instances';
import { normalizeSourceOrigin } from './policy';

export const useSourceOriginRequests = create<{
  requests: Array<{ instanceId: string; origin: string }>;
}>(() => ({ requests: [] }));
export function queueSourceOrigin(instanceId: string, origin: string): void {
  const normalized = normalizeSourceOrigin(origin);
  useSourceOriginRequests.setState((state) => ({
    requests: state.requests.some(
      (item) => item.instanceId === instanceId && item.origin === normalized,
    )
      ? state.requests
      : [...state.requests, { instanceId, origin: normalized }].slice(-128),
  }));
}
export function dismissSourceOrigin(instanceId: string, origin: string): void {
  useSourceOriginRequests.setState((state) => ({
    requests: state.requests.filter(
      (item) => item.instanceId !== instanceId || item.origin !== origin,
    ),
  }));
}
export async function grantSourceOrigin(instanceId: string, origin: string): Promise<void> {
  const request = useSourceOriginRequests
    .getState()
    .requests.find((item) => item.instanceId === instanceId && item.origin === origin);
  const instance = getSourceInstance(instanceId);
  if (!request || !instance)
    throw new Error('This source permission request is no longer available.');
  await saveSourceInstance({
    ...instance,
    origins: [...instance.origins, normalizeSourceOrigin(origin)],
  });
  dismissSourceOrigin(instanceId, origin);
}
