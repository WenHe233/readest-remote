import { describe, expect, it } from 'vitest';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { getIdentifier } from '@tauri-apps/api/app';
import { CryptoSession } from '@/libs/crypto/session';
import { TauriPassphraseStore, EphemeralPassphraseStore } from '@/libs/crypto/passphrase';
import { encryptPackedFields, decryptRowFields } from '@/services/sync/replicaCryptoMiddleware';
import { pluginConnectionAdapter } from '@/services/sync/adapters/pluginConnection';
import { hlcPack, removeReplica } from '@/libs/crdt';
import type { ReplicaRow, CipherEnvelope } from '@/types/replica';
import type { ReplicaKeyRow } from '@/libs/replicaSyncClient';
import {
  applyPluginConnection,
  getPluginConnection,
  savePluginDeviceConfig,
  getPluginDeviceConfig,
  loadPluginConnections,
  removePluginConnection,
} from '@/services/plugins/connections';
import { getConnectionSecrets, setConnectionSecrets } from '@/services/plugins/vault';
import {
  installPlugin,
  findInstalledPlugin,
  loadPluginManager,
  getLibraryRuntime,
} from '@/services/plugins/manager';
import { verifyPluginPackage } from '@/services/plugins/package';
import { readPluginRecord, writePluginRecords } from '@/services/plugins/persistence';
declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
declare const __PLUGIN_TEST_SERVERS__: Record<string, { url: string; apiKey: string }> | null;
declare const __PLUGIN_TEST_CLOUD__: {
  phase: 'a' | 'b' | 'a-verify';
  id: string;
  email: string;
  password: string;
  anonKey: string;
  passphrase: string;
} | null;

describe.runIf(!!__PLUGIN_TEST_CLOUD__)(
  'encrypted replicas across independent Windows application profiles',
  () => {
    it('runs the selected device phase against the real self-hosted backend and native keychain', async () => {
      const fixture = __PLUGIN_TEST_CLOUD__!;
      const phase = fixture.phase;
      expect(await getIdentifier()).toBe(
        'io.github.wenhe233.readestremote.verification.' + (phase === 'b' ? 'b' : 'a'),
      );
      const signed = await nativeFetch('http://127.0.0.1:18000/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: fixture.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email: fixture.email, password: fixture.password }),
      });
      expect(signed.status).toBe(200);
      const auth = (await signed.json()) as { access_token: string; user: { id: string } };
      const request = async (path: string, method = 'GET', body?: unknown) =>
        nativeFetch('http://127.0.0.1:3003/api/sync/' + path, {
          method,
          headers: {
            Authorization: 'Bearer ' + auth.access_token,
            'content-type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      const client = {
        async listReplicaKeys() {
          const result = await request('replica-keys');
          expect(result.status).toBe(200);
          return ((await result.json()) as { rows: ReplicaKeyRow[] }).rows;
        },
        async createReplicaKey(alg: string) {
          const result = await request('replica-keys', 'POST', { alg });
          expect(result.status).toBe(201);
          return ((await result.json()) as { row: ReplicaKeyRow }).row;
        },
        async forgetReplicaKeys() {
          throw new Error('Fixture keys are retained');
        },
      };
      const pull = async () => {
        const result = await request('replicas?kind=plugin_connection');
        expect(result.status).toBe(200);
        return ((await result.json()) as { rows: ReplicaRow[] }).rows.find(
          (row) => row.replica_id === fixture.id,
        )!;
      };
      const store = new TauriPassphraseStore();
      const session = new CryptoSession({ client, store });
      const pkg = await verifyPluginPackage(
        Uint8Array.from(atob(__PLUGIN_TEST_PACKAGES__['kavita']!), (c) => c.charCodeAt(0)),
      );
      await Promise.all([loadPluginConnections(), loadPluginManager()]);
      if (phase === 'a') {
        await session.setup(fixture.passphrase);
        const connection = {
          id: fixture.id,
          pluginId: pkg.manifest.id,
          fingerprint: pkg.fingerprint,
          sourceId: 'kavita',
          name: 'Windows A',
          url: __PLUGIN_TEST_SERVERS__!['kavita']!.url,
          config: {},
          libraryIds: ['1'],
          secretNames: ['apiKey'],
          addedAt: Date.now(),
          updatedAt: Date.now(),
          credentials: JSON.stringify({ apiKey: __PLUGIN_TEST_SERVERS__!['kavita']!.apiKey }),
        };
        await applyPluginConnection(connection);
        await installPlugin(pkg, true);
        await savePluginDeviceConfig(fixture.id, {
          urlOverride: 'http://device-a.invalid',
          cacheEnabled: false,
        });
        await writePluginRecords({ ['native-profile-marker:' + fixture.id]: 'A' });
        const packed = pluginConnectionAdapter.pack(connection);
        await encryptPackedFields(packed, pluginConnectionAdapter.encryptedFields, session);
        expect(JSON.stringify(packed)).not.toContain(__PLUGIN_TEST_SERVERS__!['kavita']!.apiKey);
        const stamp = hlcPack(Date.now(), 0, 'windows-a');
        const row: ReplicaRow = {
          user_id: auth.user.id,
          kind: 'plugin_connection',
          replica_id: fixture.id,
          fields_jsonb: Object.fromEntries(
            Object.entries(packed).map(([k, v]) => [k, { v, t: stamp, s: 'windows-a' }]),
          ),
          manifest_jsonb: null,
          deleted_at_ts: null,
          reincarnation: crypto.randomUUID(),
          updated_at_ts: stamp,
          schema_version: 1,
        };
        expect((await request('replicas', 'POST', { rows: [row] })).status).toBe(200);
        expect((await pull()).replica_id).toBe(fixture.id);
      } else if (phase === 'b') {
        // These assertions prove a separate WebView profile and Credential Manager namespace.
        expect(await readPluginRecord('native-profile-marker:' + fixture.id)).toBeUndefined();
        expect(await getConnectionSecrets(fixture.id)).toEqual({});
        expect(await store.get()).toBeNull();
        expect(findInstalledPlugin(pkg.manifest.id)).toBeUndefined();
        const remote = await pull();
        const cipher = (remote.fields_jsonb['credentials'] as { v: CipherEnvelope }).v;
        await setConnectionSecrets(fixture.id, { apiKey: 'keep-local-on-decrypt-failure' });
        const wrong = new CryptoSession({ client, store: new EphemeralPassphraseStore() });
        await wrong.unlock('deliberately-incorrect');
        const failed = structuredClone(remote);
        await decryptRowFields(failed.fields_jsonb, pluginConnectionAdapter.encryptedFields, wrong);
        await applyPluginConnection(pluginConnectionAdapter.unpackRow!(failed, '')!);
        expect((await getConnectionSecrets(fixture.id))['apiKey']).toBe(
          'keep-local-on-decrypt-failure',
        );
        await session.unlock(fixture.passphrase, { verifyWith: cipher });
        const valid = structuredClone(remote);
        await decryptRowFields(
          valid.fields_jsonb,
          pluginConnectionAdapter.encryptedFields,
          session,
        );
        await applyPluginConnection(pluginConnectionAdapter.unpackRow!(valid, '')!);
        expect((await getConnectionSecrets(fixture.id))['apiKey']).toBe(
          __PLUGIN_TEST_SERVERS__!['kavita']!.apiKey,
        );
        expect(await getPluginDeviceConfig(fixture.id)).toEqual({});
        await expect(getLibraryRuntime(fixture.id)).rejects.toThrow(/install/i);
        await installPlugin(pkg, true);
        const target = await getLibraryRuntime(fixture.id);
        expect(
          await target.runtime.call('library.testConnection', { context: target.lease.context }),
        ).toHaveProperty('name');
        const stamp = hlcPack(Date.now(), 0, 'windows-b');
        const renamed = {
          ...remote,
          fields_jsonb: { name: { v: 'Windows B', t: stamp, s: 'windows-b' } },
          updated_at_ts: stamp,
        };
        expect((await request('replicas', 'POST', { rows: [renamed] })).status).toBe(200);
        const merged = await pull();
        expect((merged.fields_jsonb['name'] as { v: string }).v).toBe('Windows B');
        expect(merged.fields_jsonb['credentials']).toEqual(remote.fields_jsonb['credentials']);
        expect(
          (
            await request('replicas', 'POST', {
              rows: [
                removeReplica(
                  { ...merged, fields_jsonb: {} },
                  hlcPack(Date.now() + 1, 0, 'windows-b'),
                ),
              ],
            })
          ).status,
        ).toBe(200);
      } else {
        expect(await readPluginRecord('native-profile-marker:' + fixture.id)).toBe('A');
        expect(await store.get()).toBe(fixture.passphrase);
        expect((await getPluginDeviceConfig(fixture.id)).urlOverride).toBe(
          'http://device-a.invalid',
        );
        expect((await pull()).deleted_at_ts).toBeTruthy();
        await removePluginConnection(fixture.id, false);
        expect(getPluginConnection(fixture.id)).toBeUndefined();
        expect(findInstalledPlugin(pkg.manifest.id)?.enabled).toBe(true);
      }
    }, 180000);
  },
);
