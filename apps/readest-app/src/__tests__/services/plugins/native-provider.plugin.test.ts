import { describe, expect, it } from 'vitest';
import { verifyPluginPackage } from '@/services/plugins/package';
import { installPlugin, uninstallPlugin, useInstalledPlugins } from '@/services/plugins/manager';
import { clearContentCache } from '@/services/plugins/cache';
import { saveSourceInstance } from '@/services/contentSources/instances';
import { getSourceRuntime } from '@/services/contentSources/runtime';
import {
  addSourceWork,
  getSourceBookRef,
  listSourceChapters,
  downloadSourceChapters,
  resolveSourceChapter,
  loadSourceResource,
} from '@/services/contentSources/catalog';
import { openSourceBookDoc } from '@/services/contentSources/sourceBook';

declare const __NATIVE_TEST_PACKAGES__: Record<string, string>;

describe('independent native SDK packages without compatibility engines', () => {
  for (const kind of ['text', 'comic'] as const) {
    it(`${kind} searches, saves, downloads and opens after its plugin is removed`, async () => {
      const pkg = await verifyPluginPackage(
        Uint8Array.from(atob(__NATIVE_TEST_PACKAGES__[kind]!), (char) => char.charCodeAt(0)),
      );
      expect(pkg.manifest.permissions?.wasm).not.toBe(true);
      expect(Object.keys(pkg.resources).some((path) => path.endsWith('.wasm'))).toBe(false);
      await installPlugin(pkg, true);
      try {
        expect(
          useInstalledPlugins
            .getState()
            .plugins.every((plugin) => !plugin.manifest.contributions.sourceFormats?.length),
        ).toBe(true);
        const instance = await saveSourceInstance({
          id: crypto.randomUUID(),
          pluginId: pkg.manifest.id,
          fingerprint: pkg.fingerprint,
          providerId: pkg.manifest.contributions.contentSources![0]!.id,
          name: `Native ${kind}`,
          config: kind === 'comic' ? { imageUrl: new URL('/icon.png', location.href).href } : {},
          enabled: true,
          origins: [location.origin],
          allowPrivateNetwork: true,
          secretNames: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        expect(instance.definitionId).toBeUndefined();
        const provider = await getSourceRuntime(instance.id);
        expect(pkg.manifest.pluginApi?.min).toBe(4);
        expect(pkg.manifest.contributions.managementPages).toHaveLength(1);
        const description = await provider.call('source.describe', {});
        expect(description.settings.some((field) => field.key === 'showSummary')).toBe(true);
        if (kind === 'comic')
          expect(description.settings.some((field) => field.key === 'imageUrl')).toBe(true);
        const works = await provider.call('source.search', { query: 'example' });
        expect(works.items).toHaveLength(1);
        const book = await addSourceWork(
          { saveLibraryBooks: async () => {} },
          instance.id,
          works.items[0]!,
        );
        const ref = getSourceBookRef(book)!;
        const chapters = await listSourceChapters(ref);
        expect(chapters).toHaveLength(1);
        await downloadSourceChapters(ref, [chapters[0]!.id]);
        await uninstallPlugin(pkg.manifest.id);
        await clearContentCache();
        const content = await resolveSourceChapter(ref, chapters[0]!);
        if (content.kind === 'pages') {
          const image = await loadSourceResource(ref, content.pages[0]!, chapters[0]);
          const bitmap = await createImageBitmap(image);
          expect(bitmap.width).toBeGreaterThan(0);
          bitmap.close();
        } else {
          const doc = await openSourceBookDoc(ref);
          try {
            expect((await doc.sections[0]!.createDocument()).body.textContent).toContain(
              'native Readest plugin',
            );
          } finally {
            await doc.destroy?.();
          }
        }
      } finally {
        await uninstallPlugin(pkg.manifest.id);
      }
    });
  }
});
