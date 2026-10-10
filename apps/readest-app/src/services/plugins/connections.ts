import { create } from 'zustand';
import { listPluginRecords, readPluginRecord, writePluginRecords } from './persistence';
import {
  pluginConnectionSchema,
  type PluginConnection,
  type PluginConnectionReplica,
  type PluginDeviceConfig,
} from './types';
import { getConnectionSecrets, setConnectionSecrets } from './vault';
export const usePluginConnections = create<{ connections: PluginConnection[]; loaded: boolean }>(
  () => ({ connections: [], loaded: false }),
);
let loading: Promise<void> | undefined;
export async function loadPluginConnections(): Promise<void> {
  return (loading ??= (async () => {
    const records = await listPluginRecords<unknown>('connection:');
    usePluginConnections.setState({
      connections: records.flatMap(({ value }) => {
        const parsed = pluginConnectionSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
      loaded: true,
    });
  })().catch((error) => {
    loading = undefined;
    throw error;
  }));
}
export const getPluginConnection = (id: string): PluginConnection | undefined =>
  usePluginConnections.getState().connections.find((c) => c.id === id && !c.deletedAt);
export async function savePluginConnection(
  connection: PluginConnection,
  secrets?: Record<string, string>,
  publish = true,
): Promise<void> {
  await loadPluginConnections();
  const row = pluginConnectionSchema.parse(connection);
  const url = new URL(row.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use an HTTP(S) server URL without credentials or query parameters');
  row.url = url.href.replace(/\/+$/u, '');
  if (secrets) await setConnectionSecrets(row.id, secrets);
  await writePluginRecords({ ['connection:' + row.id]: row });
  usePluginConnections.setState((state) => ({
    connections: [...state.connections.filter((c) => c.id !== row.id), row],
  }));
  if (publish) {
    const { publishReplicaUpsert } = await import('@/services/sync/replicaPublish');
    const replica: PluginConnectionReplica = {
      ...row,
      credentials: JSON.stringify(await getConnectionSecrets(row.id)),
    };
    await publishReplicaUpsert('plugin_connection', replica, row.id, row.reincarnation);
  }
}
export async function removePluginConnection(id: string, publish = true): Promise<void> {
  const existing = getPluginConnection(id);
  if (!existing) return;
  await savePluginConnection(
    { ...existing, deletedAt: Date.now(), updatedAt: Date.now() },
    undefined,
    false,
  );
  if (publish) {
    const { publishReplicaDelete } = await import('@/services/sync/replicaPublish');
    await publishReplicaDelete('plugin_connection', id);
  }
}
export async function applyPluginConnection(replica: PluginConnectionReplica): Promise<void> {
  await loadPluginConnections();
  const local = usePluginConnections.getState().connections.find((c) => c.id === replica.id);
  if (
    local &&
    (local.pluginId !== replica.pluginId ||
      local.fingerprint !== replica.fingerprint ||
      local.sourceId !== replica.sourceId)
  )
    throw new Error('Synced connection identity conflicts with the local connection');
  let secrets: Record<string, string> | undefined;
  if (replica.credentials !== undefined) {
    const parsed: unknown = JSON.parse(replica.credentials);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === 'string')
    )
      secrets = parsed as Record<string, string>;
  }
  await savePluginConnection(
    { ...replica, lastSeenCipher: { ...local?.lastSeenCipher, ...replica.lastSeenCipher } },
    secrets,
    false,
  );
}
export const getPluginDeviceConfig = async (id: string): Promise<PluginDeviceConfig> =>
  (await readPluginRecord<PluginDeviceConfig>('device:' + id)) ?? {};
export const savePluginDeviceConfig = async (
  id: string,
  value: PluginDeviceConfig,
): Promise<void> => writePluginRecords({ ['device:' + id]: value });
