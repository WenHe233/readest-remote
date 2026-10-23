import { create } from 'zustand';
import { z } from 'zod';
import {
  sourceContextSchema,
  sourceDefinitionSchema,
  sourceUrlSchema,
  type SourceDefinition,
} from '@readest/plugin-sdk';
import { listPluginRecords, readPluginRecord, writePluginRecords } from '../plugins/persistence';
import { clearConnectionSecrets } from '../plugins/vault';
import { writeSourceCredentials, sourcePrivateScope } from './privateStorage';
import { normalizeSourceOrigin } from './policy';

export const sourceInstanceSchema = z.strictObject({
  id: z.string().uuid(),
  pluginId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  providerId: z.string().min(1),
  name: z.string().min(1).max(2048),
  config: sourceContextSchema.shape.config,
  definitionId: z.string().uuid().optional(),
  importUrl: sourceUrlSchema.optional(),
  subscriptionId: z.string().uuid().optional(),
  enabled: z.boolean(),
  origins: z.array(z.string()).max(128),
  allowPrivateNetwork: z.boolean(),
  secretNames: z.array(z.string()).max(128),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SourceInstance = z.infer<typeof sourceInstanceSchema>;
export const useSourceInstances = create<{ instances: SourceInstance[]; loaded: boolean }>(() => ({
  instances: [],
  loaded: false,
}));
let loading: Promise<void> | undefined;
let mutations: Promise<unknown> = Promise.resolve();

export async function loadSourceInstances(): Promise<void> {
  return (loading ??= (async () => {
    const rows = await listPluginRecords<unknown>('source-instance:');
    const instances = rows.flatMap(({ value }) => {
      const parsed = sourceInstanceSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    useSourceInstances.setState({ instances, loaded: true });
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  }));
}
export const getSourceInstance = (id: string) =>
  useSourceInstances.getState().instances.find((instance) => instance.id === id);

export async function readSourceDefinition(id?: string): Promise<SourceDefinition | undefined> {
  if (!id) return undefined;
  const value = await readPluginRecord<unknown>(`source-definition:${id}`);
  return value === undefined ? undefined : sourceDefinitionSchema.parse(value);
}

export async function saveSourceInstance(
  input: SourceInstance,
  options: { definition?: SourceDefinition; secrets?: Record<string, string> } = {},
): Promise<SourceInstance> {
  await loadSourceInstances();
  const operation = mutations
    .catch(() => {})
    .then(async () => {
      const existing = getSourceInstance(input.id);
      if (
        existing &&
        (existing.pluginId !== input.pluginId ||
          existing.fingerprint !== input.fingerprint ||
          existing.providerId !== input.providerId)
      )
        throw new Error('Source ownership cannot be changed.');
      const instance = sourceInstanceSchema.parse({
        ...input,
        origins: [...new Set(input.origins.map(normalizeSourceOrigin))],
        definitionId: options.definition
          ? (existing?.definitionId ?? input.definitionId ?? crypto.randomUUID())
          : input.definitionId,
        updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
      });
      if (options.secrets) {
        await writeSourceCredentials(instance, options.secrets);
        instance.secretNames = Object.keys(options.secrets);
      }
      await writePluginRecords({
        [`source-instance:${instance.id}`]: instance,
        ...(options.definition
          ? {
              [`source-definition:${instance.definitionId}`]: sourceDefinitionSchema.parse(
                options.definition,
              ),
            }
          : {}),
      });
      useSourceInstances.setState((state) => ({
        instances: [...state.instances.filter((item) => item.id !== instance.id), instance],
      }));
      return instance;
    });
  mutations = operation;
  return operation;
}

/** Disabling retains definitions and downloaded books and revokes active leases immediately. */
export async function setSourceInstanceEnabled(id: string, enabled: boolean): Promise<void> {
  await loadSourceInstances();
  const current = getSourceInstance(id);
  if (current) await saveSourceInstance({ ...current, enabled });
}

export async function removeSourceInstance(id: string): Promise<void> {
  await loadSourceInstances();
  const operation = mutations
    .catch(() => {})
    .then(async () => {
      // Keep the identity/definition tombstone, so retained books cannot bind to another source.
      const current = getSourceInstance(id);
      if (!current) return;
      await writePluginRecords({ [`source-retired:${id}`]: { ...current, enabled: false } }, [
        `source-instance:${id}`,
      ]);
      useSourceInstances.setState((state) => ({
        instances: state.instances.filter((item) => item.id !== id),
      }));
    });
  mutations = operation;
  await operation;
}

/** Clear credentials and private state while keeping imported rules and offline reading intact. */
export async function clearSourcePluginData(pluginId: string, fingerprint: string): Promise<void> {
  await loadSourceInstances();
  const { drainSourceOperations } = await import('./network');
  const { forgetSourcePrivateKey } = await import('./privateStorage');
  await drainSourceOperations(pluginId);
  const operation = mutations
    .catch(() => {})
    .then(async () => {
      const [activeRows, retiredRows, kvRows, cookieRows, credentialRows] = await Promise.all([
        listPluginRecords<SourceInstance>('source-instance:'),
        listPluginRecords<SourceInstance>('source-retired:'),
        listPluginRecords<unknown>(`source-kv:${pluginId}:${fingerprint}:`),
        listPluginRecords<unknown>(`source-cookie:${pluginId}:${fingerprint}:`),
        listPluginRecords<unknown>(`source-credentials:${pluginId}:${fingerprint}:`),
      ]);
      const matching = [...activeRows, ...retiredRows].filter(
        ({ value }) => value.pluginId === pluginId && value.fingerprint === fingerprint,
      );
      for (const { value } of matching) {
        await clearConnectionSecrets(`source:${value.id}`);
        await clearConnectionSecrets(`source:${value.id}:cookies`);
        for (const kind of ['kv', 'cookie', 'credentials'] as const) {
          const scope = sourcePrivateScope(kind, value);
          await forgetSourcePrivateKey(scope);
          await clearConnectionSecrets(`source-state-key:${scope}`);
        }
      }
      const updates = Object.fromEntries(
        matching.map(({ key, value }) => [
          key,
          { ...value, secretNames: [], updatedAt: Math.max(Date.now(), value.updatedAt + 1) },
        ]),
      );
      await writePluginRecords(
        updates,
        [...kvRows, ...cookieRows, ...credentialRows].map(({ key }) => key),
      );
      useSourceInstances.setState((state) => ({
        instances: state.instances.map((value) => updates[`source-instance:${value.id}`] ?? value),
      }));
    });
  mutations = operation;
  await operation;
}
