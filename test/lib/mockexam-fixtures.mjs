import { chromium } from './playwright.mjs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
export async function makeMockExamFixtures(input) {
  const browser = await chromium.launch({ headless: true });
  try {
    const p = await browser.newPage();
    const pdf = async (name, body) => {
      await p.setContent(`<style>@page{size:A4;margin:15mm}body{font:14px 'Malgun Gothic'}header{height:100px}section{height:150px}h1{font-size:16px}</style>${body}`);
      await p.pdf({ path: join(input, name), printBackground: true });
    };
    await pdf('2024학년도 수능 수학 홀수형 문제지.pdf', `<header>2024학년도 대학수학능력시험 수학 영역 홀수형</header>${[1,2,3].map((n) => `<section>${n}. 가짜 문항입니다. 두 수의 합을 구하세요. [3점]<p>① 1　② 2　③ 3　④ 4　⑤ 5</p></section>`).join('')}<div style="break-before:page"><header>2024학년도 대학수학능력시험 수학 영역 (미적분) 홀수형</header>${[23,24].map((n) => `<section>${n}. 가짜 선택 문항입니다. 식의 값을 구하세요. [3점]<p>① 1　② 2　③ 3　④ 4　⑤ 5</p></section>`).join('')}</div>`);
    await pdf('2024학년도 수능 수학 정답.pdf', '<h1>수학 영역 정답 (홀수) 형</h1><p>번호 정답 배점</p><p>1 2 3</p><p>2 3 3</p><p>3 4 3</p><h1>미적분</h1><p>번호 정답 배점</p><p>23 1 3</p><p>24 2 3</p><div style="break-before:page"><h1>수학 영역 정답 (짝수) 형</h1><p>번호 정답 배점</p><p>1 5 3</p><p>2 5 3</p><p>3 5 3</p><h1>미적분</h1><p>번호 정답 배점</p><p>23 5 3</p><p>24 5 3</p></div>');
    await pdf('2024학년도 수능 수학 해설.pdf', '<header>가짜 해설입니다.</header><section>1. 두 수를 더하면 돼요. 설명을 읽고 확인하세요.</section>');
    await pdf('2023년 3월 고1 학평 수학 문제지.pdf', `<header>2023년 3월 고1 전국연합학력평가 수학</header>${[1,2,3].map((n) => `<section>${n}. 두 수의 합을 구하세요. [3점]<p>① 1　② 2　③ 3　④ 4　⑤ 5</p></section>`).join('')}`);
    await p.setContent('<style>body{font:48px monospace;line-height:2;background:white;padding:30px}</style><pre>1       2<br>2       3<br>3       4</pre>');
    await p.screenshot({ path: join(input, '2023년 3월 고1 학평 수학 정답.png') });
    writeFileSync(join(input, '건너뛸 파일.txt'), 'fake');
  } finally { await browser.close(); }
}
