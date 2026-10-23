'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContentSourceContribution,
  SourceDefinition,
  SourceReference,
  SourceDescription,
} from '@readest/plugin-sdk';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { useAppRouter } from '@/hooks/useAppRouter';
import { loadPluginManager, useInstalledPlugins } from '@/services/plugins/manager';
import type { InstalledPlugin } from '@/services/plugins/types';
import { readSourceCredentials } from '@/services/contentSources/privateStorage';
import {
  loadSourceInstances,
  saveSourceInstance,
  setSourceInstanceEnabled,
  removeSourceInstance,
  useSourceInstances,
  readSourceDefinition,
  type SourceInstance,
} from '@/services/contentSources/instances';
import {
  getSourceRuntime,
  inspectSourceFile,
  describeSourceDefinition,
  validateSourceSettings,
  useSourceDiagnostics,
} from '@/services/contentSources/runtime';
import { normalizeSourceOrigin } from '@/services/contentSources/policy';
import { downloadSourceInput } from '@/services/contentSources/imports';
import {
  useSourceSubscriptions,
  loadSourceSubscriptions,
  saveSourceSubscription,
  refreshSourceSubscription,
  removeSourceSubscription,
} from '@/services/contentSources/subscriptions';
import {
  BoxedList,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitchRow,
} from './primitives';
import PluginSettingsForm from './PluginSettingsForm';
import SourceDownloadManager from './SourceDownloadManager';
import {
  normalizeSourceError,
  sourceErrorMessage,
  sourceErrorDiagnostic,
} from '@/services/contentSources/errors';
import { SourceFields } from './SourceInteractionDialog';
const button = 'btn btn-sm btn-ghost eink-bordered h-auto min-h-9 whitespace-normal py-1.5';
type Provider = { plugin: InstalledPlugin; provider: ContentSourceContribution };
type Editor = Provider & {
  instance?: SourceInstance;
  definition?: SourceDefinition;
  importUrl?: string;
  subscriptionId?: string;
};
const codeOf = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(code)
    ? code
    : error instanceof DOMException && error.name === 'AbortError'
      ? 'SOURCE_CANCELLED'
      : 'SOURCE_OPERATION_FAILED';
};
function SourceEditor({
  editor,
  onClose,
  onSaved,
}: {
  editor: Editor;
  onClose: () => void;
  onSaved: () => void;
}) {
  const _ = useTranslation();
  const { plugin, provider, instance, definition } = editor;
  const [id] = useState(() => instance?.id ?? crypto.randomUUID());
  const [name, setName] = useState(instance?.name ?? definition?.name ?? provider.name);
  const [origins, setOrigins] = useState(
    (instance?.origins ?? definition?.origins ?? []).join('\n'),
  );
  const [privateNetwork, setPrivateNetwork] = useState(instance?.allowPrivateNetwork ?? false);
  const [values, setValues] = useState<Record<string, string | boolean | number>>(() =>
    Object.fromEntries(
      provider.settings.map((field) => [
        field.key,
        field.type === 'secret'
          ? ''
          : field.type === 'boolean'
            ? instance?.config[field.key] === true
            : String(instance?.config[field.key] ?? ''),
      ]),
    ),
  );
  const [description, setDescription] = useState<SourceDescription>({
    settings: provider.settings,
    actions: [],
    authentication: { kind: 'none' },
  });
  const [cleared, setCleared] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const rules = definition ?? (await readSourceDefinition(instance?.definitionId));
      const metadata = provider.capabilities.describe
        ? await describeSourceDefinition(plugin.id, provider.id, rules, controller.signal)
        : { settings: provider.settings, actions: [], authentication: { kind: 'none' as const } };
      const secrets = instance ? await readSourceCredentials(instance) : {};
      if (controller.signal.aborted) return;
      setDescription(metadata);
      setValues(
        Object.fromEntries(
          metadata.settings.map((field) => [
            field.key,
            field.type === 'secret'
              ? ''
              : ((field.private ? secrets[field.key] : instance?.config[field.key]) ??
                field.default ??
                (field.type === 'boolean' ? false : '')),
          ]),
        ) as Record<string, string | boolean | number>,
      );
    })()
      .catch((failure) => {
        if (!controller.signal.aborted) setError(codeOf(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [definition, instance, plugin.id, provider]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const secrets = instance ? await readSourceCredentials(instance) : {};
      for (const key of cleared) delete secrets[key];
      const config = { ...instance?.config };
      for (const field of description.settings) {
        const value = values[field.key] ?? (field.type === 'boolean' ? false : '');
        if (field.type === 'secret' || field.private) {
          if (value || field.type !== 'secret') secrets[field.key] = String(value);
          delete config[field.key];
        } else config[field.key] = value;
        if (field.type === 'select' && !field.options?.some((option) => option.value === value))
          throw new Error('Invalid option');
        if (field.type === 'number' && !Number.isFinite(value)) throw new Error('Invalid number');
        if (
          field.required &&
          field.type !== 'boolean' &&
          !(field.type === 'secret' ? secrets[field.key] : value)
        )
          throw new Error('required');
      }
      if (provider.capabilities.validateSettings) {
        const rules = definition ?? (await readSourceDefinition(instance?.definitionId));
        const validationValues = Object.fromEntries(
          Object.entries(values).filter(([key, value]) => {
            const field = description.settings.find((item) => item.key === key);
            return (
              !(field?.type === 'secret' || field?.private) ||
              (plugin.permissions.secretValues === true && value !== '')
            );
          }),
        );
        const validation = await validateSourceSettings(
          plugin.id,
          provider.id,
          rules,
          validationValues,
        );
        if (Object.keys(validation.fieldErrors).length) {
          setError(
            Object.keys(validation.fieldErrors)
              .map((key) => description.settings.find((field) => field.key === key)?.label ?? key)
              .join(', ') +
              ': ' +
              _('Invalid setting value'),
          );
          return;
        }
      }
      await saveSourceInstance(
        {
          id,
          pluginId: plugin.id,
          providerId: provider.id,
          fingerprint: plugin.fingerprint,
          name: name.trim(),
          config,
          enabled: instance?.enabled ?? true,
          definitionId: instance?.definitionId,
          importUrl: editor.importUrl ?? instance?.importUrl,
          subscriptionId: editor.subscriptionId ?? instance?.subscriptionId,
          origins: origins
            .split(/\r?\n/u)
            .map((value) => value.trim())
            .filter(Boolean)
            .map(normalizeSourceOrigin),
          allowPrivateNetwork: privateNetwork,
          secretNames: Object.keys(secrets),
          createdAt: instance?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        },
        { definition, secrets },
      );
      onSaved();
    } catch {
      setError(_('Check the name, required fields, and website URLs'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      isOpen
      portal
      aboveKeyboard
      title={definition ? _('Review imported source') : _('Source settings')}
      onClose={onClose}
    >
      <form
        className='flex flex-col gap-4'
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className='text-base-content/70 text-sm'>
          {_('Approve the websites this source can access and configure its account')}
        </p>
        <BoxedList title={plugin.manifest.name ?? plugin.id} description={provider.name}>
          <SettingsRow label={_('Name')}>
            <SettingsInput
              aria-label={_('Source name')}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </SettingsRow>
          <SourceFields
            fields={description.settings}
            values={values}
            onChange={(key, value) => {
              setValues({ ...values, [key]: value });
              setCleared(cleared.filter((item) => item !== key));
            }}
            savedSecrets={(instance?.secretNames ?? []).filter((key) => !cleared.includes(key))}
            onClear={(key) => {
              setCleared([...cleared, key]);
              setValues({ ...values, [key]: '' });
            }}
          />
          <SettingsSwitchRow
            label={_('Allow private network')}
            description={_('For a server you run on your own network')}
            checked={privateNetwork}
            onChange={() => setPrivateNetwork(!privateNetwork)}
          />
        </BoxedList>
        {loading && <p role='status'>{_('Loading source settings…')}</p>}
        {description.authentication.kind === 'unsupported' && (
          <p className='text-sm'>
            {_('This login method is not supported')}: {description.authentication.reason}
          </p>
        )}
        {instance && description.authentication.kind === 'form' && (
          <button
            type='button'
            className={button}
            disabled={busy || !instance.enabled}
            onClick={() => {
              setBusy(true);
              void getSourceRuntime(instance.id)
                .then((runtime) => runtime.call('source.authenticate', {}))
                .catch((failure) => setError(codeOf(failure)))
                .finally(() => setBusy(false));
            }}
          >
            {_('Sign in')}
          </button>
        )}
        {instance &&
          description.actions.map((action) => (
            <button
              type='button'
              className={button}
              key={action.id}
              disabled={busy || !instance.enabled}
              onClick={() => {
                setBusy(true);
                void getSourceRuntime(instance.id)
                  .then((runtime) =>
                    runtime.call('source.runSettingAction', { actionId: action.id }),
                  )
                  .catch((failure) => setError(codeOf(failure)))
                  .finally(() => setBusy(false));
              }}
            >
              {action.label}
            </button>
          ))}
        {instance?.secretNames.length ? (
          <p className='text-sm'>{_('Leave password fields blank to keep saved credentials')}</p>
        ) : null}
        <label className='flex flex-col gap-2 text-sm'>
          {_('Allowed websites, one URL per line')}
          <textarea
            className='textarea eink-bordered border-base-200 min-h-24 w-full'
            value={origins}
            onChange={(event) => setOrigins(event.target.value)}
          />
        </label>
        {definition && (
          <details className='eink-bordered border-base-200 rounded-lg border p-3'>
            <summary>{_('Review source file')}</summary>
            <textarea
              aria-label={_('Source file')}
              readOnly
              value={definition.content}
              className='textarea mt-2 h-40 w-full font-mono text-xs'
            />
          </details>
        )}
        {error && (
          <p role='alert' className='text-error text-sm'>
            {error}
          </p>
        )}
        <div className='flex justify-end gap-2'>
          <button type='button' className={button} onClick={onClose}>
            {_('Cancel')}
          </button>
          <button
            type='submit'
            className='btn btn-sm btn-contrast'
            disabled={busy || loading || !name.trim()}
          >
            {_('Save and allow access')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export default function NetworkSourcesDialog({
  isOpen,
  onClose,
  pluginId,
  pageId,
  embedded = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  pluginId?: string;
  pageId?: string;
  embedded?: boolean;
}) {
  const _ = useTranslation();
  const router = useAppRouter();
  const plugins = useInstalledPlugins((state) => state.plugins);
  const instances = useSourceInstances((state) => state.instances);
  const subscriptions = useSourceSubscriptions((state) => state.subscriptions);
  const diagnostics = useSourceDiagnostics((state) => state.entries);
  const plugin = plugins.find((item) => item.id === pluginId);
  const page = plugin?.manifest.contributions.managementPages?.find((item) => item.id === pageId);
  const section = (name: 'sourceInstances' | 'sourceSubscriptions' | 'settings' | 'information') =>
    !page || page.sections.includes(name);
  const providers = useMemo(
    () =>
      plugins
        .filter((item) => !pluginId || item.id === pluginId)
        .flatMap((plugin) =>
          (plugin.manifest.contributions.contentSources ?? [])
            .filter((provider) => !page || page.providerIds.includes(provider.id))
            .map((provider) => ({ plugin, provider })),
        ),
    [plugins, pluginId, page],
  );
  const formats = providers.flatMap((item) =>
    (item.plugin.manifest.contributions.sourceFormats ?? [])
      .filter((format) => format.providerId === item.provider.id)
      .map((format) => ({ ...item, format })),
  );
  const [formatKey, setFormatKey] = useState('');
  const importer =
    formats.find((item) => item.plugin.id + ':' + item.format.id === formatKey) ?? formats[0];
  const [importUrl, setImportUrl] = useState('');
  const [editor, setEditor] = useState<Editor>();
  const [imports, setImports] = useState<Editor[]>([]);
  const [definitions, setDefinitions] = useState<Record<string, SourceDefinition>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [diagnostic, setDiagnostic] = useState('');
  const active = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const act = async (operation: (signal: AbortSignal) => Promise<void>) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setStatus('');
    setDiagnostic('');
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (active.current === controller) {
        setError(sourceErrorMessage(failure, _));
        setDiagnostic(sourceErrorDiagnostic(failure));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (isOpen)
      void act(async () => {
        await Promise.all([loadPluginManager(), loadSourceInstances(), loadSourceSubscriptions()]);
      });
    return () => active.current?.abort();
  }, [isOpen]);
  useEffect(() => {
    let stopped = false;
    void Promise.all(
      instances.map(
        async (instance) =>
          [instance.id, await readSourceDefinition(instance.definitionId)] as const,
      ),
    )
      .then((rows) => {
        if (!stopped)
          setDefinitions(
            Object.fromEntries(
              rows.filter((row): row is readonly [string, SourceDefinition] => !!row[1]),
            ),
          );
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [instances]);
  const belongs = (item: { pluginId: string; fingerprint: string; providerId: string }) =>
    providers.some(
      (provider) =>
        provider.plugin.id === item.pluginId &&
        provider.plugin.fingerprint === item.fingerprint &&
        provider.provider.id === item.providerId,
    );
  const inspect = async (
    content: string,
    selected: typeof importer,
    signal: AbortSignal,
    filename?: string,
    url?: string,
    subscriptionId?: string,
    originalUrl = url,
  ) => {
    if (!selected) return;
    const result = await inspectSourceFile(
      selected.plugin.id,
      selected.provider.id,
      selected.format.id,
      content,
      filename,
      signal,
      url,
    ).catch((failure) => {
      throw normalizeSourceError(failure, 'inspect');
    });
    setImports(
      result.definitions.map((definition) => ({
        plugin: selected.plugin,
        provider: selected.provider,
        definition,
        importUrl: originalUrl,
        subscriptionId,
        instance: instances.find(
          (instance) =>
            instance.pluginId === selected.plugin.id &&
            instance.fingerprint === selected.plugin.fingerprint &&
            instance.providerId === selected.provider.id &&
            (definitions[instance.id]?.id === definition.id ||
              (originalUrl && instance.importUrl === originalUrl)),
        ),
      })),
    );
    if (result.references)
      await saveSourceSubscription(
        {
          pluginId: selected.plugin.id,
          fingerprint: selected.plugin.fingerprint,
          providerId: selected.provider.id,
          format: selected.format.id,
          name: filename ?? (url ? new URL(url).hostname : selected.format.name),
          url,
        },
        result.references,
      );
    if (result.diagnostics?.length)
      setStatus(result.diagnostics.map((item) => item.code).join(', '));
  };
  const download = async (
    url: string,
    selected: typeof importer,
    signal: AbortSignal,
    subscriptionId?: string,
  ) => {
    const input = await downloadSourceInput(url, signal).catch((failure) => {
      throw normalizeSourceError(failure, 'download-source');
    });
    await inspect(input.content, selected, signal, undefined, input.url, subscriptionId, url);
  };
  const reviewReference = async (
    reference: SourceReference,
    owner: { pluginId: string; providerId: string; id?: string },
    signal: AbortSignal,
  ) => {
    const selected = formats.find(
      (item) =>
        item.plugin.id === owner.pluginId &&
        item.provider.id === owner.providerId &&
        item.format.id === reference.format,
    );
    if (!selected) throw new Error('Source importer is unavailable');
    await download(reference.url, selected, signal, owner.id);
  };
  const body = (
    <div className='flex min-w-0 flex-col gap-4' aria-busy={busy}>
      {error && (
        <p role='alert' className='text-error break-words text-sm'>
          {_('Operation failed')}: {error}
        </p>
      )}
      {diagnostic && (
        <button
          type='button'
          className={button}
          onClick={() =>
            void import('@/utils/clipboard').then(({ writeTextToClipboard }) =>
              writeTextToClipboard(diagnostic),
            )
          }
        >
          {_('Copy diagnostics')}
        </button>
      )}
      {status && (
        <p role='status' className='text-sm'>
          {status}
        </p>
      )}
      {busy && <p role='status'>{_('Working…')}</p>}
      {!pluginId && <SourceDownloadManager />}
      {section('settings') &&
        providers
          .filter(
            (item, index, items) =>
              items.findIndex((other) => other.plugin.id === item.plugin.id) === index,
          )
          .map((item) => <PluginSettingsForm key={item.plugin.id} plugin={item.plugin} />)}
      {section('sourceInstances') && (
        <>
          {formats.length > 0 && (
            <BoxedList title={_('Import source file')}>
              <SettingsRow label={_('Format')}>
                <SettingsSelect
                  ariaLabel={_('Format')}
                  value={importer ? importer.plugin.id + ':' + importer.format.id : ''}
                  options={formats.map((item) => ({
                    value: item.plugin.id + ':' + item.format.id,
                    label: item.format.name,
                  }))}
                  onChange={(event) => setFormatKey(event.target.value)}
                />
              </SettingsRow>
              <SettingsRow label={_('Local file')}>
                <button
                  type='button'
                  className={button}
                  disabled={busy || !importer?.plugin.enabled}
                  onClick={() => fileInput.current?.click()}
                >
                  {_('Choose file')}
                </button>
                <input
                  ref={fileInput}
                  className='hidden'
                  type='file'
                  accept={importer?.format.extensions.map((extension) => '.' + extension).join(',')}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file)
                      void act(async (signal) => {
                        await inspect(await file.text(), importer, signal, file.name);
                      });
                    event.target.value = '';
                  }}
                />
              </SettingsRow>
              <SettingsRow label={_('Source URL')} responsive>
                <SettingsInput
                  aria-label={_('Source URL')}
                  value={importUrl}
                  onChange={(event) => setImportUrl(event.target.value)}
                />
              </SettingsRow>
              <SettingsRow label={_('Download source file')}>
                <button
                  type='button'
                  className={button}
                  disabled={busy || !importUrl || !importer?.plugin.enabled}
                  onClick={() => void act((signal) => download(importUrl, importer, signal))}
                >
                  {_('Download and inspect')}
                </button>
              </SettingsRow>
            </BoxedList>
          )}
          {providers
            .filter(
              (item) =>
                !formats.some(
                  (format) =>
                    format.plugin.id === item.plugin.id && format.provider.id === item.provider.id,
                ),
            )
            .map((item) => (
              <BoxedList key={item.plugin.id + item.provider.id} title={item.provider.name}>
                <SettingsRow label={_('Add source')}>
                  <button
                    type='button'
                    className={button}
                    disabled={!item.plugin.enabled || busy}
                    onClick={() => setEditor(item)}
                  >
                    {_('Configure')}
                  </button>
                </SettingsRow>
              </BoxedList>
            ))}
          {imports.map((item, index) => (
            <BoxedList key={index}>
              <SettingsRow
                label={item.definition?.name ?? item.provider.name}
                description={item.instance ? _('Update installed source') : _('Awaiting review')}
              >
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() => setEditor(item)}
                >
                  {_('Review')}
                </button>
              </SettingsRow>
            </BoxedList>
          ))}
          {instances.filter(belongs).map((instance) => {
            const provider = providers.find(
              (item) =>
                item.plugin.id === instance.pluginId && item.provider.id === instance.providerId,
            )!;
            return (
              <BoxedList
                key={instance.id}
                title={instance.name}
                description={definitions[instance.id]?.version}
              >
                <SettingsSwitchRow
                  label={_('Enabled')}
                  checked={instance.enabled}
                  disabled={busy || !provider.plugin.enabled}
                  onChange={() =>
                    void act(() => setSourceInstanceEnabled(instance.id, !instance.enabled))
                  }
                />
                <SettingsRow label={_('Manage source')} responsive>
                  <div className='flex flex-wrap justify-end gap-2'>
                    <button
                      type='button'
                      className={button}
                      disabled={busy || !provider.plugin.enabled}
                      onClick={() => setEditor({ ...provider, instance })}
                    >
                      {_('Configure')}
                    </button>
                    <button
                      type='button'
                      className={button}
                      disabled={!instance.enabled || !provider.plugin.enabled}
                      onClick={() => {
                        onClose();
                        router.push('/library?source=' + encodeURIComponent(instance.id));
                      }}
                    >
                      {_('Search')}
                    </button>
                    <button
                      type='button'
                      className={button}
                      disabled={busy}
                      onClick={() => void act(() => removeSourceInstance(instance.id))}
                    >
                      {_('Remove')}
                    </button>
                  </div>
                </SettingsRow>
              </BoxedList>
            );
          })}
        </>
      )}
      {section('sourceSubscriptions') &&
        subscriptions.filter(belongs).map((subscription) => (
          <BoxedList key={subscription.id} title={subscription.name} description={subscription.url}>
            <SettingsRow label={_('Source list')} responsive>
              <div className='flex gap-2'>
                {subscription.url && (
                  <button
                    type='button'
                    className={button}
                    disabled={
                      busy || !plugins.find((item) => item.id === subscription.pluginId)?.enabled
                    }
                    onClick={() =>
                      void act(async (signal) => {
                        await refreshSourceSubscription(subscription.id, async (current) => {
                          const selected = formats.find(
                            (item) =>
                              item.plugin.id === current.pluginId &&
                              item.format.id === current.format,
                          );
                          if (!selected) throw new Error('Source importer unavailable');
                          const input = await downloadSourceInput(current.url!, signal);
                          const result = await inspectSourceFile(
                            selected.plugin.id,
                            selected.provider.id,
                            selected.format.id,
                            input.content,
                            undefined,
                            signal,
                            input.url,
                          );
                          if (!result.references) throw new Error('The file is not a source list');
                          return result.references;
                        });
                      })
                    }
                  >
                    {_('Refresh')}
                  </button>
                )}
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() => void act(() => removeSourceSubscription(subscription.id))}
                >
                  {_('Remove list')}
                </button>
              </div>
            </SettingsRow>
            {subscription.error && (
              <SettingsRow label={_('Refresh failed; previous list retained')} />
            )}
            {subscription.references.map((reference) => {
              const installed = instances.find(
                (instance) =>
                  instance.pluginId === subscription.pluginId &&
                  instance.providerId === subscription.providerId &&
                  instance.importUrl === reference.url,
              );
              return (
                <SettingsRow
                  key={reference.url}
                  label={reference.name}
                  description={[
                    reference.version,
                    installed ? _('Installed') : undefined,
                    reference.description,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  responsive
                >
                  <button
                    type='button'
                    className={button}
                    disabled={
                      busy || !plugins.find((item) => item.id === subscription.pluginId)?.enabled
                    }
                    onClick={() =>
                      void act((signal) => reviewReference(reference, subscription, signal))
                    }
                  >
                    {installed ? _('Check for updates') : _('Download and inspect')}
                  </button>
                </SettingsRow>
              );
            })}
          </BoxedList>
        ))}
      {section('information') &&
        diagnostics.filter((entry) =>
          instances.some((instance) => instance.id === entry.instanceId && belongs(instance)),
        ).length > 0 && (
          <details>
            <summary>{_('Diagnostics')}</summary>
            {diagnostics.slice(0, 10).map((entry, index) => (
              <p key={index} className='text-xs'>
                {entry.operation} · {entry.code ?? _('Completed')} · {entry.duration} ms
              </p>
            ))}
          </details>
        )}
    </div>
  );
  return (
    <>
      {embedded ? (
        body
      ) : (
        <Dialog
          isOpen={isOpen}
          portal
          title={page?.title ?? _('Network sources')}
          onClose={onClose}
        >
          {body}
        </Dialog>
      )}
      {editor && (
        <SourceEditor
          editor={editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            setImports((previous) => previous.filter((item) => item !== editor));
          }}
        />
      )}
    </>
  );
}
