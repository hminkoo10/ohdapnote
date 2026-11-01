// 테스트용 정적 파일 서버 (저장소 루트를 제공)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gz': 'application/gzip',
};

/** @param {Record<string,string>} [extra] 저장소 밖 파일 (URL 경로 → 실제 경로) */
export function startServer(port = 0, extra = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const file = extra[url.pathname] || resolve(join(ROOT, decodeURIComponent(url.pathname)));
      if (!extra[url.pathname] && !file.startsWith(ROOT)) throw new Error('bad path');
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
