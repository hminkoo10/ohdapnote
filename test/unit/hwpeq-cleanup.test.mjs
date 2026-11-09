import {test} from 'node:test';
import assert from 'node:assert/strict';
import {convertLatex} from '../../src/renderer/js/hwpeq.js';
test('dev single-atom font variants preserve script and geometry',()=>{
 for(const latex of ['x','P','1'])for(const font of ['mathit','mathbf','mathsf','mathtt']){
  assert.deepEqual(convertLatex(`\\${font}{${latex}}`),convertLatex(latex));
 }
});
test('legacy switches do not insert literal command letters',()=>{
 for(const font of ['rm','it','bf','sf','tt']){
  assert.deepEqual(convertLatex(`\\${font} x`),convertLatex('x'));
 }
});
test('font-wrapped sums retain superscript scope',()=>{
 assert.equal(convertLatex('\\mathbf{x+1}^2').script,'{x+1}^{2}');
});
test('supported symbol commands emit glyphs, not command-name letters',()=>{
 const symbols={triangleleft:'\u25c3',sharp:'\u266f',dashv:'\u22a3',imath:'\u0131',copyright:'\u00a9',sqsubset:'\u228f',frown:'\u2322'};
 for(const [name,glyph] of Object.entries(symbols))assert.equal(convertLatex('\\'+name).script,glyph);
 assert.equal(convertLatex('x^{\\triangleleft}').script,'x^{\u25c3}');
});
test('font wrappers preserve content without command letters',()=>{
 for(const font of ['textsc','textsl','textmd','mathnormal']){
  assert.equal(convertLatex(`\\${font}{c}`).script,'c');
  assert.equal(convertLatex(`\\${font}{}`).script,'{}');
 }
 assert.equal(convertLatex('x^2\\mathrm{{+}}y^2').script,'x^{2}{+}y^{2}');
});
test('unsupported brace decoration preserves body and exponent scope',()=>{
 for(const name of ['overbrace','underbrace']){
  const r=convertLatex(`\\${name}{x+y}^{n}`);
  assert.equal(r.script,'{x+y}^{n}');
  assert.deepEqual(r.lossyCommands,[name]);
 }
});
test('labelled arrows use existing native arrow and script primitives',()=>{
 assert.equal(convertLatex('\\xleftarrow[b]{a}').script,'<- _{b} ^{a}');
 assert.equal(convertLatex('\\xrightarrow{a}').script,'-> ^{a}');
 assert.equal(convertLatex('\\xleftarrow{\\circ}').script,'<- ^{circ}');
});
test('unknown commands discard only name, never arguments or next atoms',()=>{
 const r=convertLatex('x+\\foo{a+b}');
 assert.equal(r.script,'x+{a+b}');assert.deepEqual(r.lossyCommands,['foo']);
 assert.equal(convertLatex('\\foo x+1').script,'x+1');
 assert.equal(convertLatex('\\foo[2]{x}').script,'[2]{x}');
});
test('unknown command scripts cannot bind to a preceding valid atom',()=>{
 assert.equal(convertLatex('x\\foo^2').script,'x{}^{2}');
 assert.equal(convertLatex('\\foo').script,'');
 assert.deepEqual(convertLatex('\\foo').lossyCommands,['foo']);
});
test('drawing settings drop metadata but retain adjacent mathematical content',()=>{
 for(const dim of ['{1cm}','1em'])assert.equal(convertLatex(`\\setlength{\\unitlength}${dim}x+1`).script,'x+1');
 assert.equal(convertLatex('\\unitlength.45em\\llap{-}').script,'{-}');
 assert.equal(convertLatex('\\unitlength 2x+1').script,'2x+1');
 assert.equal(convertLatex('\\put(2,3){x}').script,'(2,3){x}');
 assert.equal(convertLatex('\\line(1,0){4}').script,'(1,0){4}');
 for(const name of ['llap','rlap','clap'])assert.equal(convertLatex('\\'+name+'{x+y}').script,'{x+y}');
});
test('fallback geometry is finite even for empty and orphan scripts',()=>{
 for(const s of ['\\foo','x\\foo^2','\\overbrace{}^n','\\foo{\\frac12}']){
  const r=convertLatex(s);for(const k of ['width','height','baseLine'])assert.ok(Number.isFinite(r[k]));
  assert.ok(r.width>0 && r.height>0 && r.baseLine>=0 && r.baseLine<=100);
 }
});


// 글자로 읽어야 하는 한 글자 OCR 명령은 첨자와 인접 항까지 보존합니다.
test('OCR letter command preserves letter, scripts and geometry',()=>{
 for(const suffix of ['', '_2', '^3', '+x', '{a+b}']){
  assert.deepEqual(convertLatex('\\l'+suffix),convertLatex('l'+suffix));
 }
 assert.equal(convertLatex('x+\\l_2').script,'x+l_{2}');
 // 근거 없는 명령 전체를 글자로 바꾸거나 설정 잡음을 되살리지 않습니다.
 assert.equal(convertLatex('\\foo').script,'');
 assert.equal(convertLatex('\\setlength{\\unitlength}{1cm}\\l').script,'l');
});
