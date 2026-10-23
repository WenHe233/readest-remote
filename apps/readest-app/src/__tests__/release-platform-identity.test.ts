// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const identity = 'io.github.wenhe233.readestremote.experimental';
const version = (JSON.parse(read('package.json')) as { version: string }).version;
const buildNumber = Number(
  (JSON.parse(read('src-tauri/tauri.conf.json')) as { bundle: { iOS: { bundleVersion: string } } })
    .bundle.iOS.bundleVersion,
);

describe('Readest Remote X release platform identity', () => {
  it('keeps installed document class identities while changing the application display name', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      bundle: { fileAssociations: { name: string; ext: string[] }[] };
    };
    // NSIS uses association.name as FILECLASS/ProgID, including its uninstall backup key.
    // Renaming it leaves the old class behind and restores that obsolete class on uninstall.
    expect(config.bundle.fileAssociations.map((association) => association.name)).toEqual([
      'Readest Remote Experimental EPUB Document',
      'Readest Remote Experimental MOBI Document',
      'Readest Remote Experimental AZW Document',
      'Readest Remote Experimental AZW3 Document',
      'Readest Remote Experimental FB2 Document',
      'Readest Remote Experimental CBZ Archive',
      'Readest Remote Experimental PDF Document',
      'Readest Remote Experimental Text File',
      'Readest Remote Experimental Markdown Document',
      'Readest Plugin',
      'Readest Plugin Repository',
    ]);
  });

  it('uses the display name in native launchers, extensions, windows and Web installation', () => {
    const name = 'Readest Remote X';
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as { productName: string };
    expect(config.productName).toBe(name);
    const android = read('src-tauri/gen/android/app/src/main/res/values/strings.xml');
    expect(android).toContain(`<string name="app_name">"${name}"</string>`);
    expect(android).toContain(`<string name="main_activity_title">"${name}"</string>`);
    const apple = read('src-tauri/gen/apple/project.yml');
    expect(apple).toContain(`PRODUCT_NAME: ${name}`);
    expect(apple.match(/CFBundleDisplayName: Readest Remote X/g)).toHaveLength(2);
    expect(read('src-tauri/gen/apple/Readest.xcodeproj/project.pbxproj')).toContain(
      `PRODUCT_NAME = "${name}"`,
    );
    expect(read('src-tauri/gen/apple/ShareExtension/Info.plist')).toContain(
      `<string>${name}</string>`,
    );
    expect(read('src-tauri/gen/apple/ReadestWidget/ReadestWidgetBundle.swift')).toContain(
      `.configurationDisplayName("${name}")`,
    );
    expect(read('src-tauri/src/lib.rs').match(/\.title\("Readest Remote X"\)/g)).toHaveLength(2);
    const manifest = JSON.parse(read('public/manifest.json')) as {
      name: string;
      short_name: string;
    };
    expect(manifest.name).toBe(name);
    expect(manifest.short_name).toBe(name);
    expect(read('src/app/layout.tsx')).toContain(`const title = '${name}'`);
  });

  it('uses a separate Android identity and protocol for side-by-side installation', () => {
    const gradle = read('src-tauri/gen/android/app/build.gradle.kts');
    expect(gradle).toContain(`namespace = "${identity}"`);
    expect(gradle).toContain(`applicationId = "${identity}"`);
    const manifest = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:scheme="readest-remote-x"');
    expect(buildNumber).toBeGreaterThan(12012102);
    expect(gradle).toContain(`versionCode = ${buildNumber}`);
    expect(gradle).toContain(`versionName = "${version}"`);
    expect(manifest).not.toContain('android:scheme="readest"');
  });

  it('keeps the new internal build number aligned across Apple app and extension targets', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      bundle: { macOS: { bundleVersion: string } };
    };
    expect(Number(config.bundle.macOS.bundleVersion)).toBe(buildNumber);
    const project = read('src-tauri/gen/apple/project.yml');
    expect(project.match(/CFBundleVersion: "(\d+)"/g)).toEqual([
      `CFBundleVersion: "${buildNumber}"`,
      `CFBundleVersion: "${buildNumber}"`,
    ]);
    expect(read('src-tauri/gen/apple/ShareExtension/Info.plist')).toMatch(
      new RegExp(`<key>CFBundleVersion</key>\\s*<string>${buildNumber}</string>`),
    );
  });

  it('uses the same independent Apple app group in all participating targets', () => {
    const project = read('src-tauri/gen/apple/project.yml');
    expect(project).toContain(`PRODUCT_BUNDLE_IDENTIFIER: ${identity}`);
    expect(project).not.toContain('DEVELOPMENT_TEAM: J5W48D69VR');
    for (const path of [
      'gen/apple/Readest_iOS/Readest_iOS.entitlements',
      'gen/apple/ReadestWidget/ReadestWidget.entitlements',
      'gen/apple/ShareExtension/ShareExtension.entitlements',
      'plugins/tauri-plugin-native-bridge/ios/Sources/AppGroupBridge.swift',
      'plugins/tauri-plugin-native-bridge/ios/Sources/ReadingWidgetWriter.swift',
    ]) {
      const text = read(`src-tauri/${path}`);
      expect(text).toContain(`group.${identity}`);
      expect(text).not.toContain('group.com.bilingify.readest');
    }
    const plist = read('src-tauri/Info-ios.plist');
    expect(plist).toContain('<string>readest-remote-x</string>');
    expect(plist).not.toContain('<string>readest</string>');
  });
});
