// 설치 HancomEQN/HYHWPEQ cmap + 코드별 렌더 대조(2026-11-09).
// scripts/inspect-hancom.py 참고. 글꼴/윤곽 미포함. 확인 안 된 조각은 추측하지 않는다.
export const isHancomMath = (name) => /^(?:[A-Z]{6}\+)?(?:HancomEQN|HyhwpEQ)(?:[-,]|$)/i.test(name || '');
export const isPrivateChar = (c) => /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(c);
const map = {};
const range = (start, text) => [...text].forEach((c, i) => { map[String.fromCodePoint(start + i)] = c; });
range(0xe000, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
range(0xe01a, 'abcdefghijklmnopqrstuvwxyz');
range(0xe034, '1234567890');
range(0xe03e, '!@#$%*()−=+[]{}|,:');
Object.assign(map, { '\ue054': '/', '\ue055': '<', '\ue056': '>', '\ue058': '←', '\ue05a': '→', '\ue05b': '∫', '\ue05c': '√', '\ue067': '∑', '\ue068': 'Π', '\ue069': '∏', '\ue06a': '∩', '\ue06b': '∪', '\ue06f': '⇐', '\ue070': '=', '\ue071': '⇒', '\ue072': '∫' });
range(0xe085, 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ');
range(0xe09d, 'αβγδεζηθικλμνξοπρστυφχψω');
export const HANCOM_PUA = Object.freeze(map);

/** 일반 글에도 섞이는 한컴 숫자. font를 주면 다른 글꼴 PUA는 건드리지 않는다. */
export function normalizeHancomText(text, font) {
  const enabled = font === undefined || isHancomMath(font);
  return [...String(text || '')].map((c) => enabled ? (HANCOM_PUA[c] ?? c) : c).join('');
}
