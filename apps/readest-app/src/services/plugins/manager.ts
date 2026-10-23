import { create } from 'zustand';
import { anySignal } from '@/utils/abort';
import { getPluginInstallState } from './installation';
import { verifyPluginPackage, type VerifiedPluginPackage } from './package';
import { readPluginRecord, listPluginRecords, writePluginRecords } from './persistence';
import {
  registerExternalPlugin,
  unregisterExternalPlugin,
  externalPluginDefinitions,
} from './externalCatalog';
import { createSandboxedPluginWorker } from './sandbox';
import { createPluginRuntime } from './runtime';
import { createConnectionLease, clearPluginPrivateStorage } from './httpBroker';
import { getPluginConnection, loadPluginConnections, usePluginConnections } from './connections';
import type { InstalledPlugin, PluginConnection, PluginDeviceConfig } from './types';
import { beginPluginDataReset, stopPluginDependents } from './lifecycle';

export const useInstalledPlugins = create<{ plugins: InstalledPlugin[]; loaded: boolean }>(() => ({
  plugins: [],
  loaded: false,
}));
const packages = new Map<string, VerifiedPluginPackage>();
const runtimes = new Map<string, ReturnType<typeof buildLibraryRuntime>>();
let loading: Promise<void> | undefined;
let changes: Promise<unknown> = Promise.resolve();
const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = changes.then(operation);
  changes = next.catch(() => {});
  return next;
};
export const findInstalledPlugin = (id: string): InstalledPlugin | undefined =>
  useInstalledPlugins.getState().plugins.find((p) => p.id === id);
function stop(id: string): void {
  stopPluginDependents(id);
  unregisterExternalPlugin(id);
  for (const [key, value] of runtimes)
    if (value.pluginId === id) {
      value.runtime.close();
      value.lease.close();
      runtimes.delete(key);
    }
  packages.delete(id);
}
function register(pkg: VerifiedPluginPackage): void {
  const installed = findInstalledPlugin(pkg.manifest.id)!;
  packages.set(pkg.manifest.id, pkg);
  registerExternalPlugin(
    {
      manifest: pkg.manifest,
      createWorker: () =>
        createSandboxedPluginWorker(pkg.workerSource, pkg.resources, installed.permissions),
    },
    () =>
      findInstalledPlugin(installed.id) === installed &&
      installed.enabled &&
      !!installed.permissions.storage,
  );
}
async function healthy(pkg: VerifiedPluginPackage): Promise<void> {
  const runtime = createPluginRuntime({
    createWorker: () =>
      createSandboxedPluginWorker(pkg.workerSource, pkg.resources, pkg.manifest.permissions),
  });
  try {
    await runtime.call('ping', {}, { signal: AbortSignal.timeout(10_000) });
  } finally {
    runtime.close();
  }
}
async function archive(hash: string): Promise<VerifiedPluginPackage> {
  const bytes = await readPluginRecord<Uint8Array>('archive:' + hash);
  if (!bytes) throw new Error('Installed plugin archive is missing');
  const pkg = await verifyPluginPackage(bytes);
  if (pkg.packageHash !== hash) throw new Error('Installed archive digest changed');
  return pkg;
}
async function persist(row: InstalledPlugin): Promise<void> {
  await writePluginRecords({ ['installed:' + row.id]: row });
  useInstalledPlugins.setState((state) => ({
    plugins: [...state.plugins.filter((p) => p.id !== row.id), row],
  }));
}
export async function loadPluginManager(): Promise<void> {
  return (loading ??= (async () => {
    const rows = await listPluginRecords<InstalledPlugin>('installed:');
    useInstalledPlugins.setState({ plugins: rows.map((r) => r.value), loaded: true });
    for (const { value: row } of rows) {
      if (!row.enabled) continue;
      try {
        const pkg = await archive(row.activeHash);
        if (pkg.fingerprint !== row.fingerprint || pkg.manifest.id !== row.id)
          throw new Error('Installed plugin identity changed');
        await healthy(pkg);
        register(pkg);
      } catch {
        if (row.previousHash) {
          try {
            const previous = await archive(row.previousHash);
            if (previous.manifest.id !== row.id || previous.fingerprint !== row.fingerprint)
              throw new Error('Previous plugin identity changed');
            await healthy(previous);
            await persist({
              ...row,
              manifest: previous.manifest,
              permissions: Object.fromEntries(
                Object.entries(previous.manifest.permissions ?? {}).map(([key, value]) => [
                  key,
                  value && row.permissions[key as keyof typeof row.permissions],
                ]),
              ),
              activeHash: previous.packageHash,
              previousHash: undefined,
              error: 'Previous version restored after startup failure',
            });
            register(previous);
            continue;
          } catch {
            /* Disable a failed rollback too. */
          }
        }
        await persist({ ...row, enabled: false, error: 'Plugin failed verification or startup' });
      }
    }
  })().catch((error) => {
    loading = undefined;
    throw error;
  }));
}
export async function installPlugin(
  candidate: VerifiedPluginPackage,
  permissionsApproved: boolean,
): Promise<void> {
  await loadPluginManager();
  return serialize(async () => {
    // Re-verify at commit time: callers cannot change a prepared manifest/code
    // without changing the signed archive approved in the install dialog.
    const pkg = await verifyPluginPackage(candidate.bytes);
    if (pkg.packageHash !== candidate.packageHash)
      throw new Error('Package changed during installation');
    const old = findInstalledPlugin(pkg.manifest.id);
    const trustedSigner =
      old?.fingerprint ?? (await readPluginRecord<string>('trusted-signer:' + pkg.manifest.id));
    if (trustedSigner && trustedSigner !== pkg.fingerprint)
      throw new Error('Plugin signer conflicts with the installed plugin');
    if (old && old.activeHash === pkg.packageHash) return;
    if (
      getPluginInstallState(
        { version: pkg.manifest.pluginVersion, fingerprint: pkg.fingerprint },
        old && { version: old.manifest.pluginVersion, fingerprint: old.fingerprint },
      ) === 'installed'
    )
      throw new Error('Install a newer version or use Roll back');
    if (!permissionsApproved) throw new Error('Plugin permissions require approval');
    await writePluginRecords({ ['archive:' + pkg.packageHash]: pkg.bytes });
    try {
      await healthy(pkg);
    } catch (error) {
      await writePluginRecords({}, ['archive:' + pkg.packageHash]);
      throw error;
    }
    const row: InstalledPlugin = {
      id: pkg.manifest.id,
      manifest: pkg.manifest,
      fingerprint: pkg.fingerprint,
      publicKey: pkg.publicKey,
      activeHash: pkg.packageHash,
      previousHash: old?.activeHash,
      enabled: true,
      permissions: pkg.manifest.permissions ?? {},
      installedAt: old?.installedAt ?? Date.now(),
    };
    await writePluginRecords({ ['trusted-signer:' + row.id]: row.fingerprint });
    await persist(row);
    stop(row.id);
    register(pkg);
    if (old?.previousHash && old.previousHash !== row.previousHash)
      await writePluginRecords({}, ['archive:' + old.previousHash]);
  });
}
export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await loadPluginManager();
  return serialize(async () => {
    const row = findInstalledPlugin(id);
    if (!row) return;
    if (enabled) {
      const pkg = await archive(row.activeHash);
      await healthy(pkg);
      await persist({ ...row, enabled, error: undefined });
      stop(id);
      register(pkg);
    } else {
      await persist({ ...row, enabled });
      stop(id);
    }
  });
}
export async function rollbackPlugin(id: string): Promise<void> {
  await loadPluginManager();
  return serialize(async () => {
    const row = findInstalledPlugin(id);
    if (!row?.previousHash) throw new Error('No previous version is available');
    const pkg = await archive(row.previousHash);
    if (pkg.fingerprint !== row.fingerprint || pkg.manifest.id !== id)
      throw new Error('Previous plugin signer mismatch');
    await healthy(pkg);
    await persist({
      ...row,
      manifest: pkg.manifest,
      activeHash: pkg.packageHash,
      previousHash: row.activeHash,
      permissions: Object.fromEntries(
        Object.entries(pkg.manifest.permissions ?? {}).map(([key, value]) => [
          key,
          value && row.permissions[key as keyof typeof row.permissions],
        ]),
      ),
      enabled: true,
      error: undefined,
    });
    stop(id);
    register(pkg);
  });
}
export async function uninstallPlugin(id: string): Promise<void> {
  await loadPluginManager();
  return serialize(async () => {
    const row = findInstalledPlugin(id);
    if (!row) return;
    stop(id);
    // Retained dictionaries, connections and books keep their original signer.
    // Removing the executable must not let another signer inherit those handles.
    await writePluginRecords({ ['trusted-signer:' + id]: row.fingerprint }, [
      'installed:' + id,
      'archive:' + row.activeHash,
      ...(row.previousHash ? ['archive:' + row.previousHash] : []),
    ]);
    useInstalledPlugins.setState((state) => ({
      plugins: state.plugins.filter((p) => p.id !== id),
    }));
  });
}
function buildLibraryRuntime(connectionId: string) {
  const connection = getPluginConnection(connectionId);
  if (!connection) throw new Error('Library connection is unavailable');
  const installed = findInstalledPlugin(connection.pluginId);
  const pkg = packages.get(connection.pluginId);
  if (!installed?.enabled || !pkg || installed.fingerprint !== connection.fingerprint)
    throw new Error('Install and enable the matching signed plugin first');
  if (!pkg.manifest.contributions.librarySources?.some((s) => s.id === connection.sourceId))
    throw new Error('Library source is unavailable');
  const allowed = () => findInstalledPlugin(connection.pluginId) === installed && installed.enabled;
  const lease = createConnectionLease(connection, installed.permissions, allowed);
  const definition = externalPluginDefinitions().find(
    (p) => p.manifest.id === connection.pluginId,
  )!;
  const runtime = createPluginRuntime({
    createWorker: () => definition.createWorker('lookup'),
    handleHostCall: lease.handleHostCall,
  });
  return { pluginId: connection.pluginId, connection, lease, runtime };
}
export async function getLibraryRuntime(connectionId: string) {
  await Promise.all([loadPluginManager(), loadPluginConnections()]);
  const live = getPluginConnection(connectionId);
  const existing = runtimes.get(connectionId);
  if (existing && existing.connection.updatedAt === live?.updatedAt) return existing;
  if (existing) {
    existing.runtime.close();
    existing.lease.close();
    runtimes.delete(connectionId);
  }
  const created = buildLibraryRuntime(connectionId);
  runtimes.set(connectionId, created);
  return created;
}

// Editing or deleting a connection immediately revokes its running lease.
usePluginConnections.subscribe(({ connections }) => {
  for (const [id, target] of runtimes) {
    const live = connections.find((connection) => connection.id === id && !connection.deletedAt);
    if (!live || live.updatedAt !== target.connection.updatedAt) {
      target.runtime.close();
      target.lease.close();
      runtimes.delete(id);
    }
  }
});

/** Probe form values without replacing the saved connection or its credentials. */
export async function probeLibraryConnection(
  connection: PluginConnection,
  credentials: Record<string, string>,
  device: PluginDeviceConfig,
  signal?: AbortSignal,
) {
  await loadPluginManager();
  const installed = findInstalledPlugin(connection.pluginId);
  const pkg = packages.get(connection.pluginId);
  if (!installed?.enabled || !pkg || installed.fingerprint !== connection.fingerprint)
    throw new Error('Install and enable the matching signed plugin first');
  const allowed = () => findInstalledPlugin(connection.pluginId) === installed && installed.enabled;
  const lease = createConnectionLease(connection, installed.permissions, allowed, {
    connection: () => connection,
    device: async () => device,
    credentials: async () => credentials,
  });
  const definition = externalPluginDefinitions().find(
    (p) => p.manifest.id === connection.pluginId,
  )!;
  const runtime = createPluginRuntime({
    createWorker: () => definition.createWorker('lookup'),
    handleHostCall: lease.handleHostCall,
  });
  const abort = anySignal(AbortSignal.timeout(30_000), signal);
  try {
    await runtime.call(
      'library.testConnection',
      { context: lease.context },
      { signal: abort.signal },
    );
    return await runtime.call(
      'library.listLibraries',
      { context: lease.context },
      { signal: abort.signal },
    );
  } finally {
    abort.cleanup();
    runtime.close();
    lease.close();
  }
}

export async function setPluginPermission(
  id: string,
  permission: keyof InstalledPlugin['permissions'],
  granted: boolean,
): Promise<void> {
  await loadPluginManager();
  return serialize(async () => {
    const row = findInstalledPlugin(id);
    if (!row) return;
    if (granted && !row.manifest.permissions?.[permission])
      throw new Error('The plugin did not request this permission');
    const pkg = packages.get(id);
    await persist({ ...row, permissions: { ...row.permissions, [permission]: granted } });
    stop(id);
    if (row.enabled && pkg) register(pkg);
  });
}

/** The source runtime uses the same verified packages and signer ownership as library plugins. */
export async function getInstalledPluginPackage(id: string): Promise<VerifiedPluginPackage> {
  await loadPluginManager();
  const installed = findInstalledPlugin(id);
  const pkg = packages.get(id);
  if (
    !installed?.enabled ||
    !pkg ||
    installed.fingerprint !== pkg.fingerprint ||
    installed.activeHash !== pkg.packageHash
  ) {
    throw new Error('Install and enable the matching signed plugin first.');
  }
  return pkg;
}
export async function clearPluginData(id: string): Promise<void> {
  await loadPluginManager();
  return serialize(async () => {
    const row = findInstalledPlugin(id);
    if (!row) return;
    const pkg = packages.get(id);
    const finish = beginPluginDataReset(id);
    try {
      stop(id);
      await clearPluginPrivateStorage(id, row.fingerprint);
      const { clearSourcePluginData } = await import('../contentSources/instances');
      await clearSourcePluginData(id, row.fingerprint);
      if (row.enabled && pkg) register(pkg);
    } finally {
      finish();
    }
  });
}
