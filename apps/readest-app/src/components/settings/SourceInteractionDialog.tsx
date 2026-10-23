'use client';

import { useState } from 'react';
import type { ContentSourceContribution } from '@readest/plugin-sdk';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import {
  useSourceInteractions,
  type SourceInteraction,
} from '@/services/contentSources/interactions';
import {
  useSourceOriginRequests,
  grantSourceOrigin,
  dismissSourceOrigin,
} from '@/services/contentSources/permissions';
import { useSourceInstances } from '@/services/contentSources/instances';
import { BoxedList, SettingsInput, SettingsRow, SettingsSwitchRow } from './primitives';

export function SourceFields({
  fields,
  values,
  onChange,
}: {
  fields: ContentSourceContribution['settings'];
  values: Record<string, string | boolean>;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const _ = useTranslation();
  return (
    <>
      {fields.map((field) =>
        field.type === 'boolean' ? (
          <SettingsSwitchRow
            key={field.key}
            label={_(field.label)}
            checked={values[field.key] === true}
            onChange={() => onChange(field.key, values[field.key] !== true)}
          />
        ) : (
          <SettingsRow key={field.key} label={_(field.label)} responsive>
            <SettingsInput
              aria-label={_(field.label)}
              type={field.type === 'secret' ? 'password' : 'text'}
              autoComplete='off'
              required={field.required}
              value={String(values[field.key] ?? '')}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          </SettingsRow>
        ),
      )}
    </>
  );
}

function InteractionForm({ item }: { item: SourceInteraction }) {
  const _ = useTranslation();
  const [values, setValues] = useState<Record<string, string | boolean>>(
    () =>
      Object.fromEntries(
        Object.entries(item.request.values ?? {}).filter(
          ([, value]) => typeof value === 'string' || typeof value === 'boolean',
        ),
      ) as Record<string, string | boolean>,
  );
  const name = useSourceInstances(
    (state) => state.instances.find((instance) => instance.id === item.instanceId)?.name,
  );
  const fields = item.request.kind === 'form' ? (item.request.fields ?? []) : [];
  return (
    <Dialog
      isOpen
      portal
      aboveKeyboard
      title={item.request.title}
      onClose={() => item.answer(null)}
    >
      <form
        className='flex flex-col gap-4'
        onSubmit={(event) => {
          event.preventDefault();
          item.answer(values);
        }}
      >
        <p className='text-base-content/70 text-sm'>{name}</p>
        {item.request.message && (
          <p className='whitespace-pre-wrap break-words text-sm'>{item.request.message}</p>
        )}
        {!!fields.length && (
          <BoxedList>
            <SourceFields
              fields={fields}
              values={values}
              onChange={(key, value) => setValues({ ...values, [key]: value })}
            />
          </BoxedList>
        )}
        <div className='flex justify-end gap-2'>
          <button type='button' className='btn btn-ghost' onClick={() => item.answer(null)}>
            {_('Cancel')}
          </button>
          <button type='submit' className='btn btn-contrast'>
            {_('Continue')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export default function SourceInteractionDialog() {
  const _ = useTranslation();
  const interaction = useSourceInteractions((state) => state.pending[0]);
  const origin = useSourceOriginRequests((state) => state.requests[0]);
  const instances = useSourceInstances((state) => state.instances);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (origin)
    return (
      <Dialog
        isOpen
        portal
        title={_('Allow source access')}
        onClose={() => dismissSourceOrigin(origin.instanceId, origin.origin)}
      >
        <div className='flex flex-col gap-4'>
          <p className='text-sm'>
            {instances.find((instance) => instance.id === origin.instanceId)?.name}
          </p>
          <p className='text-base-content/70 text-sm'>
            {_(
              'This source requested access to another website. Retry the operation after granting access.',
            )}
          </p>
          <code className='eink-bordered border-base-200 rounded-lg border p-3 break-all'>
            {origin.origin}
          </code>
          {failed && <p role='alert'>{_('Permission could not be saved')}</p>}
          <div className='flex justify-end gap-2'>
            <button
              type='button'
              className='btn btn-ghost'
              disabled={busy}
              onClick={() => dismissSourceOrigin(origin.instanceId, origin.origin)}
            >
              {_('Deny')}
            </button>
            <button
              type='button'
              className='btn btn-contrast'
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailed(false);
                void grantSourceOrigin(origin.instanceId, origin.origin)
                  .catch(() => setFailed(true))
                  .finally(() => setBusy(false));
              }}
            >
              {_('Allow')}
            </button>
          </div>
        </div>
      </Dialog>
    );
  return interaction ? <InteractionForm key={interaction.id} item={interaction} /> : null;
}
