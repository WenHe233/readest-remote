/**
 * Runs on `web.readest.com` (and the dev host). Reads Readest's Supabase
 * experimental session token out of the page's localStorage and copies it into
 * `chrome.storage.local`, so the extension popup can authenticate to
 * `/api/send/inbox` without prompting the user for credentials.
 *
 * No user data leaves the user's browser — the token is only ever stored in
 * the extension's own storage area, scoped to the extension.
 */

import { SUPABASE_AUTH_STORAGE_KEY } from '../../../../src/services/browserProfile';

interface SupabaseAuthValue {
  access_token?: string;
}

const TOKEN_SYNC_INTERVAL_MS = 5_000;
let lastSyncedToken: string | null | undefined;

function findAccessToken(): string | null {
  const raw = localStorage.getItem(SUPABASE_AUTH_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SupabaseAuthValue;
    if (value && typeof value.access_token === 'string' && value.access_token) {
      return value.access_token;
    }
  } catch {
    // Malformed entries are ignored — Supabase occasionally writes partials.
  }
  return null;
}

function syncToken(): void {
  const token = findAccessToken();
  if (token === lastSyncedToken) return;
  lastSyncedToken = token;

  if (token) {
    chrome.storage.local.set({
      readestAccessToken: token,
      readestTokenAt: Date.now(),
    });
  } else {
    // Token went away (sign-out) — clear so the extension stops showing a
    // stale "signed in" state.
    chrome.storage.local.remove(['readestAccessToken', 'readestTokenAt']);
  }
}

syncToken();

// Refresh periodically because the browser `storage` event only fires in
// other same-origin documents, not in the SPA document that performed the
// Supabase localStorage write. Deduping above keeps this cheap and avoids
// rewriting extension storage when the token has not changed.
setInterval(syncToken, TOKEN_SYNC_INTERVAL_MS);

// Still listen for cross-tab updates so a second Readest tab can refresh this
// content script without waiting for the next poll.
window.addEventListener('storage', (event) => {
  if (event.key === SUPABASE_AUTH_STORAGE_KEY || event.key === null) {
    syncToken();
  }
});

window.addEventListener('focus', syncToken);
window.addEventListener('pageshow', syncToken);
