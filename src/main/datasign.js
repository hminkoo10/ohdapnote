'use strict';

// 설정 파일 서명 - 구현민 개발
// 통합 클라우드가 서명 키(MAGOEDU_DATA_KEY, 매니페스트 "dataSigning": true)를 주면 앱이 쓰는 settings.json 에 서명("sig")을 넣고,
// 서명이 없거나 맞지 않는 파일(앱 밖에서 손으로 고친 것)은 적용하지 않는다. 키가 없으면(예전 통합 클라우드) 예전처럼 서명 없이 읽고 씀.
// 마고 타종(Python·Kotlin)과 같은 방식이라 JSON 을 다시 정리하지 않고 파일 글자 그대로 서명한다:
//   서명: "sig" 를 0 64개로 넣어 평소처럼 직렬화 → UTF-8 → HMAC-SHA256(키 = MAGOEDU_DATA_KEY 의 UTF-8) 16진수로 0 자리를 바꿈
//   확인: 파일 바이트 그대로 UTF-8 로 읽어 "sig": "<16진수 64자>" 가 꼭 하나 → 그 자리를 0 으로 바꿔 HMAC 을 다시 구해 비교
// 키는 파일·로그·화면에 남기지 않는다.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { invalidJson } = require('./data-validate');

const SIG_ZERO = '0'.repeat(64);
const SIG_RE = /"sig"\s*:\s*"([0-9a-f]{64})"/g;

const hmac = (text, key) => crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(text, 'utf8')).digest();

/** 글자 안의 서명 자리(16진수 64자가 시작하는 곳). 없거나 여러 개면 -1 */
function sigAt(text) {
  const found = [...text.matchAll(SIG_RE)];
  return found.length === 1 ? found[0].index + found[0][0].length - 65 : -1;
}

/** 서명 자리가 0 으로 채워진 글자 → 서명한 글자 (길이 같음) */
function signText(text, key) {
  const at = sigAt(text);
  if (at < 0 || text.slice(at, at + 64) !== SIG_ZERO) throw new Error('서명할 자리가 없어요.');
  return text.slice(0, at) + hmac(text, key).toString('hex') + text.slice(at + 64);
}

/** 값 → 서명한 JSON 글자 (평소처럼 JSON.stringify) */
const signJson = (value, key) => signText(JSON.stringify({ ...value, sig: SIG_ZERO }), key);

/** 파일 바이트 그대로 서명이 맞는지 */
function verify(bytes, key) {
  const text = Buffer.from(bytes).toString('utf8');
  const at = sigAt(text);
  if (at < 0) return false;
  const want = hmac(text.slice(0, at) + SIG_ZERO + text.slice(at + 64), key);
  return crypto.timingSafeEqual(want, Buffer.from(text.slice(at, at + 64), 'hex'));
}

function parse(bytes) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** 값에서 서명은 뺌 (설정으로 쓰지 않게) */
function plain(v) {
  if (!isObj(v) || !('sig' in v)) return v;
  const { sig: _sig, ...rest } = v;
  return rest;
}

function writeAtomic(file, text, markOwn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  markOwn?.(file);
  fs.renameSync(tmp, file);
}

/**
 * 서명하는 JSON 파일 하나 (내 설정 settings.json) → { read(), write(값) }
 *   file       동기화되는 파일
 *   stateFile  이 컴퓨터에만 두는 파일: 마지막으로 서명을 확인한 내용 (서명해서 그대로). 있으면 '서명을 쓰기 시작한 컴퓨터'
 *   key        MAGOEDU_DATA_KEY. 비어 있으면 서명하지 않고 예전처럼 읽고 씀
 *   markOwn    내가 쓴 파일 (지켜보기에서 건너뜀),  onRejected()  앱 밖에서 고친 파일을 적용하지 않았을 때
 * read(): 서명이 맞으면 그 값. 아니면 적용하지 않고 마지막으로 확인한 값을 다시 서명해 써서 되돌림.
 *   서명을 쓰기 전(이 컴퓨터에 stateFile 이 없음)에는 예전 버전이 쓴 서명 없는 파일을 한 번 받아들이고 서명해 둠.
 *   이 컴퓨터에 확인한 값이 없으면 서버의 파일을 덮어쓰지 않고 기본값({}).
 */
function signedJsonFile({ file, stateFile, key, markOwn, log = console, onRejected = () => {} }) {
  let good = null; // 마지막으로 서명을 확인한 값
  let saved = null; // stateFile 에 쓴 바이트

  const readBytes = (name) => {
    if (fs.statSync(name).size > 1024 * 1024) {
      invalidJson(name, log);
      return Buffer.alloc(0);
    }
    return fs.readFileSync(name);
  };

  const saveState = (bytes) => {
    if (saved?.equals(bytes)) return;
    try {
      writeAtomic(stateFile, bytes.toString('utf8'));
      saved = bytes;
    } catch (err) {
      log.warn('[settings] 이 컴퓨터에 확인한 설정을 남기지 못함', err.message);
    }
  };
  /** 이 컴퓨터에 남겨 둔, 서명이 맞는 값 (없으면 null) */
  const known = () => {
    if (good) return good;
    try {
      const bytes = readBytes(stateFile);
      const v = parse(bytes);
      return isObj(v) && verify(bytes, key) ? plain(v) : null;
    } catch {
      return null;
    }
  };

  function write(value) {
    const v = plain(value);
    if (!key) return writeAtomic(file, JSON.stringify(v), markOwn);
    const text = signJson(v, key);
    writeAtomic(file, text, markOwn);
    saveState(Buffer.from(text, 'utf8'));
    good = v;
  }

  function read() {
    let bytes;
    try {
      bytes = readBytes(file);
    } catch {
      return {}; // 아직 없음 → 기본값 (예전과 같음)
    }
    const value = parse(bytes);
    if (!key) {
      if (value === undefined) invalidJson(file, log);
      return value === undefined ? {} : plain(value);
    }
    if (isObj(value) && verify(bytes, key)) {
      good = plain(value);
      saveState(bytes);
      return good;
    }
    const last = known();
    if (!last && !fs.existsSync(stateFile) && isObj(value) && !('sig' in value)) {
      // 서명을 쓰기 전 버전이 쓴 파일: 이번 한 번 받아들이고 서명해서 다시 씀 (이 뒤로는 서명 없는 파일은 받지 않음)
      log.info('[settings] 서명 없는 예전 설정을 받아들이고 서명해 둠');
      try {
        write(value);
      } catch (err) {
        log.error('[settings] 서명해 두지 못함', err.message);
      }
      return plain(value);
    }
    const why = !isObj(value) ? 'JSON 이 아님' : 'sig' in value ? '서명이 맞지 않음' : '서명 없음';
    log.warn(`[settings] 앱 밖에서 바꾼 설정이라 적용하지 않음 (${why})${last ? ' → 되돌림' : ''}`);
    onRejected();
    if (!last) return {}; // 이 컴퓨터에 확인한 설정이 없음 → 서버의 파일은 그대로 두고 기본값
    try {
      write(last); // 되돌림 (동기화로 다른 컴퓨터에도)
    } catch (err) {
      log.error('[settings] 되돌리지 못함', err.message);
    }
    return last;
  }

  return { read, write };
}

module.exports = { signJson, signText, verify, signedJsonFile, SIG_ZERO };
