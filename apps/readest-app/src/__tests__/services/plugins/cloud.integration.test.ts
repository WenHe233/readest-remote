// @vitest-environment node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoSession } from '@/libs/crypto/session';
import { EphemeralPassphraseStore } from '@/libs/crypto/passphrase';
import { encryptPackedFields, decryptRowFields } from '@/services/sync/replicaCryptoMiddleware';
import { pluginConnectionAdapter } from '@/services/sync/adapters/pluginConnection';
import { hlcPack, removeReplica } from '@/libs/crdt';
import type { ReplicaRow, CipherEnvelope } from '@/types/replica';
import type { ReplicaKeyRow } from '@/libs/replicaSyncClient';
const enabled = process.env['READEST_PLUGIN_INTEGRATION'] === '1';
describe.runIf(enabled)('self-hosted encrypted plugin connection replicas', () => {
  it('encrypts on device A, merges and decrypts on device B, preserves failure omission and deletes', async () => {
    const env = Object.fromEntries(
      readFileSync(resolve('../../../.v2-local/cloud.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i), l.slice(i + 1)];
        }),
    );
    const credPath = resolve('../../../.v2-local/cloud-test-user.json');
    let account: { email: string; password: string };
    if (existsSync(credPath)) account = JSON.parse(readFileSync(credPath, 'utf8'));
    else {
      account = {
        email: 'plugins-' + crypto.randomUUID() + '@example.org',
        password: crypto.randomUUID() + 'aA1!',
      };
      writeFileSync(credPath, JSON.stringify(account));
    }
    const auth = async (path: string) =>
      fetch('http://127.0.0.1:18000/auth/v1/' + path, {
        method: 'POST',
        headers: { apikey: env['ANON_KEY']!, 'content-type': 'application/json' },
        body: JSON.stringify(account),
      });
    let signed = await auth('token?grant_type=password');
    if (!signed.ok) {
      signed = await auth('signup');
    }
    expect(signed.status).toBe(200);
    const session = (await signed.json()) as { access_token: string; user: { id: string } };
    expect(typeof session.access_token).toBe('string');
    const request = async (path: string, method = 'GET', body?: unknown) =>
      fetch('http://127.0.0.1:3003/api/sync/' + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + session.access_token,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const client = {
      async listReplicaKeys() {
        const response = await request('replica-keys');
        expect(response.status).toBe(200);
        return ((await response.json()) as { rows: ReplicaKeyRow[] }).rows;
      },
      async createReplicaKey(alg: string) {
        const response = await request('replica-keys', 'POST', { alg });
        expect(response.status).toBe(201);
        return ((await response.json()) as { row: ReplicaKeyRow }).row;
      },
      async forgetReplicaKeys() {
        throw new Error('Fixture key deletion is not used');
      },
    };
    const deviceA = new CryptoSession({ client, store: new EphemeralPassphraseStore() });
    const deviceB = new CryptoSession({ client, store: new EphemeralPassphraseStore() });
    const passphrase = 'fixture-passphrase-' + account.password;
    await deviceA.setup(passphrase);
    const id = crypto.randomUUID();
    const credential = JSON.stringify({ apiKey: crypto.randomUUID() });
    const packed = pluginConnectionAdapter.pack({
      id,
      pluginId: 'test.cloud',
      fingerprint: 'a'.repeat(64),
      sourceId: 'library',
      name: 'Device A',
      url: 'http://192.168.10.1:5000',
      config: {},
      libraryIds: ['1'],
      secretNames: ['apiKey'],
      addedAt: Date.now(),
      updatedAt: Date.now(),
      credentials: credential,
    });
    await encryptPackedFields(packed, pluginConnectionAdapter.encryptedFields, deviceA);
    const stamp = hlcPack(Date.now(), 0, 'device-a');
    const row: ReplicaRow = {
      user_id: session.user.id,
      kind: 'plugin_connection',
      replica_id: id,
      fields_jsonb: Object.fromEntries(
        Object.entries(packed).map(([k, v]) => [k, { v, t: stamp, s: 'device-a' }]),
      ),
      manifest_jsonb: null,
      deleted_at_ts: null,
      reincarnation: crypto.randomUUID(),
      updated_at_ts: stamp,
      schema_version: 1,
    };
    expect(JSON.stringify(row)).not.toContain(credential);
    const pushed = await request('replicas', 'POST', { rows: [row] });
    expect(pushed.status).toBe(200);
    const pulled = await request('replicas?kind=plugin_connection');
    expect(pulled.status).toBe(200);
    const remote = ((await pulled.json()) as { rows: ReplicaRow[] }).rows.find(
      (r) => r.replica_id === id,
    )!;
    expect(remote).toBeTruthy();
    const cipher = (remote.fields_jsonb['credentials'] as { v: CipherEnvelope }).v;
    await deviceB.unlock(passphrase, { verifyWith: cipher });
    const decrypted = structuredClone(remote);
    await decryptRowFields(
      decrypted.fields_jsonb,
      pluginConnectionAdapter.encryptedFields,
      deviceB,
    );
    expect(pluginConnectionAdapter.unpackRow!(decrypted, '')?.credentials).toBe(credential);
    const wrong = new CryptoSession({ client, store: new EphemeralPassphraseStore() });
    await wrong.unlock('wrong');
    const failed = structuredClone(remote);
    await decryptRowFields(failed.fields_jsonb, pluginConnectionAdapter.encryptedFields, wrong);
    expect(pluginConnectionAdapter.unpackRow!(failed, '')?.credentials).toBeUndefined();
    const bad = structuredClone(row);
    bad.fields_jsonb['credentials'] = { v: credential, t: stamp, s: 'device-a' };
    expect((await request('replicas', 'POST', { rows: [bad] })).status).toBe(422);
    const updateStamp = hlcPack(Date.now(), 0, 'device-b');
    const renamed = {
      ...row,
      fields_jsonb: { name: { v: 'Device B', t: updateStamp, s: 'device-b' } },
      updated_at_ts: updateStamp,
    };
    expect((await request('replicas', 'POST', { rows: [renamed] })).status).toBe(200);
    const tombstone = removeReplica(
      { ...row, fields_jsonb: {} },
      hlcPack(Date.now() + 1, 0, 'device-b'),
    );
    expect((await request('replicas', 'POST', { rows: [tombstone] })).status).toBe(200);
    const final = await request('replicas?kind=plugin_connection');
    const removed = ((await final.json()) as { rows: ReplicaRow[] }).rows.find(
      (r) => r.replica_id === id,
    )!;
    expect(removed.deleted_at_ts).toBeTruthy();
  }, 180000);
});
