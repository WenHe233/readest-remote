import { expect, it } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { exists, mkdir, writeTextFile, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { NativeAppService } from '@/services/nativeAppService';

it('isolates portable V2 settings and books from a neighboring V1 settings file', async () => {
  const exe = await invoke<string>('get_executable_dir');
  const root = await join(exe, 'ReadestRemoteV2');
  const legacy = await join(exe, 'settings.json');
  const workspace = process.env['CWD']!.replace(/[\\/]apps[\\/]readest-app$/, '');
  const normalized = root.replaceAll('\\', '/').toLowerCase();
  expect(normalized.startsWith(workspace.replaceAll('\\', '/').toLowerCase() + '/')).toBe(true);
  // Only create and remove a fresh, test-owned directory inside the checkout.
  expect(await exists(root)).toBe(false);
  expect(await exists(legacy)).toBe(false);
  const legacyText = JSON.stringify({ customRootDir: await join(root, 'v1-must-not-be-adopted') });
  await writeTextFile(legacy, legacyText);
  try {
    const standard = new NativeAppService();
    await standard.init();
    expect(standard.isPortableApp).toBe(false);
    await mkdir(root, { recursive: true });
    await writeTextFile(
      await join(root, 'settings.json'),
      JSON.stringify({ migrationVersion: 99999999 }),
    );
    const portable = new NativeAppService();
    await portable.init();
    expect(portable.isPortableApp).toBe(true);
    expect(await portable.isRootDirUsable()).toBe(true);
    expect(await exists(await join(root, 'Readest', 'Books'))).toBe(true);
    const settingsPath = portable.resolvePath('settings.json', 'Settings').fp.replaceAll('\\', '/');
    expect(settingsPath).toBe(root.replaceAll('\\', '/') + '/settings.json');
    await portable.setCustomRootDir(await join(root, 'chosen-library'));
    expect(await portable.isRootDirUsable()).toBe(true);
    expect(await exists(await join(root, 'chosen-library', 'Readest', 'Books'))).toBe(true);
    expect(portable.resolvePath('settings.json', 'Settings').fp.replaceAll('\\', '/')).toBe(
      settingsPath,
    );
    expect(await readTextFile(legacy)).toBe(legacyText);
  } finally {
    await remove(legacy);
    if (await exists(root)) await remove(root, { recursive: true });
  }
});
