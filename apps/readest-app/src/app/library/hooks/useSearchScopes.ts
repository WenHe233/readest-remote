import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { loadSourceInstances, useSourceInstances } from '@/services/contentSources/instances';
import { loadPluginConnections, usePluginConnections } from '@/services/plugins/connections';
import { loadPluginManager, useInstalledPlugins } from '@/services/plugins/manager';
import { readPluginRecord } from '@/services/plugins/persistence';
import { useExternalLibrarySync } from '@/services/plugins/library';
import type { RemoteLibrary } from '@readest/plugin-sdk';
import { loadSearchScopes, saveSearchScopes, type SearchScope } from '@/services/unifiedSearch';

export function useSearchScopes() {
  const _ = useTranslation();
  const instances = useSourceInstances((state) => state.instances);
  const connections = usePluginConnections((state) => state.connections);
  const plugins = useInstalledPlugins((state) => state.plugins);
  const [selected, setSelected] = useState<string[]>(loadSearchScopes);
  const [names, setNames] = useState<Record<string, RemoteLibrary[]>>({});
  const tasks = useExternalLibrarySync((state) => state.tasks);
  useEffect(() => {
    void Promise.all([loadSourceInstances(), loadPluginConnections(), loadPluginManager()]).catch(
      () => {},
    );
  }, []);
  useEffect(() => {
    let disposed = false;
    void Promise.all(
      connections.map(
        async (connection) =>
          [
            connection.id,
            (await readPluginRecord<RemoteLibrary[]>(`connection-libraries:${connection.id}`)) ??
              [],
          ] as const,
      ),
    )
      .then((items) => {
        if (!disposed) setNames(Object.fromEntries(items));
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [connections, tasks]);
  const scopes = useMemo<SearchScope[]>(
    () => [
      { id: 'local', kind: 'local', name: _('Local imports') },
      ...connections
        .filter((item) => !item.deletedAt)
        .flatMap((connection) =>
          connection.libraryIds.map((libraryId) => ({
            id: `library:${connection.id}:${encodeURIComponent(libraryId)}`,
            kind: 'library' as const,
            name: `${connection.name} · ${names[connection.id]?.find((library) => library.id === libraryId)?.name ?? libraryId}`,
            connectionId: connection.id,
            libraryId,
          })),
        ),
      ...instances
        .filter(
          (instance) =>
            instance.enabled &&
            plugins.some(
              (plugin) =>
                plugin.id === instance.pluginId &&
                plugin.enabled &&
                plugin.manifest.contributions.contentSources?.some(
                  (provider) => provider.id === instance.providerId && provider.capabilities.search,
                ),
            ),
        )
        .map((instance) => ({
          id: `source:${instance.id}`,
          kind: 'source' as const,
          name: instance.name,
          instanceId: instance.id,
        })),
    ],
    [_, connections, instances, plugins, names],
  );
  // Browsing saved books also works with disabled/uninstalled source providers.
  const libraryScopes = useMemo(
    () => [
      ...scopes.filter((scope) => scope.kind !== 'source'),
      ...instances.map((instance) => ({ id: `source:${instance.id}`, name: instance.name })),
    ],
    [scopes, instances],
  );
  return {
    scopes,
    libraryScopes,
    selected,
    setSelected: (value: string[]) => {
      setSelected(value);
      saveSearchScopes(value);
    },
  };
}
