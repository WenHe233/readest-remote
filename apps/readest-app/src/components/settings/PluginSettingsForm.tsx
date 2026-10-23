import { useEffect, useState } from 'react';
import type { InstalledPlugin } from '@/services/plugins/types';
import {
  readPluginSettings,
  readPluginSettingSecrets,
  savePluginSettings,
} from '@/services/plugins/settings';
import { sourceErrorMessage } from '@/services/contentSources/errors';
import { useTranslation } from '@/hooks/useTranslation';
import { BoxedList } from './primitives';
import { SourceFields } from './SourceInteractionDialog';

export default function PluginSettingsForm({ plugin }: { plugin: InstalledPlugin }) {
  const _ = useTranslation();
  const fields = plugin.manifest.contributions.settings ?? [];
  const [values, setValues] = useState<Record<string, string | boolean | number>>({});
  const [saved, setSaved] = useState<string[]>([]);
  const [clear, setClear] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!fields.length) return;
    let stopped = false;
    void Promise.all([readPluginSettings(plugin), readPluginSettingSecrets(plugin)])
      .then(([config, secrets]) => {
        if (stopped) return;
        setSaved(Object.keys(secrets));
        setValues(
          Object.fromEntries(
            fields.map((field) => [
              field.key,
              field.type === 'secret'
                ? ''
                : ((field.private ? secrets[field.key] : config[field.key]) ??
                  field.default ??
                  (field.type === 'boolean' ? false : '')),
            ]),
          ) as Record<string, string | boolean | number>,
        );
      })
      .catch((failure) => {
        if (!stopped) setError(sourceErrorMessage(failure, _));
      })
      .finally(() => {
        if (!stopped) setBusy(false);
      });
    return () => {
      stopped = true;
    };
  }, [plugin]);
  if (!fields.length) return null;
  return (
    <form
      className='flex flex-col gap-3'
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void savePluginSettings(plugin, fields, values, clear)
          .then(async () => {
            setSaved(Object.keys(await readPluginSettingSecrets(plugin)));
            setClear([]);
            setValues((current) =>
              Object.fromEntries(
                Object.entries(current).map(([key, value]) => [
                  key,
                  fields.find((field) => field.key === key)?.type === 'secret' ? '' : value,
                ]),
              ),
            );
          })
          .catch((failure) => setError(sourceErrorMessage(failure, _)))
          .finally(() => setBusy(false));
      }}
    >
      <BoxedList title={_('Plugin settings')}>
        <SourceFields
          fields={fields}
          values={values}
          savedSecrets={saved.filter((key) => !clear.includes(key))}
          onClear={(key) => {
            setClear([...clear, key]);
            setValues({ ...values, [key]: '' });
          }}
          onChange={(key, value) => {
            setClear(clear.filter((item) => item !== key));
            setValues({ ...values, [key]: value });
          }}
        />
      </BoxedList>
      {error && <p role='alert'>{error}</p>}
      <button
        type='submit'
        className='btn btn-sm btn-contrast self-end'
        disabled={busy || !plugin.enabled}
      >
        {_('Save')}
      </button>
    </form>
  );
}
