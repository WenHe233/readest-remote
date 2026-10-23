import { create } from 'zustand';
import { z } from 'zod';
import { sourceReferenceSchema, sourceUrlSchema, type SourceReference } from '@readest/plugin-sdk';
import { listPluginRecords, writePluginRecords } from '../plugins/persistence';

const schema = z.strictObject({
  id: z.string().uuid(),
  pluginId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  providerId: z.string().min(1),
  format: z.string().min(1),
  name: z.string().min(1).max(2048),
  url: sourceUrlSchema.optional(),
  references: z.array(sourceReferenceSchema).max(1000),
  updatedAt: z.number(),
  error: z.string().max(4096).optional(),
});
export type SourceSubscription = z.infer<typeof schema>;
type Input = Omit<SourceSubscription, 'id' | 'references' | 'updatedAt' | 'error'> & {
  id?: string;
};
export const useSourceSubscriptions = create<{
  subscriptions: SourceSubscription[];
  loaded: boolean;
}>(() => ({ subscriptions: [], loaded: false }));
let loading: Promise<void> | undefined;
let writes: Promise<unknown> = Promise.resolve();
export async function loadSourceSubscriptions() {
  return (loading ??= (async () => {
    const rows = await listPluginRecords<unknown>('source-subscription:');
    useSourceSubscriptions.setState({
      subscriptions: rows.flatMap(({ value }) => {
        const parsed = schema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
      loaded: true,
    });
  })().catch((error) => {
    loading = undefined;
    throw error;
  }));
}
export async function saveSourceSubscription(input: Input, references: SourceReference[]) {
  await loadSourceSubscriptions();
  const operation = writes
    .catch(() => {})
    .then(async () => {
      const url = input.url ? new URL(input.url).href : undefined;
      const previous = useSourceSubscriptions
        .getState()
        .subscriptions.find(
          (item) =>
            item.pluginId === input.pluginId &&
            item.fingerprint === input.fingerprint &&
            item.providerId === input.providerId &&
            (input.id
              ? item.id === input.id
              : url
                ? item.url === url && item.format === input.format
                : item.name === input.name && !item.url),
        );
      const item = schema.parse({
        ...input,
        id: previous?.id ?? input.id ?? crypto.randomUUID(),
        url,
        references: [...new Map(references.map((ref) => [new URL(ref.url).href, ref])).values()],
        updatedAt: Date.now(),
      });
      await writePluginRecords({ ['source-subscription:' + item.id]: item });
      useSourceSubscriptions.setState((state) => ({
        subscriptions: [...state.subscriptions.filter((row) => row.id !== item.id), item],
      }));
      return item;
    });
  writes = operation;
  return operation;
}
export async function refreshSourceSubscription(
  id: string,
  fetch: (subscription: SourceSubscription) => Promise<SourceReference[]>,
) {
  await loadSourceSubscriptions();
  const item = useSourceSubscriptions.getState().subscriptions.find((row) => row.id === id);
  if (!item) throw new Error('Source list is unavailable');
  try {
    return await saveSourceSubscription(item, await fetch(item));
  } catch (error) {
    const failed = { ...item, error: 'Source list refresh failed' };
    await writePluginRecords({ ['source-subscription:' + id]: failed });
    useSourceSubscriptions.setState((state) => ({
      subscriptions: state.subscriptions.map((row) => (row.id === id ? failed : row)),
    }));
    throw error;
  }
}
export async function removeSourceSubscription(id: string) {
  await loadSourceSubscriptions();
  await writePluginRecords({}, ['source-subscription:' + id]);
  useSourceSubscriptions.setState((state) => ({
    subscriptions: state.subscriptions.filter((row) => row.id !== id),
  }));
}
