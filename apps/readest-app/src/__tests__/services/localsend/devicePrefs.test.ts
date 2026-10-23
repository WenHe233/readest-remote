import { profileLocalStorage } from '@/services/browserProfile';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getLocalSendAlias,
  isLocalSendEnabled,
  setLocalSendAlias,
  setLocalSendEnabled,
} from '@/services/localsend/devicePrefs';

const ENABLED_KEY = 'readest-localsend-enabled';

describe('Nearby BookDrop enable preference', () => {
  beforeEach(() => {
    profileLocalStorage.clear();
  });

  it('is on until the user turns it off', () => {
    expect(isLocalSendEnabled()).toBe(true);
  });

  it('only "false" turns it off', () => {
    profileLocalStorage.setItem(ENABLED_KEY, 'false');
    expect(isLocalSendEnabled()).toBe(false);
    profileLocalStorage.setItem(ENABLED_KEY, '');
    expect(isLocalSendEnabled()).toBe(true);
  });

  it('round-trips the toggle both ways', () => {
    setLocalSendEnabled(true);
    expect(profileLocalStorage.getItem(ENABLED_KEY)).toBe('true');
    expect(isLocalSendEnabled()).toBe(true);
    setLocalSendEnabled(false);
    expect(isLocalSendEnabled()).toBe(false);
  });

  it('leaves the alias empty until the user names the device', () => {
    expect(getLocalSendAlias()).toBe('');
    setLocalSendAlias('Study Mac');
    expect(getLocalSendAlias()).toBe('Study Mac');
  });
});
