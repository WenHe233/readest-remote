import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderExperimentalInstaller } from '../prepare-experimental-installer.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const config = JSON.parse(read('apps/readest-app/src-tauri/tauri.conf.json'));
const template = read('packages/tauri/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi');
const oldUninstall = '!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCTNAME}"';
const oldProduct = '!define MANUPRODUCTKEY "${MANUKEY}\\${PRODUCTNAME}"';

test('renaming preserves the only experimental uninstall record and install path lookup', () => {
  const result = renderExperimentalInstaller(template, config);
  const expected = template
    .replace(oldUninstall, oldUninstall.replace('${PRODUCTNAME}', 'Readest Remote Experimental'))
    .replace(oldProduct, oldProduct.replace('${PRODUCTNAME}', 'Readest Remote Experimental'));
  assert.equal(result, expected);
  assert.match(result, /Name "\$\{PRODUCTNAME\}"/);
  assert.match(result, /WriteRegStr SHCTX "\$\{UNINSTKEY\}" "DisplayName" "\$\{PRODUCTNAME\}"/);
  assert.equal(config.productName, 'Readest Remote X');
  // Clean installs keep the current product folder; upgrades restore the old registry location.
  assert.match(result, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/);
  assert.match(result, /Call RestorePreviousInstallLocation/);
  assert.match(result, /Function RestorePreviousInstallLocation[\s\S]*ReadRegStr \$4 SHCTX "\$\{MANUPRODUCTKEY\}" ""[\s\S]*StrCpy \$INSTDIR \$4/);
});

test('refuses stable identities, unexpected product names and changed upstream templates', () => {
  for (const patch of [
    { identifier: 'io.github.wenhe233.readestremote' },
    { productName: 'Readest Remote' },
    { mainBinaryName: 'readest-remote' },
  ]) assert.throws(() => renderExperimentalInstaller(template, { ...config, ...patch }), /experimental identity/);
  for (const declaration of [oldUninstall, oldProduct]) {
    assert.throws(() => renderExperimentalInstaller(template.replace(declaration, ''), config), /exactly once/);
    assert.throws(() => renderExperimentalInstaller(`${template}\n${declaration}`, config), /exactly once/);
  }
});

test('installation hooks only rename shortcuts with a verified experimental executable target', () => {
  const hooks = read('apps/readest-app/src-tauri/nsis/experimental-installer-hooks.nsh');
  assert.match(hooks, /IsShortcutTarget "\$\{OLD\}" "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/);
  assert.match(hooks, /IsShortcutTarget "\$\{NEW\}" "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/);
  assert.match(hooks, /Rename "\$\{OLD\}" "\$\{NEW\}"/);
  assert.match(hooks, /Readest Remote Experimental\.lnk/);
  assert.doesNotMatch(hooks, /DeleteReg|RMDir|ExecWait|REGISTER_SHELLEX|CLSID_READEST_THUMBNAIL/);
});

test('normal install and native build generate the pinned custom template', () => {
  assert.equal(config.bundle.windows.nsis.template, 'nsis/generated/experimental-installer.nsi');
  assert.equal(config.bundle.windows.nsis.installerHooks, 'nsis/experimental-installer-hooks.nsh');
  assert.match(config.build.beforeBuildCommand, /prepare-experimental-installer\.mjs/);
  assert.match(JSON.parse(read('package.json')).scripts.prepare, /prepare-experimental-installer\.mjs/);
});
