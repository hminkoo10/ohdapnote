'use strict';

const path = require('node:path');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_KEY_RE = /^[^<>\u0000-\u001f\u007f]{1,256}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 200) => (typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<\s*[!/]|<\s*\/?[a-z][^>]*>/i.test(v) ? v : undefined);
const line = (v, max = 200) => (text(v, max) !== undefined && !/[\r\n\t]/.test(v) ? v : undefined);
const key = (v, max = 256) => (typeof v === 'string' && !FORBIDDEN_KEYS.has(v) && v.length <= max && SAFE_KEY_RE.test(v) ? v : undefined);
const model = (v) => (typeof v === 'string' && v.length <= 200 && (!v || /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v)) && !v.split('/').includes('..') ? v : undefined);
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const reported = new Set();
function invalidJson(file, log = console) {
  if (reported.has(file)) return;
  if (reported.size >= 256) reported.clear();
  reported.add(file);
  log.info(`[data] 잘못된 값 무시 (${path.basename(file)})`);
}
function cleanJson(value, sanitize, file, log = console) {
  const clean = sanitize(value);
  if (!isDeepStrictEqual(value, clean)) invalidJson(file, log);
  return clean;
}

// 공유 데이터는 새 버전의 필드도 보존. 배열 원소와 값은 건드리지 않음.
function sanitizeData(value) {
  if (!isObj(value)) return null;
  const out = {};
  const pending = [[value, out]];
  while (pending.length) {
    const [source, target] = pending.pop();
    for (const [k, v] of Object.entries(source)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if (v && typeof v === 'object') {
        target[k] = Array.isArray(v) ? new Array(v.length) : {};
        pending.push([v, target[k]]);
      } else target[k] = v;
    }
  }
  return out;
}

function url(v) {
  if (v === '') return '';
  if (typeof v !== 'string' || v.length > 2048 || /[\s<>\u0000-\u001f\u007f]/.test(v)) return undefined;
  try {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && u.hostname && !u.username && !u.password ? v : undefined;
  } catch {
    return undefined;
  }
}

function codexPath(v) {
  if (v === '') return '';
  if (typeof v !== 'string' || v.length < 1 || v.length > 1024 || /[<>"%|?*\u0000-\u001f\u007f]/.test(v) || /(^|[\\/])\.\.?([\\/]|$)/.test(v)) return undefined;
  const name = v.replaceAll('\\', '/').split('/').pop();
  if (!/^codex(?:\.(?:exe|cmd|bat))?$/i.test(name) || !path.isAbsolute(v) || /^[\\/]{2}/.test(v) || /:(?![\\/])/.test(v)) return undefined;
  const roots = [
    ...(process.env.PATH || '').split(path.delimiter).filter((root) => path.isAbsolute(root)),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
    path.join(os.homedir(), '.local', 'bin'),
  ]
    .filter(Boolean)
    .map((root) => path.resolve(root));
  const resolved = path.resolve(v);
  return roots.some((root) => path.dirname(resolved).toLowerCase() === root.toLowerCase() || (root.toLowerCase().endsWith(path.join('OpenAI', 'Codex', 'bin').toLowerCase()) && resolved.toLowerCase().startsWith(`${root}${path.sep}`.toLowerCase()))) ? v : undefined;
}

function relativePath(v) {
  if (typeof v !== 'string' || !v || v.length > 512 || v.startsWith('/') || /[<>:"|?*\u0000-\u001f\u007f]/.test(v)) return undefined;
  const parts = v.replaceAll('\\', '/').split('/');
  return parts.some((p) => !p || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) ? undefined : parts.join('/');
}

module.exports = { isObj, text, line, key, model, int, url, codexPath, sanitizeData, relativePath, invalidJson, cleanJson };
