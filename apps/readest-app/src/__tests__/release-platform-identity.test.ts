// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const identity = 'io.github.wenhe233.readestremote.experimental';

describe('Readest Remote Experimental release platform identity', () => {
  it('uses a separate Android identity and protocol for side-by-side installation', () => {
    const gradle = read('src-tauri/gen/android/app/build.gradle.kts');
    expect(gradle).toContain(`namespace = "${identity}"`);
    expect(gradle).toContain(`applicationId = "${identity}"`);
    const manifest = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:scheme="readest-remote-x"');
    expect(gradle).toContain('versionCode = 12012101');
    expect(gradle).toContain('versionName = "0.12.12-x1"');
    expect(manifest).not.toContain('android:scheme="readest"');
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
