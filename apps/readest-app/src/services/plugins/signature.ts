/** Verify the package's Ed25519 inventory without relaxing signature acceptance.
 * WKWebView versions without Ed25519 WebCrypto use the pinned pure-JS verifier.
 * Invalid signatures and other cryptographic errors never trigger a fallback.
 */
export async function verifyEd25519Signature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  payload: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKey), 'Ed25519', false, [
      'verify',
    ]);
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      new Uint8Array(signature),
      new Uint8Array(payload),
    );
  } catch (error) {
    if (
      !(error && typeof error === 'object' && 'name' in error && error.name === 'NotSupportedError')
    )
      throw error;
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    // ZIP215's consensus-oriented acceptance is broader than RFC8032.
    return ed25519.verify(signature, payload, publicKey, { zip215: false });
  }
}
