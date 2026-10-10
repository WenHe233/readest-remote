import { expect, it } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { exists, writeTextFile, remove } from '@tauri-apps/plugin-fs';
import { NativeAppService } from '@/services/nativeAppService';

it('uses the V1 portable layout and keeps settings beside the executable after changing the book root', async () => {
  const exe = await invoke<string>('get_executable_dir');
  const settingsPath = await join(exe, 'settings.json');
  const books = await join(exe, 'Readest');
  const chosen = await join(exe, 'portable-test-' + crypto.randomUUID());
  const workspace = process.env['CWD']!.replace(/[\\/]apps[\\/]readest-app$/, '');
  for (const path of [settingsPath, books, chosen]) {
    expect(
      path
        .replaceAll('\\', '/')
        .toLowerCase()
        .startsWith(workspace.replaceAll('\\', '/').toLowerCase() + '/'),
    ).toBe(true);
    expect(await exists(path)).toBe(false);
  }
  await writeTextFile(settingsPath, JSON.stringify({ migrationVersion: 99999999 }));
  try {
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
  } finally {
    await remove(settingsPath);
    for (const path of [books, chosen])
      if (await exists(path)) await remove(path, { recursive: true });
  }
});
