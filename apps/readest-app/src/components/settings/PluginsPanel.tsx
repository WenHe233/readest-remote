import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useEnv } from '@/context/EnvContext';
import { BoxedList, SettingsRow, SettingsSwitchRow, SettingsInput } from './primitives';
import Dialog from '@/components/Dialog';
import {
  useInstalledPlugins,
  loadPluginManager,
  installPlugin,
  rollbackPlugin,
  setPluginEnabled,
  setPluginPermission,
  clearPluginData,
  uninstallPlugin,
  probeLibraryConnection,
} from '@/services/plugins/manager';
import { verifyPluginPackage } from '@/services/plugins/package';
import {
  listPluginRepositories,
  refreshRepository,
  savePluginRepository,
  removePluginRepository,
  mergePluginReleases,
  downloadPluginRelease,
  parseRepositoryImport,
  type PluginRepository,
} from '@/services/plugins/repositories';
import {
  loadPluginConnections,
  usePluginConnections,
  savePluginConnection,
  removePluginConnection,
  getPluginDeviceConfig,
  savePluginDeviceConfig,
} from '@/services/plugins/connections';
import { getConnectionSecrets } from '@/services/plugins/vault';
import { syncExternalLibrary } from '@/services/plugins/library';
import { usePluginInbox } from '@/services/plugins/inbox';
import { clearContentCache, getContentCacheBytes } from '@/services/plugins/cache';
import type { InstalledPlugin, PluginConnection } from '@/services/plugins/types';
import type { RemoteLibrary } from '@readest/plugin-sdk';

const button = 'btn btn-sm btn-ghost eink-bordered';
export default function PluginsPanel() {
  const _ = useTranslation();
  const { appService } = useEnv();
  const plugins = useInstalledPlugins((s) => s.plugins);
  const connections = usePluginConnections((s) => s.connections);
  const { candidate, repositoryUrl, error: inboxError } = usePluginInbox();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'installed' | 'catalog' | 'sources' | 'connections'>('installed');
  const [repositories, setRepositories] = useState<PluginRepository[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [editor, setEditor] = useState<{
    plugin: InstalledPlugin;
    connection?: PluginConnection;
  } | null>(null);
  const [cacheBytes, setCacheBytes] = useState(0);
  const reload = async () => {
    setRepositories(await listPluginRepositories());
    setCacheBytes(await getContentCacheBytes());
  };
  const act = async (work: () => Promise<unknown>, success = '') => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await reload();
      if (success) setMessage(success);
    } catch (e) {
      setError(e instanceof Error ? _(e.message) : _('Operation failed'));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void act(async () => {
      await Promise.all([loadPluginManager(), loadPluginConnections()]);
    });
  }, []);
  useEffect(() => {
    if (repositoryUrl) {
      setSourceUrl(repositoryUrl);
      setShowSource(true);
      usePluginInbox.setState({ repositoryUrl: undefined });
    }
  }, [repositoryUrl]);
  useEffect(() => {
    if (inboxError) {
      setError(_(inboxError));
      usePluginInbox.setState({ error: undefined });
    }
  }, [inboxError]);
  const releases = useMemo(
    () =>
      mergePluginReleases(repositories).filter(
        (r) =>
          (category === 'all' ||
            r.contributions.includes(category as 'librarySources' | 'dictionaryFormats')) &&
          (r.name + ' ' + r.description).toLowerCase().includes(query.toLowerCase()),
      ),
    [repositories, query, category],
  );
  const importFile = async (file: File) => {
    if (file.name.endsWith('.readest-repo')) {
      setSourceUrl(parseRepositoryImport(await file.text()));
      setShowSource(true);
    } else
      usePluginInbox.setState({
        candidate: await verifyPluginPackage(new Uint8Array(await file.arrayBuffer())),
      });
  };
  return (
    <div className='flex flex-col gap-5' aria-busy={busy}>
      <div className='flex flex-wrap gap-2' role='tablist' aria-label={_('Plugins')}>
        {(
          [
            ['installed', _('Installed')],
            ['catalog', _('Browse plugins')],
            ['sources', _('Plugin repositories')],
            ['connections', _('Library connections')],
          ] as const
        ).map(([value, label]) => (
          <button
            type='button'
            role='tab'
            aria-selected={tab === value}
            key={value}
            className={tab === value ? 'btn btn-sm btn-contrast' : button}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p role='alert' className='text-error break-words text-sm'>
          {error}
        </p>
      )}
      {message && (
        <p role='status' className='text-sm'>
          {message}
        </p>
      )}
      {busy && (
        <p role='status' className='text-sm'>
          {_('Working…')}
        </p>
      )}
      {tab === 'installed' && (
        <>
          <input
            ref={fileRef}
            className='hidden'
            type='file'
            accept='.readest-plugin,.readest-repo'
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void act(() => importFile(file));
              e.target.value = '';
            }}
          />
          <button
            type='button'
            className={button}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {_('Install from file')}
          </button>
          <BoxedList title={_('Bundled plugins')}>
            <SettingsRow label='Yomitan' description={_('Dictionary import and lookup')}>
              {_('Built in')}
            </SettingsRow>
          </BoxedList>
          {!plugins.length && (
            <p className='text-base-content/65 text-sm'>{_('No external plugins installed.')}</p>
          )}
          {plugins.map((plugin) => (
            <BoxedList
              key={plugin.id}
              title={plugin.manifest.name || plugin.id}
              description={plugin.error ? _(plugin.error) : undefined}
            >
              <SettingsSwitchRow
                label={_('Enabled')}
                checked={plugin.enabled}
                disabled={busy}
                onChange={() => void act(() => setPluginEnabled(plugin.id, !plugin.enabled))}
              />
              <SettingsRow label={_('Version')} description={plugin.id}>
                {plugin.manifest.pluginVersion}
              </SettingsRow>
              <SettingsRow label={_('Signer')}>
                <code className='max-w-[60%] break-all text-xs'>{plugin.fingerprint}</code>
              </SettingsRow>
              {(['network', 'secrets', 'storage'] as const)
                .filter((key) => plugin.manifest.permissions?.[key])
                .map((key) => (
                  <SettingsSwitchRow
                    key={key}
                    label={_(
                      {
                        network: 'Configured server network',
                        secrets: 'Connection credentials',
                        storage: 'Private plugin storage',
                      }[key],
                    )}
                    checked={plugin.permissions[key] === true}
                    disabled={busy}
                    onChange={() =>
                      void act(() => setPluginPermission(plugin.id, key, !plugin.permissions[key]))
                    }
                  />
                ))}
              <SettingsRow label={_('Manage plugin')}>
                <div className='flex flex-wrap justify-end gap-2'>
                  {!!plugin.manifest.contributions.librarySources?.length && (
                    <button
                      type='button'
                      className={button}
                      disabled={busy || !plugin.enabled}
                      onClick={() => setEditor({ plugin })}
                    >
                      {_('Add connection')}
                    </button>
                  )}
                  <button
                    type='button'
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void act(() => clearPluginData(plugin.id), _('Plugin storage cleared'))
                    }
                  >
                    {_('Clear plugin storage')}
                  </button>
                  {plugin.previousHash && (
                    <button
                      type='button'
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void act(() => rollbackPlugin(plugin.id), _('Previous version restored'))
                      }
                    >
                      {_('Roll back')}
                    </button>
                  )}
                  <button
                    type='button'
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => uninstallPlugin(plugin.id),
                        _('Plugin removed. Books and notes were retained.'),
                      )
                    }
                  >
                    {_('Uninstall')}
                  </button>
                </div>
              </SettingsRow>
            </BoxedList>
          ))}
        </>
      )}
      {tab === 'catalog' && (
        <>
          <BoxedList>
            <SettingsRow label={_('Search')}>
              <SettingsInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={_('Search plugins')}
              />
            </SettingsRow>
            <SettingsRow label={_('Category')}>
              <select
                className='select select-sm eink-bordered'
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value='all'>{_('All')}</option>
                <option value='librarySources'>{_('External libraries')}</option>
                <option value='dictionaryFormats'>{_('Dictionaries')}</option>
              </select>
            </SettingsRow>
          </BoxedList>
          <button
            className={button}
            type='button'
            disabled={busy}
            onClick={() =>
              void act(async () => {
                for (const repo of repositories.filter((r) => r.enabled))
                  await refreshRepository(repo.url, repo);
              })
            }
          >
            {_('Check for updates')}
          </button>
          {releases.map((release) => {
            const installed = plugins.find((p) => p.id === release.id);
            return (
              <BoxedList
                key={release.id + release.fingerprint}
                title={release.name}
                description={release.description}
              >
                <SettingsRow
                  label={release.version}
                  description={
                    release.conflict || (installed && installed.fingerprint !== release.fingerprint)
                      ? _('Conflicting plugin signer')
                      : !release.compatible
                        ? _('Incompatible plugin API')
                        : release.channel
                  }
                >
                  <button
                    type='button'
                    className={button}
                    disabled={
                      busy ||
                      !release.compatible ||
                      (!!installed && installed.fingerprint !== release.fingerprint)
                    }
                    onClick={() =>
                      void act(async () =>
                        usePluginInbox.setState({
                          candidate: await downloadPluginRelease(release),
                        }),
                      )
                    }
                  >
                    {installed ? _('Review update') : _('Install')}
                  </button>
                </SettingsRow>
              </BoxedList>
            );
          })}
          {!releases.length && (
            <p className='text-sm'>{_('Add a plugin repository to browse available plugins.')}</p>
          )}
        </>
      )}
      {tab === 'sources' && (
        <>
          <button
            type='button'
            className={button}
            onClick={() => {
              setSourceUrl('');
              setShowSource(true);
            }}
          >
            {_('Add repository')}
          </button>
          {repositories.map((repo) => (
            <BoxedList key={repo.url} title={repo.name} description={repo.url}>
              <SettingsSwitchRow
                label={_('Enabled')}
                checked={repo.enabled}
                onChange={() =>
                  void act(() => savePluginRepository({ ...repo, enabled: !repo.enabled }))
                }
              />
              <SettingsRow label={_('Update channel')}>
                <select
                  className='select select-sm eink-bordered'
                  value={repo.channel}
                  onChange={(e) =>
                    void act(() =>
                      savePluginRepository({
                        ...repo,
                        channel: e.target.value as PluginRepository['channel'],
                      }),
                    )
                  }
                >
                  <option value='stable'>Stable</option>
                  <option value='beta'>Beta</option>
                  <option value='nightly'>Nightly</option>
                </select>
              </SettingsRow>
              <SettingsRow label={_('Repository')}>
                <div className='flex gap-2'>
                  <button
                    type='button'
                    className={button}
                    disabled={busy}
                    onClick={() => void act(() => refreshRepository(repo.url, repo))}
                  >
                    {_('Refresh')}
                  </button>
                  <button
                    type='button'
                    className={button}
                    disabled={busy}
                    onClick={() => void act(() => removePluginRepository(repo.url))}
                  >
                    {_('Remove')}
                  </button>
                </div>
              </SettingsRow>
            </BoxedList>
          ))}
        </>
      )}
      {tab === 'connections' && (
        <>
          {connections
            .filter((c) => !c.deletedAt)
            .map((connection) => {
              const plugin = plugins.find(
                (p) => p.id === connection.pluginId && p.fingerprint === connection.fingerprint,
              );
              return (
                <BoxedList key={connection.id} title={connection.name} description={connection.url}>
                  <SettingsRow
                    label={_('Selected libraries')}
                    description={
                      !plugin?.enabled
                        ? _('Install and enable the matching signed plugin first')
                        : undefined
                    }
                  >
                    {connection.libraryIds.length}
                  </SettingsRow>
                  <SettingsRow label={_('Connection')}>
                    <div className='flex flex-wrap justify-end gap-2'>
                      <button
                        type='button'
                        className={button}
                        disabled={busy || !plugin?.enabled}
                        onClick={() => plugin && setEditor({ plugin, connection })}
                      >
                        {_('Edit')}
                      </button>
                      <button
                        type='button'
                        className={button}
                        disabled={busy || !plugin?.enabled}
                        onClick={() =>
                          void act(async () => {
                            if (appService) await syncExternalLibrary(appService, connection.id);
                          }, _('Library synced'))
                        }
                      >
                        {_('Sync library')}
                      </button>
                      <button
                        type='button'
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const { getUserID } = await import('@/utils/access');
                            if (!(await getUserID()))
                              throw new Error(_('Sign in to synchronize connections'));
                            await savePluginConnection(connection);
                          }, _('Connection queued for encrypted sync'))
                        }
                      >
                        {_('Sync connection')}
                      </button>
                      <button
                        type='button'
                        className={button}
                        disabled={busy}
                        onClick={() => void act(() => removePluginConnection(connection.id))}
                      >
                        {_('Remove')}
                      </button>
                    </div>
                  </SettingsRow>
                </BoxedList>
              );
            })}
          <BoxedList title={_('Streaming cache')}>
            <SettingsRow
              label={_('Cache usage')}
              description={_('Complete offline books are stored separately.')}
            >
              <span>{(cacheBytes / 1024 / 1024).toFixed(1)} MiB</span>
              <button
                type='button'
                className={button}
                disabled={busy}
                onClick={() => void act(() => clearContentCache())}
              >
                {_('Clear cache')}
              </button>
            </SettingsRow>
          </BoxedList>
          <p className='text-base-content/65 text-sm'>
            {_(
              'Connection sync requires a self-hosted V2 server. Enable credential sync and unlock your passphrase to include secrets.',
            )}
          </p>
        </>
      )}
      {candidate && (
        <Dialog
          isOpen
          title={_('Install plugin')}
          onClose={() => usePluginInbox.setState({ candidate: undefined })}
        >
          <div className='flex flex-col gap-4'>
            <p>
              {candidate.manifest.name} {candidate.manifest.pluginVersion}
            </p>
            <p className='break-all text-xs'>
              {_('Signer')}: {candidate.fingerprint}
            </p>
            <ul className='list-disc ps-5 text-sm'>
              {candidate.manifest.permissions?.network && <li>{_('Configured server network')}</li>}
              {candidate.manifest.permissions?.secrets && <li>{_('Connection credentials')}</li>}
              {candidate.manifest.permissions?.storage && <li>{_('Private plugin storage')}</li>}
              {!!candidate.manifest.contributions.dictionaryFormats.length && (
                <li>{_('Dictionary files and indexes')}</li>
              )}
            </ul>
            {error && (
              <p role='alert' className='text-error text-sm'>
                {error}
              </p>
            )}
            <button
              type='button'
              className='btn btn-contrast'
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await installPlugin(candidate, true);
                  usePluginInbox.setState({ candidate: undefined });
                }, _('Plugin installed'))
              }
            >
              {_('Approve and install')}
            </button>
          </div>
        </Dialog>
      )}
      {showSource && (
        <Dialog isOpen title={_('Add repository')} onClose={() => setShowSource(false)}>
          <div className='flex flex-col gap-4'>
            <input
              className='input eink-bordered w-full'
              type='url'
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              aria-label={_('Repository URL')}
              placeholder='https://example.org/repo.json'
            />
            {error && (
              <p role='alert' className='text-error text-sm'>
                {error}
              </p>
            )}
            <button
              type='button'
              className='btn btn-contrast'
              disabled={busy || !sourceUrl}
              onClick={() =>
                void act(async () => {
                  await refreshRepository(sourceUrl);
                  setShowSource(false);
                  setTab('catalog');
                })
              }
            >
              {_('Add repository')}
            </button>
          </div>
        </Dialog>
      )}
      {editor && (
        <ConnectionEditor
          plugin={editor.plugin}
          connection={editor.connection}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
function ConnectionEditor({
  plugin,
  connection,
  onClose,
}: {
  plugin: InstalledPlugin;
  connection?: PluginConnection;
  onClose: () => void;
}) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [id] = useState(() => connection?.id ?? crypto.randomUUID());
  const sources = plugin.manifest.contributions.librarySources ?? [];
  const [sourceId, setSourceId] = useState(connection?.sourceId ?? sources[0]?.id ?? '');
  const source = sources.find((s) => s.id === sourceId)!;
  const [name, setName] = useState(connection?.name ?? plugin.manifest.name ?? '');
  const [url, setUrl] = useState(connection?.url ?? '');
  const [config, setConfig] = useState<Record<string, string | number | boolean>>(
    connection?.config ?? {},
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [libraries, setLibraries] = useState<RemoteLibrary[]>([]);
  const [selected, setSelected] = useState<string[]>(connection?.libraryIds ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [tls, setTls] = useState(false);
  const [override, setOverride] = useState('');
  const [cache, setCache] = useState(true);
  useEffect(() => {
    void getPluginDeviceConfig(id).then((c) => {
      setTls(c.allowInvalidTls ?? false);
      setOverride(c.urlOverride ?? '');
      setCache(c.cacheEnabled !== false);
    });
  }, [id]);
  const row = (): PluginConnection => ({
    id,
    pluginId: plugin.id,
    fingerprint: plugin.fingerprint,
    sourceId,
    name,
    url,
    config,
    libraryIds: selected,
    secretNames: source.settings.filter((s) => s.type === 'secret').map((s) => s.key),
    addedAt: connection?.addedAt ?? Date.now(),
    updatedAt: Date.now(),
    reincarnation: connection?.reincarnation ?? crypto.randomUUID(),
  });
  const run = async (save: boolean) => {
    setBusy(true);
    setError('');
    try {
      const known = await getConnectionSecrets(id);
      const merged = {
        ...known,
        ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.length)),
      };
      for (const field of source.settings)
        if (
          field.required &&
          (field.type === 'boolean'
            ? config[field.key] === undefined
            : !(field.type === 'secret' ? merged[field.key] : config[field.key]))
        )
          throw new Error(_('Enter all required fields'));
      const device = {
        allowInvalidTls: tls,
        urlOverride: override || undefined,
        cacheEnabled: cache,
      };
      if (save) {
        await savePluginDeviceConfig(id, device);
        await savePluginConnection(row(), merged, true);
        if (appService && selected.length) await syncExternalLibrary(appService, id);
        onClose();
      } else {
        setLibraries(await probeLibraryConnection(row(), merged, device));
        setConnected(true);
      }
    } catch (e) {
      setError(e instanceof Error ? _(e.message) : _('Connection failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog isOpen title={_('Library connection')} onClose={onClose}>
      <div className='flex flex-col gap-4'>
        <BoxedList>
          {sources.length > 1 && (
            <SettingsRow label={_('Source')}>
              <select
                className='select select-sm eink-bordered'
                value={sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setConnected(false);
                }}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </SettingsRow>
          )}
          <SettingsRow label={_('Name')}>
            <SettingsInput
              aria-label={_('Connection name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </SettingsRow>
          <SettingsRow label={_('Server URL')}>
            <SettingsInput
              type='url'
              aria-label={_('Server URL')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setConnected(false);
              }}
            />
          </SettingsRow>
          {source.settings.map((field) =>
            field.type === 'boolean' ? (
              <SettingsSwitchRow
                key={field.key}
                label={_(field.label)}
                checked={config[field.key] === true}
                onChange={() => {
                  setConfig({ ...config, [field.key]: config[field.key] !== true });
                  setConnected(false);
                }}
              />
            ) : (
              <SettingsRow key={field.key} label={_(field.label)}>
                <SettingsInput
                  type={field.type === 'secret' ? 'password' : 'text'}
                  autoComplete='off'
                  aria-label={_(field.label)}
                  placeholder={
                    field.type === 'secret' && connection
                      ? _('Leave blank to keep current key')
                      : undefined
                  }
                  value={
                    field.type === 'secret'
                      ? (secrets[field.key] ?? '')
                      : String(config[field.key] ?? '')
                  }
                  onChange={(e) => {
                    if (field.type === 'secret')
                      setSecrets({ ...secrets, [field.key]: e.target.value });
                    else setConfig({ ...config, [field.key]: e.target.value });
                    setConnected(false);
                  }}
                />
              </SettingsRow>
            ),
          )}
          <SettingsRow label={_('URL override on this device')}>
            <SettingsInput
              type='url'
              value={override}
              onChange={(e) => {
                setOverride(e.target.value);
                setConnected(false);
              }}
            />
          </SettingsRow>
          <SettingsSwitchRow
            label={_('Allow invalid TLS certificates')}
            checked={tls}
            onChange={() => {
              setTls(!tls);
              setConnected(false);
            }}
          />
          <SettingsSwitchRow
            label={_('Persistent streaming cache')}
            checked={cache}
            onChange={() => setCache(!cache)}
          />
        </BoxedList>
        <button
          type='button'
          className={button}
          disabled={busy || !name || !url}
          onClick={() => void run(false)}
        >
          {busy ? _('Working…') : _('Test connection and list libraries')}
        </button>
        {connected && (
          <BoxedList title={_('Libraries')}>
            {libraries.map((library) => (
              <SettingsSwitchRow
                key={library.id}
                label={library.name}
                checked={selected.includes(library.id)}
                onChange={() =>
                  setSelected(
                    !selected.includes(library.id)
                      ? [...selected, library.id]
                      : selected.filter((id) => id !== library.id),
                  )
                }
              />
            ))}
          </BoxedList>
        )}
        {error && (
          <p role='alert' className='text-error text-sm'>
            {error}
          </p>
        )}
        <button
          type='button'
          className='btn btn-contrast'
          disabled={busy || !connected || !selected.length}
          onClick={() => void run(true)}
        >
          {_('Save and sync library')}
        </button>
      </div>
    </Dialog>
  );
}
