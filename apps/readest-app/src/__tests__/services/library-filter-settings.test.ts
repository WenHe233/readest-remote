import { expect, it, vi } from 'vitest';
import { saveSysSettings } from '@/helpers/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import type { SystemSettings } from '@/types/settings';
import type { EnvConfigType } from '@/services/environment';

vi.mock('@/utils/settingsSync', () => ({ broadcastGlobalSettings: vi.fn() }));

it('saves and restores library selections through the existing settings persistence, including none and all', async () => {
  let saved = '';
  const env = {
    getAppService: async () => ({
      saveSettings: async (settings: SystemSettings) => {
        saved = JSON.stringify(settings);
      },
    }),
  } as unknown as EnvConfigType;
  for (const selection of [['local', 'source:one'], [], null]) {
    useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
    await saveSysSettings(env, 'libraryFilter', selection);
    useSettingsStore.setState({ settings: {} as SystemSettings });
    useSettingsStore.getState().setSettings(JSON.parse(saved));
    expect(useSettingsStore.getState().settings.libraryFilter).toEqual(selection);
  }
});
