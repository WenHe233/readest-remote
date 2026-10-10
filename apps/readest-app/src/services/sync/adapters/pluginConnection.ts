import { pluginConnectionSchema, type PluginConnectionReplica } from '@/services/plugins/types';
import type { ReplicaAdapter } from '../replicaRegistry';
import { unwrap } from './helpers';
export const pluginConnectionAdapter: ReplicaAdapter<PluginConnectionReplica> = {
  kind: 'plugin_connection',
  schemaVersion: 1,
  encryptedFields: ['credentials'],
  computeId: async (connection) => connection.id,
  pack(connection) {
    const {
      lastSeenCipher: _cipher,
      deletedAt: _deleted,
      reincarnation: _incarnation,
      ...fields
    } = pluginConnectionSchema.parse(connection);
    return {
      ...fields,
      ...(connection.credentials === undefined ? {} : { credentials: connection.credentials }),
    };
  },
  unpack(fields) {
    const connection = pluginConnectionSchema.parse(fields);
    return {
      ...connection,
      ...(typeof fields['credentials'] === 'string' ? { credentials: fields['credentials'] } : {}),
    };
  },
  unpackRow(row) {
    const fields = Object.fromEntries(
      Object.entries(row.fields_jsonb).map(([key, value]) => [key, unwrap(value)]),
    );
    const parsed = pluginConnectionSchema.safeParse({ ...fields, id: row.replica_id });
    if (!parsed.success) return null;
    return {
      ...parsed.data,
      reincarnation: row.reincarnation ?? undefined,
      ...(typeof fields['credentials'] === 'string' ? { credentials: fields['credentials'] } : {}),
    };
  },
};
