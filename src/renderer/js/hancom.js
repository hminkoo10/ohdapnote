// 설치 HancomEQN/HYHWPEQ cmap + 코드별 렌더 대조(2026-11-09).
// scripts/inspect-hancom.py 참고. 글꼴/윤곽 미포함. 확인 안 된 조각은 추측하지 않는다.
import { HANCOM_PUA } from './hancom-map.js';
export { HANCOM_PUA } from './hancom-map.js';
export const isHancomMath = (name) => /^(?:[A-Z]{6}\+)?(?:HancomEQN|HyhwpEQ)(?:[-,]|$)/i.test(name || '');
export const isPrivateChar = (c) => /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(c);

/** 일반 글에도 섞이는 한컴 숫자. font를 주면 다른 글꼴 PUA는 건드리지 않는다. */
export function normalizeHancomText(text, font) {
  const enabled = font === undefined || /^g_d\d+_f\d+$/.test(font || '') || isHancomMath(font);
  return [...String(text || '')].map((c) => enabled ? (HANCOM_PUA[c] ?? c) : c).join('');
}

/** TextContent 내부 키 대신 실제 글꼴명 조회. fontExtraProperties:true 필요. */
export function resolvePdfFontName(page, fontName) {
  try { return page.commonObjs.get(fontName)?.name || undefined; }
  catch { return undefined; }
}
