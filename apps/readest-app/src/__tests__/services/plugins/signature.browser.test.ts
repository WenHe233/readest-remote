import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyEd25519Signature } from '@/services/plugins/signature';

const hex = (value: string) =>
  Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => parseInt(byte, 16));
// RFC 8032 section 7.1, TEST 1 (empty message).
const publicKey = hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
const signature = hex(
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
);
const message = new Uint8Array();
afterEach(() => vi.restoreAllMocks());

describe('plugin signature verification across browser engines', () => {
  it('accepts the RFC vector and rejects modified bytes with the engine implementation', async () => {
    expect(await verifyEd25519Signature(publicKey, signature, message)).toBe(true);
    expect(await verifyEd25519Signature(publicKey, signature, new Uint8Array([1]))).toBe(false);
  });
  it('uses strict verification when WebCrypto does not support Ed25519', async () => {
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(
      new DOMException('Unavailable', 'NotSupportedError'),
    );
    expect(await verifyEd25519Signature(publicKey, signature, message)).toBe(true);
    const changed = signature.slice();
    changed[0] = changed[0]! ^ 1;
    expect(await verifyEd25519Signature(publicKey, changed, message)).toBe(false);
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const smallOrder = new Uint8Array(64);
    smallOrder[0] = 1;
    expect(await verifyEd25519Signature(identity, smallOrder, message)).toBe(false);
  });
  it('does not bypass a negative verification or unrelated crypto failure', async () => {
    vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({} as CryptoKey);
    vi.spyOn(crypto.subtle, 'verify').mockResolvedValue(false);
    expect(await verifyEd25519Signature(publicKey, signature, message)).toBe(false);
    const denied = new DOMException('Denied', 'SecurityError');
    vi.mocked(crypto.subtle.importKey).mockRejectedValue(denied);
    await expect(verifyEd25519Signature(publicKey, signature, message)).rejects.toBe(denied);
  });
});
