import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function renderExperimentalInstaller(template, config) {
  if (config.identifier !== 'io.github.wenhe233.readestremote.experimental'
      || config.productName !== 'Readest Remote X' || config.mainBinaryName !== 'readest-remote-x') {
    throw new Error('The installer name override requires the exact experimental identity');
  }
  // NSIS normally uses the visible product name as its installation identity.
  // Keep the existing keys so its own upgrade UI and path lookup find x1/x2 installations.
  for (const declaration of [
    '!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCTNAME}"',
    '!define MANUPRODUCTKEY "${MANUKEY}\\${PRODUCTNAME}"',
  ]) {
    if (template.split(declaration).length !== 2) {
      throw new Error(`Expected the pinned NSIS declaration exactly once: ${declaration}`);
    }
    template = template.replace(declaration, declaration.replace('${PRODUCTNAME}', 'Readest Remote Experimental'));
  }
  return template;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = JSON.parse(readFileSync(resolve(root, 'apps/readest-app/src-tauri/tauri.conf.json'), 'utf8'));
  const template = readFileSync(resolve(root, 'packages/tauri/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi'), 'utf8');
  const output = resolve(root, 'apps/readest-app/src-tauri/nsis/generated/experimental-installer.nsi');
  const rendered = renderExperimentalInstaller(template, config);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rendered);
  console.log('Prepared the experimental Windows installer with its existing upgrade identity.');
}
