import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(app, '../../packages/foliate-js/package.json'));
const input = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
let source = await readFile(input, 'utf8');
const check = 'await this.ensureDoc("checkLastPage", [recoveryMode]);';
if (source.split(check).length !== 2) throw new Error('Review the PDF.js streaming patch for this dependency version');
// PDF.js validates the last page eagerly, which walks every page dictionary in
// a flat scanned-PDF page tree. That reads an entire remote file even with
// disableAutoFetch. A range-only reader validates each page when requested.
// Local/full-file readers retain the upstream last-page validation.
source = source.replace(check, 'if (!this.streamManager?.disableAutoFetch) { '+check+' }');
const output = await transform(source, {minify:true,format:'esm',target:'es2022',legalComments:'inline'});
const directory = resolve(app, 'public/vendor/pdfjs');
await mkdir(directory, {recursive:true});
await writeFile(resolve(directory,'pdf.worker.min.mjs'), output.code);
console.info('Built PDF worker with lazy remote page-tree validation.');
