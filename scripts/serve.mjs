import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
// COOP/COEP headers enable crossOriginIsolated, which lets onnxruntime-web
// use SharedArrayBuffer + multi-threaded WASM. Without it Piper inference
// falls back to single-thread and times out on real-length sentences.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin'
};
http.createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
    if (relative.split('/').some(p => p.startsWith('.'))) throw Error('Forbidden');
    let file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) throw Error('Forbidden');
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.data': 'application/octet-stream' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...ISOLATION_HEADERS });
    res.end(await readFile(file));
  } catch { res.writeHead(404, ISOLATION_HEADERS); res.end('Not found'); }
}).listen(4179, '127.0.0.1', () => console.log('Course Reader local server: http://127.0.0.1:4179'));
