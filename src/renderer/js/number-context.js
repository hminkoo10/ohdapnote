// Independent visual context: no number value, scheme, signature or column alignment.
const median = a => a.length ? [...a].sort((x,y)=>x-y)[a.length >> 1] : 0;
export function numberContextGrid(rgba, width, height) {
  const w = Math.min(240, width), h = Math.max(1, Math.round(height*w/width));
  const dark = new Uint8Array(w*h), pale = new Uint8Array(w*h), fill = new Uint8Array(w*h);
  for (let y=0;y<h;y++) for(let x=0;x<w;x++) {
    let d=0,p=0,f=0,n=0;
    for(let sy=0;sy<3;sy++) for(let sx=0;sx<3;sx++) {
      const ix=Math.min(width-1,Math.floor((x+(sx+.5)/3)*width/w));
      const iy=Math.min(height-1,Math.floor((y+(sy+.5)/3)*height/h));
      const i=(iy*width+ix)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      const hi=Math.max(r,g,b),lo=Math.min(r,g,b); n++;
      if(hi<170)d++;
      if(lo>215 && hi>242 && hi-lo>=4 && hi-lo<45)p++;
      if(hi-lo>25 && lo<210)f++;
    }
    const k=y*w+x;dark[k]=Math.round(255*d/n);pale[k]=Math.round(255*p/n);fill[k]=Math.round(255*f/n);
  }
  // Preserve glyph detail at the actual analysis render size. Color/title cues
  // remain on the old small grid so this change cannot retune heading evidence.
  // Native ink is binary: pack directly, without allocating an unpacked page.
  const bits=new Uint8Array(Math.ceil(width*height/8));
  for(let i=0,k=0;i<rgba.length;i+=4,k++)
    if(rgba[i+3]>=128 && Math.max(rgba[i],rgba[i+1],rgba[i+2])<170)bits[k>>3]|=1<<(k&7);
  return {w,h,dark,pale,fill,line:{w:width,h:height,bits}};
}
const mean = (g, data, box) => {
  let sum=0,n=0;
  const packed=!!g.bits && data===g.bits;
  for(let y=Math.max(0,Math.floor(box.y0*g.h));y<Math.min(g.h,Math.ceil(box.y1*g.h));y++)
    for(let x=Math.max(0,Math.floor(box.x0*g.w));x<Math.min(g.w,Math.ceil(box.x1*g.w));x++){
      const k=y*g.w+x;sum+=packed ? ((data[k>>3]>>(k&7))&1)*255 : data[k];n++;
    }
  return n ? sum/n/255 : 0;
};
const overlap = (a,b) => Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0);
// Bounds of observed ink, never a number/scheme signature. No page raster copy.
function inkBounds(g,data,box,minCount=3) {
  let x0=g.w,y0=g.h,x1=-1,y1=-1,count=0;
  const packed=!!g.bits && data===g.bits;
  for(let y=Math.max(0,Math.floor(box.y0*g.h));y<Math.min(g.h,Math.ceil(box.y1*g.h));y++)
    for(let x=Math.max(0,Math.floor(box.x0*g.w));x<Math.min(g.w,Math.ceil(box.x1*g.w));x++){
      const k=y*g.w+x,ink=packed ? ((data[k>>3]>>(k&7))&1) : data[k]>=64;
      if(!ink)continue;
      x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);count++;
    }
  return count>=minCount ? {x0:x0/g.w,x1:(x1+1)/g.w,y0:y0/g.h,y1:(y1+1)/g.h} : null;
}
const pixel=(g,x,y)=>{
  x=Math.round(x);y=Math.round(y);
  if(x<0||y<0||x>=g.w||y>=g.h)return 0;
  const k=y*g.w+x;return g.bits?((g.bits[k>>3]>>(k&7))&1):(g.dark[k]>=64?1:0);
};
const nearPixel=(g,x,y)=>pixel(g,x,y)||pixel(g,x-1,y)||pixel(g,x+1,y)||pixel(g,x,y-1)||pixel(g,x,y+1);
function arcCoverage(g,cx,cy,rx,ry,angles,scale=1) {
  return angles.reduce((n,a)=>n+!!nearPixel(g,cx+rx*scale*Math.cos(a),cy+ry*scale*Math.sin(a)),0)/angles.length;
}
const circleAngles=Array.from({length:32},(_,i)=>i*Math.PI/16);
const capAngles=[75,90,105,255,270,285].map(a=>a*Math.PI/180);
// A sampled arc is not enough: the white inner annulus must be sealed from
// exterior paper. Four-connected white flood fill respects diagonal ring ink.
function closedRing(g,cx,cy,r) {
  const n=Math.ceil(r+3),w=2*n+1,seen=new Uint8Array(w*w),queue=new Int32Array(w*w);let tail=1;seen[0]=1;
  for(let head=0;head<tail;head++){
    const k=queue[head],x=k%w,y=Math.floor(k/w);
    for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
      const xx=x+dx,yy=y+dy,j=yy*w+xx;
      if(xx<0||yy<0||xx>=w||yy>=w||seen[j]||pixel(g,cx+xx-n,cy+yy-n))continue;
      seen[j]=1;queue[tail++]=j;
    }
  }
  let sealed=0;
  for(const a of circleAngles){
    const x=Math.round(r*.68*Math.cos(a)),y=Math.round(r*.68*Math.sin(a));
    if(!pixel(g,cx+x,cy+y)&&!seen[(y+n)*w+x+n])sealed++;
  }
  return sealed>=20;
}
function fitShape(g,cx,cy,r,kind) {
  // Parenthesis rejection withdrawn: glyph strokes/formula arcs are ambiguous.
  if(kind!=='circle')return null;
  const dark=g.bits||g.dark,ry=r;
  const inner={x0:(cx-r*.42)/g.w,x1:(cx+r*.42)/g.w,y0:(cy-ry*.42)/g.h,y1:(cy+ry*.42)/g.h};
  const centerInk=mean(g,dark,inner);
  if(centerInk<.03||centerInk>.55)return null; // Empty ring or filled badge stays.
  if(kind==='circle'){
    if([-1,1].flatMap(x=>[-1,1].map(y=>nearPixel(g,cx+x*r*.85,cy+y*ry*.85))).filter(Boolean).length>=3)return null;
    if(arcCoverage(g,cx,cy,r,ry,circleAngles)<.81)return null;
    if(arcCoverage(g,cx,cy,r,ry,capAngles)<.83)return null;
    // A white annular gap distinguishes an enclosing ring from a filled blob.
    const gap=circleAngles.reduce((n,a)=>n+pixel(g,cx+r*.68*Math.cos(a),cy+ry*.68*Math.sin(a)),0)/32;
    if(gap>.38||arcCoverage(g,cx,cy,r,ry,circleAngles,1.4)>.45)return null;
  }
  // Independently enclosed item: white perimeter separates ring from formula
  // strokes. Applied identically to candidate and peer, without token input.
  for(let a=-r-3;a<=r+3;a++){
    if(pixel(g,cx+a,cy-r-3)||pixel(g,cx+a,cy+r+3)||
       pixel(g,cx-r-3,cy+a)||pixel(g,cx+r+3,cy+a))return null;
  }
  if(!closedRing(g,cx,cy,r))return null;
  return {kind,cx,cy,r,ry};
}
export function choiceShapeObservation(page,box) {
  const g=page.numberContext?.line;
  const col=page.contextColumns?.find(c=>(box.x0+box.x1)/2>=c.x0&&(box.x0+box.x1)/2<=c.x1);
  if(!g||!col)return {shape:null,horizontalPeer:false};
  const hp=(box.y1-box.y0)*g.h;
  if(hp<5||hp>32)return {shape:null,horizontalPeer:false};
  const cx=Math.round((box.x0+box.x1)*g.w/2),cy=Math.round((box.y0+box.y1)*g.h/2);
  let found=null;
  for(const kind of ['circle']){
    for(const scale of [.5,.65,.8,.95]){
      const r=Math.max(4,hp*scale);
      for(const dx of [0,-1,1])for(const dy of [0,-1,1]){
        // Enclosure must span the candidate box, not a small glyph in it.
        const wp=(box.x1-box.x0)*g.w;
        if(Math.abs(2*r-wp)>3||Math.abs(2*r-hp)>3)continue;
        const shape=fitShape(g,cx+dx,cy+dy,r,kind);
        if(shape){found=shape;break;}
      }
      if(found)break;
    }
    if(found)break;
  }
  if(!found)return {shape:null,horizontalPeer:false};
  // Ink only: no token strings, candidate lists, values, counts or vertical x alignment.
  // A nearby body-sized ink line must exist to avoid classifying a large heading badge.
  const dark=g.bits||g.dark;
  const body=inkBounds(g,dark,{x0:(found.cx+found.r+2)/g.w,x1:Math.min(col.x1,(found.cx+found.r+6*hp)/g.w),y0:(found.cy-found.ry)/g.h,y1:(found.cy+found.ry)/g.h});
  if(!body||2*found.ry>1.45*(body.y1-body.y0)*g.h)return {shape:found.kind,horizontalPeer:false,reason:'not-body-sized'};
  let peer=false;
  const step=1;
  for(let x=Math.ceil(col.x0*g.w+found.r);x<col.x1*g.w-found.r&&!peer;x+=step){
    if(Math.abs(x-found.cx)<4*found.r)continue;
    for(const dy of [0,-1,1])if(fitShape(g,x,found.cy+dy,found.r,found.kind)){peer=true;break;}
  }
  return {shape:found.kind,horizontalPeer:peer,radiusPx:found.r};
}
function sameLineInk(g,dark,box,token,col) {
  const glyph=inkBounds(g,dark,box);
  if(!glyph)return null;
  const h=glyph.y1-glyph.y0,hp=h*g.h,hx=hp/g.w;
  if(hp<3)return null;
  // Tall OCR paragraph/word boxes may cross many lines. Inspect only actual
  // ink in the candidate's vertical band, immediately left in the same column.
  if(token.x0<col.x0 || token.x1>col.x1 || token.x1<box.x0-1.5*hx)return null;
  const area={x0:Math.max(col.x0,box.x0-4*hx,token.x0),x1:Math.min(box.x0-.12*hx,token.x1),
    y0:Math.max(glyph.y0,token.y0),y1:Math.min(glyph.y1,token.y1)};
  if(area.x1<=area.x0 || area.y1<=area.y0)return null;
  const left=inkBounds(g,dark,area);
  if(!left || left.x1-left.x0<.35*hx || left.y1-left.y0<.55*h)return null;
  if(Math.abs((left.y0+left.y1-glyph.y0-glyph.y1)/2)>.35*h)return null;
  const density=mean(g,dark,area);
  if(density<.04 || density>.65)return null;
  const ix=(left.x1-left.x0)*.25,iy=(left.y1-left.y0)*.25;
  if(mean(g,dark,{x0:left.x0+ix,x1:left.x1-ix,y0:left.y0+iy,y1:left.y1-iy})>.8)return null;
  return {basis:'native-ink-band',candidateInkHeight:hp,leftInkHeight:(left.y1-left.y0)*g.h,
    tokenHeightRatio:(token.y1-token.y0)/(box.y1-box.y0),overlapRatio:overlap(token,box)/Math.min(token.y1-token.y0,box.y1-box.y0)};
}
function headingEvidence(page, box) {
  const g=page.numberContext;
  const tokens=[...(page.tokens||[]),...(page.ocrPasses||[]).flat()];
  if(!g)return {reject:false};
  const h=box.y1-box.y0;
  if(!(h>0))return {reject:false};
  // A fraction near a genuine head is not itself rejection evidence.
  // Positive question language is preservation evidence, including boxed/bold heads.
  const question=tokens.some(t=>(/(?:문제|예제|유제|구하|고르|계산|설명|다음|조건|풀이|정답|옳은)|\b(?:find|compute|which|choose|solve|explain)\b/iu.test(t.str) && t.x1>box.x0-.01 && t.x0<box.x1+.35 && t.y1>box.y0-h && t.y0<box.y1+h));
  if(question)return {reject:false};
  const words=[];
  for(const t of tokens) if(/[가-힣A-Za-z]{2}/u.test(t.str) && !words.some(u=>Math.abs(u.x0-t.x0)<.003 && Math.abs(u.y0-t.y0)<.003 && Math.abs(u.x1-t.x1)<.004 && Math.abs(u.y1-t.y1)<.004))words.push(t);
  const right=words.filter(t=>t.x0>=box.x1-.002 && t.x0-box.x1<3*h && overlap(t,box)>.4*Math.min(h,t.y1-t.y0)).sort((a,b)=>a.x0-b.x0)[0];
  if(!right)return {reject:false};
  const body=words.filter(t=>t.y0>box.y1+h && t.y0<box.y1+10*h && t.x0>box.x0-.01 && t.x1<box.x0+.4);
  // Need independently observed body text, not the chain's learned signature.
  if(body.length<4)return {reject:false};
  const bh=median(body.map(t=>t.y1-t.y0));
  const density=median(body.map(t=>mean(g,g.dark,t)));
  const titleDensity=mean(g,g.dark,right),th=right.y1-right.y0;
  const bold=titleDensity>Math.max(.18,1.35*density) && th>.8*bh && th<1.6*bh;
  if(!bold)return {reject:false};
  const background=mean(g,g.pale,{x0:box.x0,y0:box.y0-h,x1:Math.min(1,right.x1+.015),y1:box.y1+2*h});
  const filled=mean(g,g.fill,{x0:box.x0-.006,y0:box.y0-.003,x1:box.x1+.006,y1:box.y1+.003});
  // Typography must combine with a tinted panel or a surrounding filled badge.
  if(background>.48 || filled>.45)return {reject:true,reason:'decorated-heading',heading:{x0:box.x0,x1:right.x1,y0:Math.min(box.y0,right.y0),y1:Math.max(box.y1,right.y1)}};
  return {reject:false};
}
// Local-left context: one candidate, same ink-derived column and line only.
// All distances use the candidate's printed height in square raster pixels.
function localColumnBoundary(g,box,col,hp) {
  const cy=Math.floor((box.y0+box.y1)*g.h/2),left=Math.max(0,Math.floor(Math.max(col.x0,box.x0-4*hp/g.w)*g.w));
  // A rule crosses several text lines, not a glyph, brace fragment or number
  // alignment. Inspect only the current candidate's immediate left window.
  for(let x=Math.floor(box.x0*g.w-.12*hp);x>=left;x--){
    if(!pixel(g,x,cy))continue;
    let a=x,b=x;
    while(a>left&&pixel(g,a-1,cy))a--;
    while(b+1<box.x0*g.w&&pixel(g,b+1,cy))b++;
    if(b-a+1>Math.max(2,Math.ceil(.15*hp))){x=a;continue;}
    let top=cy,bottom=cy;
    while(top>0&&pixel(g,x,top-1))top--;
    while(bottom+1<g.h&&pixel(g,x,bottom+1))bottom++;
    if(bottom-top+1>=6*hp&&cy-top>=2*hp&&bottom-cy>=2*hp)
      return {basis:'vertical-rule',x0:(b+1)/g.w,y0:top/g.h,y1:(bottom+1)/g.h,widthPx:b-a+1,heightPx:bottom-top+1};
    x=a;
  }
  return null;
}
function gutterFlank(g,x0,x1,top,bottom,hp) {
  let bands=0,rows=0,wideRows=0,first=-1,last=-1,previous=false;
  for(let y=top;y<=bottom;y++){
    let ink=0,inkLeft=x1,inkRight=x0;
    for(let x=x0;x<x1;x++)if(pixel(g,x,y)){ink++;inkLeft=Math.min(inkLeft,x);inkRight=x;}
    const present=ink>=2;
    if(present){rows++;if(first<0)first=y;last=y;if(!previous)bands++;}
    if(ink>=.4*hp&&inkRight-inkLeft+1>=1.5*hp)wideRows++;
    previous=present;
  }
  return {bands,rows,wideRows,extentPx:first<0?0:last-first+1};
}
function localWhitespaceBoundary(g,box,col,hp) {
  const cy=Math.floor((box.y0+box.y1)*g.h/2),left=Math.max(0,Math.floor(Math.max(col.x0,box.x0-4*hp/g.w)*g.w));
  const right=Math.min(g.w-1,Math.floor(box.x0*g.w-.12*hp)),minWidth=Math.max(3,Math.ceil(.4*hp));
  const minHeight=Math.max(24*hp,.75*g.h);let run=null;
  const finish=()=>{
    if(!run||run.right-run.left+1<minWidth)return null;
    const height=run.bottom-run.top+1;
    if(height<minHeight||cy-run.top<4*hp||run.bottom-cy<4*hp)return null;
    // Page-tall empty paper alone is not a gutter: sustained multi-line ink
    // must flank it. Ordinary word spaces, short choice rows and ruled cells
    // cannot supply a page-spanning, paragraph-supported corridor.
    const a=gutterFlank(g,left,run.left,run.top,run.bottom,hp);
    const b=gutterFlank(g,run.right+1,Math.min(g.w,Math.ceil(Math.min(col.x1,box.x1+4*hp/g.w)*g.w)),run.top,run.bottom,hp);
    if([a,b].some(s=>s.bands<6||s.extentPx<.6*height||s.rows<.08*height||s.wideRows<.04*height))return null;
    return {basis:'vertical-whitespace',x0:(run.right+1)/g.w,y0:run.top/g.h,y1:(run.bottom+1)/g.h,widthPx:run.right-run.left+1,heightPx:height,leftSupport:a,rightSupport:b};
  };
  for(let x=right;x>=left;x--){
    let top=cy,bottom=cy;
    if(!pixel(g,x,cy)){
      while(top>0&&!pixel(g,x,top-1))top--;
      while(bottom+1<g.h&&!pixel(g,x,bottom+1))bottom++;
    }
    if(pixel(g,x,cy)||bottom-top+1<minHeight||cy-top<4*hp||bottom-cy<4*hp){const found=finish();if(found)return found;run=null;continue;}
    const a=run?Math.max(run.top,top):top,b=run?Math.min(run.bottom,bottom):bottom;
    if(run&&b-a+1<minHeight){const found=finish();if(found)return found;run=null;}
    run=run?{...run,left:x,top:a,bottom:b}:{left:x,right:x,top,bottom};
  }
  return finish();
}
function surroundPreserved(color,g,dark,box,hp,hx) {
  // A filled/tinted badge or band is preservation evidence, not body text.
  const surround={x0:box.x0-.2*hx,x1:box.x1+.2*hx,y0:box.y0-.2*hp/g.h,y1:box.y1+.2*hp/g.h};
  if(mean(color,color.fill,surround)>.35 || mean(color,color.pale,surround)>.48 || mean(g,dark,surround)>.65)return 'badge-or-band-preserved';
  // Closed monochrome number boxes: two horizontal rims and an outside side.
  const row=(y)=>mean(g,dark,{x0:box.x0-.35*hx,x1:box.x1+.35*hx,y0:y-.5/g.h,y1:y+.5/g.h});
  const above=[.2,.4,.6].some(d=>row(box.y0-d*hp/g.h)>.6);
  const below=[.2,.4,.6].some(d=>row(box.y1+d*hp/g.h)>.6);
  const side=[.2,.4,.6].some(d=>mean(g,dark,{x0:box.x0-d*hx-.5/g.w,x1:box.x0-d*hx+.5/g.w,y0:box.y0,y1:box.y1})>.6);
  return above && below && side ? 'closed-box-preserved' : null;
}
export function lineInteriorEvidence(page, box) {
  const color=page.numberContext, g=color?.line||color, columns=page.contextColumns;
  if(!g || !columns?.length)return {reject:false,gate:'missing-grid-or-ink-columns'};
  const dark=g.bits||g.dark;
  const hp=(box.y1-box.y0)*g.h, hx=hp/g.w;
  if(hp<3)return {reject:false,gate:'raster-height-below-3'}; // Preserve, never guess.
  const cx=(box.x0+box.x1)/2;
  const baseCol=columns.find(c=>cx>=c.x0 && cx<=c.x1);
  if(!baseCol)return {reject:false,gate:'outside-ink-column'};
  const boundary=localColumnBoundary(g,box,baseCol,hp);
  const contextBoundary=boundary||localWhitespaceBoundary(g,box,baseCol,hp);
  const col=contextBoundary?{x0:Math.max(baseCol.x0,contextBoundary.x0),x1:baseCol.x1}:baseCol;
  const local={x0:Math.max(col.x0,box.x0-4*hx),x1:box.x0-.12*hx,y0:box.y0,y1:box.y1};
  if(local.x1<=local.x0)return {reject:false,gate:'column-start',...(contextBoundary?{lineProbe:{localXTokens:0,intersectingTokens:0,closest:null,columnBoundary:contextBoundary}}:{})};
  const kept=surroundPreserved(color,g,dark,box,hp,hx);
  if(kept)return {reject:false,gate:kept};
  const tokens=[...(page.tokens||[]),...(page.ocrPasses||[]).flat()];
  let reached=0;
  const lineProbe={localXTokens:0,intersectingTokens:0,closest:null,...(contextBoundary?{columnBoundary:contextBoundary}:{})};
  for(const t of tokens){
    if(t.x0<col.x0 || t.x1>col.x1 || t.x0>=local.x1 || t.x1<box.x0-1.5*hx)continue;
    lineProbe.localXTokens++;
    // An x-neighbor on another line is NOT evidence of a height mismatch.
    if(overlap(t,box)<=0)continue;
    lineProbe.intersectingTokens++;
    reached=Math.max(reached,1);
    // Decoration glyphs/rules alone are never text evidence. No numeric token
    // values, lengths, styles, candidate columns or learned signatures inspected.
    if(!/[\p{L}\p{N}\p{Sm}]/u.test(t.str||'') || /^[■□●○◆◇▪▫•·|_—–\-\s]+$/u.test(t.str||''))continue;
    if(/^(?:문제|예제|유제|유형|question|example|exercise|q)\s*$/iu.test(t.str||''))continue;
    reached=Math.max(reached,2);
    const th=t.y1-t.y0, h=box.y1-box.y0;
    const metrics={heightRatio:th/h,overlapRatio:overlap(t,box)/Math.min(th,h),centerDelta:Math.abs((t.y0+t.y1-box.y0-box.y1)/2)/Math.max(th,h)};
    if(!lineProbe.closest || metrics.centerDelta<lineProbe.closest.centerDelta)lineProbe.closest=metrics;
    const tokenLine=th>.45*h && th<1.8*h && overlap(t,box)>=.55*Math.min(th,h) &&
      Math.abs((t.y0+t.y1-box.y0-box.y1)/2)<=.35*Math.max(th,h);
    if(!tokenLine){
      const inkLine=sameLineInk(g,dark,box,t,col);
      if(inkLine)return {reject:true,reason:'same-line-interior',lineEvidence:inkLine,lineProbe};
    }
    if(!(th>.45*h && th<1.8*h) || overlap(t,box)<.55*Math.min(th,h))continue;
    reached=Math.max(reached,3);
    if(Math.abs((t.y0+t.y1-box.y0-box.y1)/2)>.35*Math.max(th,h))continue;
    reached=Math.max(reached,4);
    const ink={x0:Math.max(t.x0,local.x0),x1:Math.min(t.x1,local.x1),y0:Math.max(t.y0,box.y0),y1:Math.min(t.y1,box.y1)};
    if(ink.x1-ink.x0<.35*hx)continue;
    reached=Math.max(reached,5);
    const density=mean(g,dark,ink);
    // A solid symbol, border or OCR hallucination on blank paper cannot reject.
    if(density<.04 || density>.65)continue;
    reached=Math.max(reached,6);
    const ix=(ink.x1-ink.x0)*.25,iy=(ink.y1-ink.y0)*.25;
    if(mean(g,dark,{x0:ink.x0+ix,x1:ink.x1-ix,y0:ink.y0+iy,y1:ink.y1-iy})>.8)continue;
    return {reject:true,reason:'same-line-interior',lineEvidence:{basis:'token-box',...metrics},lineProbe};
  }
  return {reject:false,gate:tokens.length ? ['no-local-left-token','non-text-or-label','line-height-or-overlap','line-center','left-span','ink-density','solid-core'][reached] : 'no-tokens',lineProbe};
}
// Formula interior: one candidate box and connected page-ink components only.
// No token text, other candidates, number values, order, digit counts or
// alignment between numbers. Distances are candidate heights (H); the pixel
// floors are stated for a 1920 px wide page and scaled to this raster.
// 8-connected components of the whole page, built from row runs (no page-sized
// label array). Boxes are raster pixels with exclusive x1/y1.
function inkComponents(g) {
  const gw=g.w,gh=g.h,bits=g.bits,dark=g.dark;
  const on=bits?k=>(bits[k>>3]>>(k&7))&1:k=>dark[k]>=64;
  const parent=[],rx0=[],rx1=[],ry=[];
  const find=i=>{while(parent[i]!==i)i=parent[i]=parent[parent[i]];return i;};
  let prevA=0,prevB=0;
  for(let y=0;y<gh;y++){
    const rowStart=parent.length,base=y*gw;let p=prevA;
    for(let x=0;x<gw;x++){
      if(!on(base+x))continue;
      let e=x;
      while(e+1<gw&&on(base+e+1))e++;
      const id=parent.length;parent.push(id);rx0.push(x);rx1.push(e);ry.push(y);
      while(p<prevB&&rx1[p]<x-1)p++;
      for(let q=p;q<prevB&&rx0[q]<=e+1;q++){
        const a=find(q),b=find(id);
        if(a!==b)parent[Math.max(a,b)]=Math.min(a,b);
      }
      x=e;
    }
    prevA=rowStart;prevB=parent.length;
  }
  const boxes=new Map();
  for(let i=0;i<parent.length;i++){
    const r=find(i),b=boxes.get(r);
    if(!b)boxes.set(r,{x0:rx0[i],y0:ry[i],x1:rx1[i]+1,y1:ry[i]+1});
    else{b.x0=Math.min(b.x0,rx0[i]);b.x1=Math.max(b.x1,rx1[i]+1);b.y0=Math.min(b.y0,ry[i]);b.y1=Math.max(b.y1,ry[i]+1);}
  }
  return [...boxes.values()];
}
const r4=v=>Math.round(v*1e4)/1e4;
function formulaInteriorEvidence(page,box,shared) {
  const color=page.numberContext,g=color?.line||color,columns=page.contextColumns;
  if(!g || !columns?.length)return null;
  const hp=(box.y1-box.y0)*g.h;
  if(hp<3)return null;
  const cx=(box.x0+box.x1)/2;
  if(!columns.some(c=>cx>=c.x0 && cx<=c.x1))return null;
  if(surroundPreserved(color,g,g.bits||g.dark,box,hp,hp/g.w))return null;
  const comps=shared.components||(shared.components=inkComponents(g));
  const s=g.w/1920,x0=box.x0*g.w,x1=box.x1*g.w,y0=box.y0*g.h,y1=box.y1*g.h;
  const H=Math.max(y1-y0,4*s),cw=x1-x0,ccx=(x0+x1)/2,ccy=(y0+y1)/2,m=.35*H;
  // The candidate's own glyph components touch its box and stay near it.
  const ext=comps.filter(c=>!(c.x0<x1 && c.x1>x0 && c.y0<y1 && c.y1>y0 &&
    c.x0>=x0-m && c.x1<=x1+m && c.y0>=y0-m && c.y1<=y1+m));
  // Fraction: a thin stroke wider than the candidate just above/below it, with
  // ink on the stroke's far side centred on the stroke. The stroke may not be
  // much wider than both sides together, so a column rule or box edge over a
  // genuine head and the text above it does not qualify.
  let bar=null;
  for(const c of ext){
    const w=c.x1-c.x0,h=c.y1-c.y0;
    if(!(h<=Math.max(.2*H,3*s) && w>cw && w>=3*h && c.x0-.1*H<=ccx && ccx<=c.x1+.1*H))continue;
    for(const side of ['below','above']){
      const gap=side==='below'?c.y0-y1:y0-c.y1;
      if(gap>=-.15*H && gap<=1.5*H && (!bar || gap<bar.gap))bar={c,side,gap};
    }
  }
  if(bar && bar.gap<=.6*H){
    const b=bar.c,bw=b.x1-b.x0;
    const opp=ext.filter(c=>{
      const gap=bar.side==='below'?c.y0-b.y1:b.y0-c.y1;
      return c!==b && gap>=-s && gap<=.6*H && c.x1>b.x0 && c.x0<b.x1 &&
        Math.max(0,c.x0-x1,x0-c.x1)<=H && c.y1-c.y0<=3*H;
    });
    if(opp.length){
      const ox0=Math.min(...opp.map(c=>c.x0)),ox1=Math.max(...opp.map(c=>c.x1));
      const ratio=bw/(cw+ox1-ox0),offset=Math.abs((ox0+ox1)/2-(b.x0+b.x1)/2)/bw;
      // Numerator and denominator both sit centred on the stroke; a head at one
      // end of an underlined label above it does not.
      const candOffset=Math.abs(ccx-(b.x0+b.x1)/2)/bw;
      if(offset<=.25 && candOffset<=.25 && ratio<=3)return {reject:true,reason:'fraction-interior',fractionEvidence:{side:bar.side,
        gapH:r4(bar.gap/H),widthH:r4(bw/H),thickH:r4((b.y1-b.y0)/H),farWidthH:r4((ox1-ox0)/H),ratio:r4(ratio),offset:r4(offset),candOffset:r4(candOffset)}};
    }
  }
  // Bracket pair: a tall narrow component crossing the candidate's middle on
  // each side. A cell border joined to its horizontal rules is one wide
  // component, so it is not a bracket.
  const tall=ext.filter(c=>c.y0<=ccy && c.y1>=ccy && c.y1-c.y0>=2.5*H && c.y1-c.y0<=12*H && c.x1-c.x0<=H);
  const nearest=dist=>tall.map(c=>({c,d:dist(c)})).filter(v=>v.d>=-.1*H && v.d<=8*H).sort((a,b)=>a.d-b.d)[0];
  const left=nearest(c=>x0-c.x1),right=nearest(c=>c.x0-x1);
  if(left && right)return {reject:true,reason:'bracket-pair-interior',bracketEvidence:{
    leftGapH:r4(left.d/H),leftHeightH:r4((left.c.y1-left.c.y0)/H),rightGapH:r4(right.d/H),rightHeightH:r4((right.c.y1-right.c.y0)/H)}};
  return null;
}
export function numberContextEvidence(page,box,shared={}) {
  const shape=choiceShapeObservation(page,box);
  if(shape.horizontalPeer)return {reject:true,reason:'choice-shape-horizontal',shapeEvidence:shape};
  const heading=headingEvidence(page,box);
  if(heading.reject)return heading;
  const line=lineInteriorEvidence(page,box);
  return line.reject ? line : formulaInteriorEvidence(page,box,shared) || line;
}
// Final emission only: selection/retry/crop/fill inputs stay untouched. Every
// final candidate, including primary/auxiliary and answer pages, uses this path.
export function filterNumberContexts(page,candidates) {
  page.contextHeadings=[];
  const shared={};
  return candidates.filter(c=>{
    const box=c.contextBox || {x0:c.x0,x1:c.x1,y0:c.y0,y1:c.y1};
    const e=numberContextEvidence(page,box,shared);
    if(e.heading)page.contextHeadings.push(e.heading);
    return !e.reject;
  });
}
