import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const vendor=resolve(root,'packages/foliate-js');
const patch=resolve(root,'patches/foliate-js-pdf-streaming.patch');
if(!existsSync(resolve(vendor,'pdf.js'))) {
  console.info('Initialize pinned foliate-js, then run node scripts/apply-vendor-patches.mjs.');
} else {
  try { execFileSync('git',['apply','--reverse','--check',patch],{cwd:vendor,stdio:'ignore'}); }
  catch { execFileSync('git',['apply','--check',patch],{cwd:vendor,stdio:'pipe'});execFileSync('git',['apply',patch],{cwd:vendor,stdio:'inherit'}); }
}
