import { profileLocalStorage } from '@/services/browserProfile';
// Per-device Send to Readest preferences, stored in localStorage (not synced
// across devices).

const DRAIN_ENABLED_KEY = 'readest-send-drain-enabled';

/**
 * Whether this device should drain the Send to Readest inbox — download,
 * convert, and import items emailed to the user's address. Defaults to true;
 * a user with several devices can turn it off on the ones that should not do
 * the work.
 */
export function isInboxDrainEnabled(): boolean {
  try {
    return profileLocalStorage.getItem(DRAIN_ENABLED_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setInboxDrainEnabled(enabled: boolean): void {
  try {
    profileLocalStorage.setItem(DRAIN_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    /* localStorage unavailable — the default (enabled) stands */
  }
}
