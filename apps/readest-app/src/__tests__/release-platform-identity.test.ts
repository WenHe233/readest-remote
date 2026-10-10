// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const identity = 'io.github.wenhe233.readestremote.v2';

describe('V2 release platform identity', () => {
  it('keeps Android installations and links separate from upstream and V1', () => {
    const gradle = read('src-tauri/gen/android/app/build.gradle.kts');
    expect(gradle).toContain(`namespace = "${identity}"`);
    expect(gradle).toContain(`applicationId = "${identity}"`);
    const manifest = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:scheme="readest-remote-v2"');
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
    expect(plist).toContain('<string>readest-remote-v2</string>');
    expect(plist).not.toContain('<string>readest</string>');
  });
});
