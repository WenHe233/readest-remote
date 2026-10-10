import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const args = process.argv.slice(2);
const root = await realpath(resolve(args[0] || '.v2-artifacts/repository'));
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 4781);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405); response.end(); return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = await realpath(resolve(root, '.' + pathname));
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new Error('Not found');
    const data = await readFile(file);
    response.setHeader('Content-Type', extname(file) === '.json' ? 'application/json' : 'application/octet-stream');
    response.setHeader('Content-Length', data.length);
    response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(404); response.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.info(`Plugin repository: http://127.0.0.1:${port}/repo.json`));
