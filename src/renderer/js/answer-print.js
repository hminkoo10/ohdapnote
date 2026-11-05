import { eqToMathML } from './hwpeqview.js';

// 숨은 인쇄 창 전용. 메인에서 검사한 블록과 data URL만 받아 글자·MathML로 그린다.
window.renderAnswer = async ({ blocks, images, widthPt }) => {
  document.body.style.width = `${widthPt * 4 / 3}px`;
  const root = document.querySelector('main');
  const math = (eq, display = false) => {
    const node = document.createElement(display ? 'div' : 'span');
    if (display) node.className = 'math';
    node.innerHTML = eqToMathML(eq, { display });
    return node;
  };
  for (const b of blocks) {
    if (b.type === 'math') root.append(math(b.eq, true));
    else if (b.type === 'figure') {
      const figure = document.createElement('figure');
      const img = document.createElement('img');
      img.src = images[b.file]; img.width = Math.min(b.w, widthPt * 4 / 3 - 4);
      figure.append(img); root.append(figure);
    } else {
      const p = document.createElement('p');
      for (const r of b.runs || [{ text: b.text }]) p.append(r.eq !== undefined ? math(r.eq) : document.createTextNode(r.text));
      if (!p.childNodes.length) p.append(document.createElement('br'));
      root.append(p);
    }
  }
  await document.fonts.ready;
  await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode()));
  return Math.ceil(root.getBoundingClientRect().height * 0.75 + 2);
};
