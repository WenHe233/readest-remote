'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContentSourceContribution,
  SourceDefinition,
  SourceReference,
  Work,
} from '@readest/plugin-sdk';
import Dialog from '@/components/Dialog';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useAppRouter } from '@/hooks/useAppRouter';
import { navigateToReader } from '@/utils/nav';
import { useLibraryStore } from '@/store/libraryStore';
import { loadPluginManager, useInstalledPlugins } from '@/services/plugins/manager';
import type { InstalledPlugin } from '@/services/plugins/types';
import { getConnectionSecrets } from '@/services/plugins/vault';
import {
  loadSourceInstances,
  saveSourceInstance,
  setSourceInstanceEnabled,
  removeSourceInstance,
  useSourceInstances,
  type SourceInstance,
} from '@/services/contentSources/instances';
import {
  getSourceRuntime,
  inspectSourceFile,
  useSourceDiagnostics,
} from '@/services/contentSources/runtime';
import { normalizeSourceOrigin, assertSourceUrl } from '@/services/contentSources/policy';
import { sourceTransport } from '@/services/contentSources/network';
import {
  addSourceWork,
  getSourceBookRef,
  listSourceChapters,
  downloadSourceChapters,
  sourceChapterDownloaded,
  removeSourceDownloadedChapter,
  useSourceDownloads,
  sourceBookHash,
  type SourceBookRef,
  type ChapterEntry,
} from '@/services/contentSources/catalog';
import {
  BoxedList,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitchRow,
} from './primitives';
import { SourceFields } from './SourceInteractionDialog';

const button = 'btn btn-sm btn-ghost eink-bordered h-auto min-h-9 whitespace-normal py-1.5';
type Provider = { plugin: InstalledPlugin; provider: ContentSourceContribution };
type Editor = Provider & { instance?: SourceInstance; definition?: SourceDefinition };
type FoundWork = { instanceId: string; work: Work };
const codeOf = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Z][A-Z0-9_]{1,127}$/u.test(code)
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
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const secrets = instance ? await getConnectionSecrets(`source:${id}`) : {};
      const config = { ...instance?.config };
      for (const field of provider.settings) {
        const value = values[field.key] ?? (field.type === 'boolean' ? false : '');
        if (field.type === 'secret') {
          if (value) secrets[field.key] = String(value);
        } else config[field.key] = value;
        if (
          field.required &&
          field.type !== 'boolean' &&
          !(field.type === 'secret' ? secrets[field.key] : value)
        )
          throw new Error('required');
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
            fields={provider.settings}
            values={values}
            onChange={(key, value) => setValues({ ...values, [key]: value })}
          />
          <SettingsSwitchRow
            label={_('Allow private network')}
            description={_('For a server you run on your own network')}
            checked={privateNetwork}
            onChange={() => setPrivateNetwork(!privateNetwork)}
          />
        </BoxedList>
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
          <button type='submit' className='btn btn-sm btn-contrast' disabled={busy || !name.trim()}>
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
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const router = useAppRouter();
  const plugins = useInstalledPlugins((state) => state.plugins);
  const instances = useSourceInstances((state) => state.instances);
  const library = useLibraryStore((state) => state.library);
  const diagnostics = useSourceDiagnostics((state) => state.entries);
  const downloads = useSourceDownloads((state) => state.tasks);
  const providers = useMemo<Provider[]>(
    () =>
      plugins
        .filter((plugin) => plugin.enabled)
        .flatMap((plugin) =>
          (plugin.manifest.contributions.contentSources ?? []).map((provider) => ({
            plugin,
            provider,
          })),
        ),
    [plugins],
  );
  const formats = useMemo(
    () =>
      providers.flatMap((item) =>
        (item.plugin.manifest.contributions.sourceFormats ?? [])
          .filter((format) => format.providerId === item.provider.id)
          .map((format) => ({ ...item, format })),
      ),
    [providers],
  );
  const [tab, setTab] = useState<'sources' | 'search' | 'saved'>('sources');
  const [providerKey, setProviderKey] = useState('');
  const [formatKey, setFormatKey] = useState('');
  const [editor, setEditor] = useState<Editor>();
  const [imports, setImports] = useState<Array<Editor & { definition: SourceDefinition }>>([]);
  const [references, setReferences] = useState<Array<Provider & { reference: SourceReference }>>(
    [],
  );
  const [importUrl, setImportUrl] = useState('');
  const [query, setQuery] = useState('');
  const [exploring, setExploring] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<FoundWork[]>([]);
  const [cursors, setCursors] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<SourceBookRef>();
  const [chapters, setChapters] = useState<ChapterEntry[]>([]);
  const [chapterIds, setChapterIds] = useState<string[]>([]);
  const [visibleChapters, setVisibleChapters] = useState(100);
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const active = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const act = async (operation: (signal: AbortSignal) => Promise<void>) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (active.current === controller) setError(codeOf(failure));
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
        await Promise.all([loadPluginManager(), loadSourceInstances()]);
      });
    return () => {
      active.current?.abort();
    };
  }, [isOpen]);
  const importer =
    formats.find((item) => `${item.plugin.id}:${item.format.id}` === formatKey) ?? formats[0];
  const nativeProviders = providers.filter(
    (item) =>
      !formats.some(
        (format) => format.plugin.id === item.plugin.id && format.provider.id === item.provider.id,
      ),
  );
  const native =
    nativeProviders.find((item) => `${item.plugin.id}:${item.provider.id}` === providerKey) ??
    nativeProviders[0];
  const inspect = async (
    content: string,
    options: {
      filename?: string;
      signal?: AbortSignal;
      baseUrl?: string;
      importer?: typeof importer;
      append?: boolean;
    } = {},
  ) => {
    const selectedImporter = options.importer ?? importer;
    if (!selectedImporter) return;
    if (new TextEncoder().encode(content).length > 4 * 1024 * 1024)
      throw new Error('Import exceeds limit');
    const result = await inspectSourceFile(
      selectedImporter.plugin.id,
      selectedImporter.provider.id,
      selectedImporter.format.id,
      content,
      options.filename,
      options.signal,
      options.baseUrl,
    );
    const definitions = result.definitions.map((definition) => ({
      plugin: selectedImporter.plugin,
      provider: selectedImporter.provider,
      definition,
    }));
    const remoteSources = (result.references ?? []).map((reference) => ({
      plugin: selectedImporter.plugin,
      provider: selectedImporter.provider,
      reference,
    }));
    setImports((previous) => (options.append ? [...previous, ...definitions] : definitions));
    setReferences((previous) => (options.append ? [...previous, ...remoteSources] : remoteSources));
    if (result.diagnostics?.length)
      setStatus(result.diagnostics.map((item) => item.code).join(', '));
    if (!result.definitions.length && !remoteSources.length)
      setStatus(_('No sources found in this file'));
  };
  const downloadImport = async (
    sourceUrl: string,
    signal: AbortSignal,
    selectedImporter = importer,
    append = false,
  ) => {
    const url = assertSourceUrl(sourceUrl, {
      origins: [normalizeSourceOrigin(sourceUrl)],
      allowPrivateNetwork: false,
    });
    const response = await sourceTransport(
      url.href,
      { method: 'GET', headers: {}, allowPrivateNetwork: false },
      signal,
    );
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers['location'] &&
      selectedImporter
    ) {
      const target = new URL(response.headers['location'], url);
      assertSourceUrl(target.href, {
        origins: [normalizeSourceOrigin(target.href)],
        allowPrivateNetwork: false,
      });
      setReferences((previous) => [
        ...previous,
        {
          plugin: selectedImporter.plugin,
          provider: selectedImporter.provider,
          reference: {
            name: _('Redirected source file'),
            url: target.href,
            format: selectedImporter.format.id,
          },
        },
      ]);
      setStatus(_('Review the redirected website before downloading'));
      return;
    }
    if (response.status < 200 || response.status >= 300 || response.bytes.length > 4 * 1024 * 1024)
      throw new Error('Import failed');
    await inspect(new TextDecoder().decode(response.bytes), {
      filename: url.pathname.split('/').pop(),
      signal,
      baseUrl: url.href,
      importer: selectedImporter,
      append,
    });
  };
  const search = async (signal: AbortSignal, more = false, explore = false) => {
    if (!more) setExploring(explore);
    setDetail(undefined);
    const ids = more
      ? Object.keys(cursors)
      : selected.length
        ? selected
        : instances.filter((item) => item.enabled).map((item) => item.id);
    const found: FoundWork[] = more ? [...results] : [];
    const next: Record<string, string> = {};
    const failures: string[] = [];
    for (const id of ids) {
      signal.throwIfAborted();
      try {
        const runtime = await getSourceRuntime(id);
        if (
          explore ? !runtime.provider.capabilities.explore : !runtime.provider.capabilities.search
        )
          continue;
        const result = explore
          ? await runtime.call('source.explore', { cursor: more ? cursors[id] : undefined }, signal)
          : await runtime.call(
              'source.search',
              { query, cursor: more ? cursors[id] : undefined },
              signal,
            );
        for (const work of result.items)
          if (!found.some((item) => item.instanceId === id && item.work.id === work.id))
            found.push({ instanceId: id, work });
        if (result.nextCursor && result.nextCursor !== cursors[id]) next[id] = result.nextCursor;
      } catch (failure) {
        signal.throwIfAborted();
        failures.push(
          `${instances.find((item) => item.id === id)?.name ?? _('Source')}: ${codeOf(failure)}`,
        );
      }
    }
    setResults(found);
    setCursors(next);
    setStatus(failures.join('\n') || (!found.length ? _('No results') : ''));
  };
  const showWork = async (item: FoundWork, signal: AbortSignal, saved?: SourceBookRef) => {
    const instance = instances.find((source) => source.id === item.instanceId);
    const work =
      saved?.work ??
      (await (
        await getSourceRuntime(item.instanceId)
      ).call('source.getWork', { work: item.work }, signal));
    const ref =
      saved ??
      (instance && {
        instanceId: instance.id,
        pluginId: instance.pluginId,
        fingerprint: instance.fingerprint,
        work,
      });
    if (!ref) return;
    setDetail(ref);
    setChapters([]);
    setChapterIds([]);
    setPinned({});
    setVisibleChapters(100);
    const entries = await listSourceChapters(ref, { signal });
    setChapters(entries);
    const states = await Promise.all(
      entries
        .slice(0, 100)
        .map(
          async (chapter) => [chapter.id, await sourceChapterDownloaded(ref, chapter.id)] as const,
        ),
    );
    signal.throwIfAborted();
    setPinned(Object.fromEntries(states));
  };
  const collect = async (read = false) => {
    if (!appService || !detail) return;
    const existing = library.find(
      (book) => book.hash === sourceBookHash(detail.instanceId, detail.work.id) && !book.deletedAt,
    );
    const book = existing ?? (await addSourceWork(appService, detail.instanceId, detail.work));
    setStatus(_('Added to library'));
    if (read) {
      onClose();
      navigateToReader(router, [book.hash]);
    }
  };
  const task = detail ? downloads[sourceBookHash(detail.instanceId, detail.work.id)] : undefined;
  return (
    <>
      <Dialog isOpen={isOpen} portal aboveKeyboard title={_('Network sources')} onClose={onClose}>
        <div className='flex flex-col gap-4' aria-busy={busy}>
          <p className='text-base-content/70 text-sm'>
            {_('Find books, manage website access, and download chapters for offline reading')}
          </p>
          <div className='flex flex-wrap gap-2'>
            {(['sources', 'search', 'saved'] as const).map((value) => (
              <button
                key={value}
                type='button'
                className={tab === value ? 'btn btn-sm btn-contrast' : button}
                onClick={() => {
                  setTab(value);
                  setDetail(undefined);
                }}
              >
                {_({ sources: 'Sources', search: 'Search', saved: 'Saved books' }[value])}
              </button>
            ))}
            {busy && (
              <button type='button' className={button} onClick={() => active.current?.abort()}>
                {_('Cancel')}
              </button>
            )}
          </div>
          {error && (
            <p role='alert' className='text-error text-sm'>
              {_('Operation failed')}: {error}
            </p>
          )}
          {status && (
            <p role='status' className='whitespace-pre-wrap text-sm'>
              {status}
            </p>
          )}
          {busy && (
            <p role='status' className='text-sm'>
              {_('Working…')}
            </p>
          )}
          {tab === 'sources' && (
            <>
              {!providers.length && (
                <p className='text-sm'>
                  {_('Install and enable a content source plugin in Plugins first')}
                </p>
              )}
              {!!nativeProviders.length && (
                <BoxedList title={_('Native source')}>
                  <SettingsRow label={_('Provider')}>
                    <SettingsSelect
                      ariaLabel={_('Provider')}
                      value={native ? `${native.plugin.id}:${native.provider.id}` : ''}
                      onChange={(event) => setProviderKey(event.target.value)}
                      options={nativeProviders.map((item) => ({
                        value: `${item.plugin.id}:${item.provider.id}`,
                        label: item.provider.name,
                      }))}
                    />
                  </SettingsRow>
                  <SettingsRow label={_('Add source')}>
                    <button
                      type='button'
                      className={button}
                      disabled={busy || !native}
                      onClick={() => native && setEditor(native)}
                    >
                      {_('Configure')}
                    </button>
                  </SettingsRow>
                </BoxedList>
              )}
              {!!formats.length && (
                <BoxedList
                  title={_('Import source file')}
                  description={_(
                    'Review each source and its website permissions before enabling it',
                  )}
                >
                  <SettingsRow label={_('Format')}>
                    <SettingsSelect
                      ariaLabel={_('Source format')}
                      value={importer ? `${importer.plugin.id}:${importer.format.id}` : ''}
                      onChange={(event) => setFormatKey(event.target.value)}
                      options={formats.map((item) => ({
                        value: `${item.plugin.id}:${item.format.id}`,
                        label: item.format.name,
                      }))}
                    />
                  </SettingsRow>
                  <SettingsRow label={_('Local file')}>
                    <button
                      type='button'
                      className={button}
                      disabled={busy}
                      onClick={() => fileInput.current?.click()}
                    >
                      {_('Choose file')}
                    </button>
                  </SettingsRow>
                  <SettingsRow label={_('Source URL')}>
                    <SettingsInput
                      type='url'
                      aria-label={_('Source URL')}
                      value={importUrl}
                      onChange={(event) => setImportUrl(event.target.value)}
                    />
                  </SettingsRow>
                  <SettingsRow label={_('Download source file')}>
                    <button
                      type='button'
                      className={button}
                      disabled={busy || !importUrl.trim()}
                      onClick={() => void act((signal) => downloadImport(importUrl, signal))}
                    >
                      {_('Download and inspect')}
                    </button>
                  </SettingsRow>
                </BoxedList>
              )}
              <input
                ref={fileInput}
                type='file'
                className='hidden'
                accept='.json,.txt,.js'
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file)
                    void act(async (signal) => {
                      if (file.size > 4 * 1024 * 1024) throw new Error('File too large');
                      await inspect(await file.text(), { filename: file.name, signal });
                    });
                }}
              />
              {references.map((item, index) => {
                const target = formats.find(
                  (format) =>
                    format.plugin.id === item.plugin.id &&
                    format.provider.id === item.provider.id &&
                    format.format.id === item.reference.format,
                );
                return (
                  <BoxedList
                    key={`${item.reference.url}:${index}`}
                    title={item.reference.name}
                    description={new URL(item.reference.url).origin}
                  >
                    <SettingsRow
                      label={_('Source file not downloaded')}
                      description={!target ? _('Unsupported source format') : undefined}
                      responsive
                    >
                      <button
                        type='button'
                        className={button}
                        disabled={busy || !target}
                        onClick={() =>
                          void act(async (signal) => {
                            await downloadImport(item.reference.url, signal, target, true);
                            setReferences((previous) =>
                              previous.filter((candidate) => candidate !== item),
                            );
                          })
                        }
                      >
                        {_('Download and inspect')}
                      </button>
                    </SettingsRow>
                  </BoxedList>
                );
              })}
              {imports.map((item, index) => (
                <BoxedList key={`${item.definition.id}:${index}`}>
                  <SettingsRow label={item.definition.name} description={_('Awaiting review')}>
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
              {instances.map((instance) => (
                <BoxedList key={instance.id} title={instance.name}>
                  <SettingsSwitchRow
                    label={_('Enabled')}
                    checked={instance.enabled}
                    disabled={busy}
                    onChange={() =>
                      void act(async () => {
                        await setSourceInstanceEnabled(instance.id, !instance.enabled);
                      })
                    }
                  />
                  <SettingsRow label={_('Manage source')} responsive>
                    <div className='flex flex-wrap justify-end gap-2'>
                      <button
                        type='button'
                        className={button}
                        disabled={busy}
                        onClick={() => {
                          const provider = providers.find(
                            (item) =>
                              item.plugin.id === instance.pluginId &&
                              item.provider.id === instance.providerId,
                          );
                          if (provider) setEditor({ ...provider, instance });
                        }}
                      >
                        {_('Settings')}
                      </button>
                      {providers.find(
                        (item) =>
                          item.plugin.id === instance.pluginId &&
                          item.provider.id === instance.providerId,
                      )?.provider.capabilities.authenticate && (
                        <button
                          type='button'
                          className={button}
                          disabled={busy || !instance.enabled}
                          onClick={() =>
                            void act(async (signal) => {
                              const result = await (await getSourceRuntime(instance.id)).call(
                                'source.authenticate',
                                {},
                                signal,
                              );
                              setStatus(
                                result.authenticated ? _('Signed in') : _('Sign-in not completed'),
                              );
                            })
                          }
                        >
                          {_('Sign in')}
                        </button>
                      )}
                      <button
                        type='button'
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await removeSourceInstance(instance.id);
                          })
                        }
                      >
                        {_('Remove')}
                      </button>
                    </div>
                  </SettingsRow>
                </BoxedList>
              ))}
              {!!diagnostics.length && (
                <details>
                  <summary className='text-sm'>{_('Diagnostics')}</summary>
                  <ul className='mt-2 space-y-1 text-xs'>
                    {diagnostics.slice(0, 20).map((entry, index) => (
                      <li key={`${entry.startedAt}:${index}`}>
                        {instances.find((item) => item.id === entry.instanceId)?.name ??
                          _('Source')}{' '}
                        · {entry.operation} · {entry.duration} ms · {entry.code ?? 'OK'}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {tab === 'search' && !detail && (
            <>
              <BoxedList
                title={_('Search sources')}
                description={_(
                  'Select sources, or leave all unselected to search every enabled source',
                )}
              >
                {instances
                  .filter((item) => item.enabled)
                  .map((instance) => (
                    <SettingsSwitchRow
                      key={instance.id}
                      label={instance.name}
                      checked={selected.includes(instance.id)}
                      onChange={() =>
                        setSelected(
                          selected.includes(instance.id)
                            ? selected.filter((id) => id !== instance.id)
                            : [...selected, instance.id],
                        )
                      }
                    />
                  ))}
                <SettingsRow label={_('Search')}>
                  <SettingsInput
                    aria-label={_('Search books')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !busy) void act((signal) => search(signal));
                    }}
                  />
                </SettingsRow>
              </BoxedList>
              <div className='flex gap-2'>
                <button
                  type='button'
                  className='btn btn-sm btn-contrast'
                  disabled={busy}
                  onClick={() => void act((signal) => search(signal))}
                >
                  {_('Search')}
                </button>
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() => void act((signal) => search(signal, false, true))}
                >
                  {_('Explore')}
                </button>
              </div>
              {results.map((item) => (
                <BoxedList key={`${item.instanceId}:${item.work.id}`}>
                  <SettingsRow
                    label={item.work.title}
                    description={`${item.work.author} · ${instances.find((source) => source.id === item.instanceId)?.name ?? ''}`}
                  >
                    <button
                      type='button'
                      className={button}
                      disabled={busy}
                      onClick={() => void act((signal) => showWork(item, signal))}
                    >
                      {_('Details')}
                    </button>
                  </SettingsRow>
                </BoxedList>
              ))}
              {!!Object.keys(cursors).length && (
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() => void act((signal) => search(signal, true, exploring))}
                >
                  {_('Load more')}
                </button>
              )}
            </>
          )}
          {tab === 'saved' &&
            !detail &&
            library
              .filter((book) => !book.deletedAt && getSourceBookRef(book))
              .map((book) => {
                const ref = getSourceBookRef(book)!;
                return (
                  <BoxedList key={book.hash}>
                    <SettingsRow label={book.title} description={book.author}>
                      <button
                        type='button'
                        className={button}
                        disabled={busy}
                        onClick={() => void act((signal) => showWork(ref, signal, ref))}
                      >
                        {_('Details')}
                      </button>
                    </SettingsRow>
                  </BoxedList>
                );
              })}
          {detail && (
            <>
              <button
                type='button'
                className={`${button} self-start`}
                disabled={busy}
                onClick={() => setDetail(undefined)}
              >
                {_('Back')}
              </button>
              <h2 className='text-lg font-semibold tracking-tight'>{detail.work.title}</h2>
              <p className='text-sm'>{detail.work.author}</p>
              {detail.work.description && (
                <p className='text-base-content/70 whitespace-pre-wrap text-sm'>
                  {detail.work.description}
                </p>
              )}
              <div className='flex flex-wrap gap-2'>
                <button
                  type='button'
                  className='btn btn-sm btn-contrast'
                  disabled={busy}
                  onClick={() => void act(async () => collect(true))}
                >
                  {_('Read')}
                </button>
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() => void act(async () => collect())}
                >
                  {_('Add to library')}
                </button>
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void act(async (signal) => {
                      const previous = new Set(
                        chapters.filter((chapter) => !chapter.removed).map((chapter) => chapter.id),
                      );
                      const current = await listSourceChapters(detail, { refresh: true, signal });
                      setChapters(current);
                      setStatus(
                        _('New chapters: {{count}}', {
                          count: current.filter(
                            (chapter) => !chapter.removed && !previous.has(chapter.id),
                          ).length,
                        }),
                      );
                    })
                  }
                >
                  {_('Check for updates')}
                </button>
              </div>
              <div className='flex flex-wrap gap-2'>
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    setChapterIds(
                      chapters.filter((chapter) => !chapter.removed).map((chapter) => chapter.id),
                    )
                  }
                >
                  {_('Select all')}
                </button>
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() => setChapterIds([])}
                >
                  {_('Clear selection')}
                </button>
                <button
                  type='button'
                  className={button}
                  disabled={busy || !chapterIds.length}
                  onClick={() =>
                    void act(async (signal) => {
                      await collect();
                      await downloadSourceChapters(detail, chapterIds, signal);
                      setPinned({
                        ...pinned,
                        ...Object.fromEntries(chapterIds.map((id) => [id, true])),
                      });
                    })
                  }
                >
                  {_('Download selected')}
                </button>
                <button
                  type='button'
                  className={button}
                  disabled={busy || !chapterIds.some((id) => pinned[id])}
                  onClick={() =>
                    void act(async () => {
                      for (const id of chapterIds.filter((id) => pinned[id]))
                        await removeSourceDownloadedChapter(detail, id);
                      setPinned({
                        ...pinned,
                        ...Object.fromEntries(chapterIds.map((id) => [id, false])),
                      });
                      setChapterIds([]);
                      setStatus(_('Downloaded chapters removed'));
                    })
                  }
                >
                  {_('Remove selected downloads')}
                </button>
              </div>
              {task && (
                <p role='status' className='text-sm'>
                  {task.completed}/{task.total} ·{' '}
                  {_(
                    {
                      downloading: 'Downloading',
                      completed: 'Download complete',
                      cancelled: 'Cancelled',
                      failed: 'Download failed',
                    }[task.phase],
                  )}
                </p>
              )}
              <BoxedList title={_('Chapters')}>
                {chapters.slice(0, visibleChapters).map((chapter) => (
                  <SettingsSwitchRow
                    key={chapter.id}
                    label={chapter.title}
                    description={
                      chapter.removed
                        ? _('Removed from source')
                        : pinned[chapter.id]
                          ? _('Downloaded')
                          : chapter.group
                    }
                    checked={chapterIds.includes(chapter.id)}
                    disabled={busy || (!!chapter.removed && !pinned[chapter.id])}
                    onChange={() =>
                      setChapterIds(
                        chapterIds.includes(chapter.id)
                          ? chapterIds.filter((id) => id !== chapter.id)
                          : [...chapterIds, chapter.id],
                      )
                    }
                  />
                ))}
              </BoxedList>
              {chapters.length > visibleChapters && (
                <button
                  type='button'
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const states = await Promise.all(
                        chapters
                          .slice(visibleChapters, visibleChapters + 100)
                          .map(
                            async (chapter) =>
                              [
                                chapter.id,
                                await sourceChapterDownloaded(detail, chapter.id),
                              ] as const,
                          ),
                      );
                      setPinned({ ...pinned, ...Object.fromEntries(states) });
                      setVisibleChapters(visibleChapters + 100);
                    })
                  }
                >
                  {_('Show more chapters')}
                </button>
              )}
            </>
          )}
        </div>
      </Dialog>
      {editor && (
        <SourceEditor
          editor={editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setImports(imports.filter((item) => item.definition !== editor.definition));
            setEditor(undefined);
          }}
        />
      )}
    </>
  );
}
