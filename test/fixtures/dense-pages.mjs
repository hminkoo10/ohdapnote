// 가상 교재 3권 × 4쪽. 실제 교재 글·좌표·검출 결과 아님.
// 지시문/서술문, 식만 있는 셀, OCR 누락을 별도로 다룬다.
export const densePages = ['연산연습', '빈칸연습', 'OX단답'].flatMap((book,b) =>
  Array.from({length:4},(_,p) => {
    const cols = 4+b, rows = 12, pageIndex = p+1;
    const texts = ['값을 계산하시오.', '이 명제가 참이면 O이다.', '(3 + 8) = □', undefined];
    return {id:`synthetic-${b}-${p}`,book,pageIndex,lastQuestionPage:8,truth:'problem',
      items:Array.from({length:cols*rows},(_,i)=>({page:pageIndex,number:String(i+1),
        ...(texts[p] === undefined ? {} : {text:texts[p]}),
        rects:[{page:pageIndex,x:.08+(i%cols)*(.84/cols),y:.1+Math.floor(i/cols)*.055,w:.1,h:.025}]}))};
  }));
