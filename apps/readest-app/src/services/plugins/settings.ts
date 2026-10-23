import { create } from 'zustand';
import { isPrivateSetting, type Json, type SettingField } from '@readest/plugin-sdk';
import { readPluginRecord, writePluginRecords } from './persistence';

export type PluginSettingsOwner = { id: string; fingerprint: string };
const ownerFor = (owner: PluginSettingsOwner) => ({
  pluginId: owner.id,
  fingerprint: owner.fingerprint,
  id: 'plugin-settings',
});
export const usePluginSettingsChanges = create<{ pluginId?: string; revision: number }>(() => ({
  revision: 0,
}));
const changed = (pluginId: string) =>
  usePluginSettingsChanges.setState((state) => ({ pluginId, revision: state.revision + 1 }));
const keyFor = (owner: PluginSettingsOwner) => `plugin-settings:${owner.id}:${owner.fingerprint}`;
export const readPluginSettings = (owner: PluginSettingsOwner) =>
  readPluginRecord<Record<string, Json>>(keyFor(owner)).then((value) => value ?? {});
export const readPluginSettingSecrets = async (owner: PluginSettingsOwner) =>
  (await import('../contentSources/privateStorage')).readSourceCredentials(ownerFor(owner));
export async function savePluginSettings(
  owner: PluginSettingsOwner,
  fields: SettingField[],
  values: Record<string, string | boolean | number>,
  clear: string[] = [],
) {
  const config = await readPluginSettings(owner);
  const secrets = await readPluginSettingSecrets(owner);
  clear.forEach((key) => delete secrets[key]);
  for (const field of fields) {
    const value = values[field.key] ?? field.default;
    if (value === undefined) continue;
    if (isPrivateSetting(field)) {
      if (value !== '' || field.type !== 'secret') secrets[field.key] = String(value);
      delete config[field.key];
    } else config[field.key] = value;
  }
  await (await import('../contentSources/privateStorage')).writeSourceCredentials(
    ownerFor(owner),
    secrets,
  );
  await writePluginRecords({ [keyFor(owner)]: config });
  changed(owner.id);
}

export async function clearPluginSettings(owner: PluginSettingsOwner) {
  await (await import('../contentSources/privateStorage')).writeSourceCredentials(
    ownerFor(owner),
    {},
  );
  await writePluginRecords({}, [keyFor(owner)]);
  changed(owner.id);
}
