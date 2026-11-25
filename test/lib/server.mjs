// 테스트용 정적 파일 서버 (저장소 루트를 제공)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { modelStatus, createNumberDetector } = createRequire(import.meta.url)('../../src/main/numberdet.js');

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gz': 'application/gzip',
};

/** @param {Record<string,string>} [extra] 저장소 밖 파일 (URL 경로 → 실제 경로) */
export function startServer(port = 0, extra = {}) {
  const modelDir = process.env.OHDAP_PND_DIR;
  let detector;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (modelDir && url.pathname.startsWith('/__pnd/')) {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && url.pathname === '/__pnd/status') {
          res.end(JSON.stringify({ installed: modelStatus(modelDir).installed }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/__pnd/detect') {
          const width = Number(url.searchParams.get('width')), height = Number(url.searchParams.get('height'));
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 1024) {
            res.writeHead(400); res.end('{}'); return;
          }
          let length = 0;
          const chunks = [];
          for await (const chunk of req) {
            length += chunk.length;
            if (length > width * height * 4) { res.writeHead(400); res.end('{}'); return; }
            chunks.push(chunk);
          }
          try {
            detector ||= createNumberDetector({ modelDir, threads: 2 });
            const boxes = await detector.detect({ data: Buffer.concat(chunks), width, height });
            res.end(JSON.stringify(boxes));
          } catch {
            res.writeHead(500); res.end('{}');
          }
          return;
        }
        res.writeHead(404); res.end('{}'); return;
      }
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
  server.on('close', () => { detector?.close().catch(() => {}); });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
