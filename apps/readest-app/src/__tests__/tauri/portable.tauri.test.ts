import { expect, it } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { exists, writeTextFile, readTextFile, mkdir, remove } from '@tauri-apps/plugin-fs';
import { NativeAppService } from '@/services/nativeAppService';

it('isolates experimental portable settings and preserves them when the book root changes', async () => {
  const exe = await invoke<string>('get_executable_dir');
  const stableSettingsPath = await join(exe, 'settings.json');
  const profile = await join(exe, 'Readest-Remote-Experimental');
  const settingsPath = await join(profile, 'settings.json');
  const books = await join(profile, 'Readest');
  const chosen = await join(exe, 'portable-test-' + crypto.randomUUID());
  const workspace = process.env['CWD']!.replace(/[\\/]apps[\\/]readest-app$/, '');
  for (const path of [stableSettingsPath, profile, chosen]) {
    expect(
      path
        .replaceAll('\\', '/')
        .toLowerCase()
        .startsWith(workspace.replaceAll('\\', '/').toLowerCase() + '/'),
    ).toBe(true);
    expect(await exists(path)).toBe(false);
  }
  const stableSettings = JSON.stringify({ migrationVersion: 99999999, fixture: 'stable' });
  await writeTextFile(stableSettingsPath, stableSettings);
  try {
    const installed = new NativeAppService();
    await installed.init();
    expect(installed.isPortableApp).toBe(false);
    await mkdir(profile, { recursive: true });
    await writeTextFile(settingsPath, JSON.stringify({ migrationVersion: 99999999 }));
    const portable = new NativeAppService();
    await portable.init();
    expect(portable.isPortableApp).toBe(true);
    expect(await portable.isRootDirUsable()).toBe(true);
    expect(await exists(await join(books, 'Books'))).toBe(true);
    expect(portable.resolvePath('settings.json', 'Settings').fp.replaceAll('\\', '/')).toBe(
      settingsPath.replaceAll('\\', '/'),
    );
    await portable.setCustomRootDir(chosen);
    expect(await portable.isRootDirUsable()).toBe(true);
    expect(await exists(await join(chosen, 'Readest', 'Books'))).toBe(true);
    expect(portable.resolvePath('settings.json', 'Settings').fp.replaceAll('\\', '/')).toBe(
      settingsPath.replaceAll('\\', '/'),
    );
    expect(await readTextFile(stableSettingsPath)).toBe(stableSettings);
  } finally {
    await remove(stableSettingsPath);
    for (const path of [profile, chosen])
      if (await exists(path)) await remove(path, { recursive: true });
  }
});
