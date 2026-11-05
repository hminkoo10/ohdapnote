// 설정 창의 AI 카드: 켜기/끄기 · 키 · 1·2순위 모델 · 분당 요청 수 + 세부 설정(AI 종류 · 게이트웨이 주소 · 속도)
// 기본은 Google Gemini. 세부 설정에서 OpenAI 호환(로컬 서버 포함) · Claude · ChatGPT 구독(Codex CLI)으로 바꿀 수 있음

import { h, clear, icon } from './ui.js';
import { api, state, errMsg } from './shared.js';
import { PROVIDERS } from './aiproviders.js';

const num = (input, min, max, d) => Math.max(min, Math.min(max, parseInt(input.value, 10) || d));

/**
 * @param {object} s 지금 설정
 * @returns {{card: HTMLElement, values: () => object}} values() = 저장할 설정
 */
export function aiSettingsCard(s) {
  let provider = PROVIDERS[s.aiProvider] ? s.aiProvider : 'gemini';
  const text = (value, attrs = {}) => h('input.input', { value: value || '', autocomplete: 'off', spellcheck: false, ...attrs });
  const secret = (value, placeholder) => text(value, { type: 'password', placeholder });
  const rpmInput = (id, value, max) => h('input.input.input-tiny', { type: 'number', min: 1, max, value: String(value || PROVIDERS[id].defaultRpm) });
  const rpmField = (input, note) => h('label.field', h('span', '분당 요청 수'), h('div.field-row', input, h('span.small.muted', note)));
  const link = (label, url) => h('button.link', { onclick: () => api.openExternal(url) }, label);

  // 세부 설정에 들어가는 칸 (모델 목록을 불러올 때도 씀)
  const gemBase = text(s.geminiBaseUrl, { placeholder: 'https://generativelanguage.googleapis.com' });
  const claudeBase = text(s.anthropicBaseUrl, { placeholder: 'https://api.anthropic.com' });
  const codexPath = text(s.codexPath, { placeholder: '(비우면 자동으로 찾음)' });

  /** 1·2순위 모델 칸 + "모델 목록" (목록에서 고르거나 직접 입력, 칩을 누르면 1순위, Shift+누르면 2순위) */
  const modelFields = (id, v1, v2, placeholder, listArgs) => {
    const listId = `ai-models-${id}`;
    const m1 = text(v1, { list: listId, placeholder });
    const m2 = text(v2, { list: listId, placeholder: '(없음 — 1순위만 사용)' });
    const datalist = h(`datalist#${listId}`);
    const msg = h('div.small.muted.model-msg', '모델 목록을 불러오면 입력칸에서 고를 수 있어요. 직접 적어도 돼요.');
    const chips = h('div.model-chips');
    const load = async () => {
      msg.textContent = '불러오는 중…';
      const r = await api.aiListModels({ provider: id, ...listArgs() });
      if (!r.ok) {
        msg.textContent = r.error;
        return;
      }
      clear(datalist);
      clear(chips);
      r.models.forEach((m) => datalist.append(h('option', { value: m.name }, m.displayName)));
      const pick = id === 'gemini' ? r.models.filter((m) => /flash/i.test(m.name)) : r.models;
      chips.append(
        ...pick.slice(0, 8).map((m) =>
          h(
            'button.model-chip',
            {
              title: `${m.displayName} — 누르면 1순위, Shift+클릭하면 2순위`,
              onclick: (e) => {
                (e.shiftKey ? m2 : m1).value = m.name;
              },
            },
            m.name,
          ),
        ),
      );
      msg.textContent = `${r.models.length}개 모델 — 칩을 누르면 1순위, Shift+누르면 2순위로 들어가요.${id === 'gemini' ? ' (flash 계열이 빠르고 무료 한도가 넉넉해요)' : ''}`;
    };
    return {
      m1,
      m2,
      nodes: [
        h('label.field', h('span', '1순위 모델'), h('div.field-row', m1, datalist, h('button.btn.btn-small', { onclick: load }, icon('list'), '모델 목록'))),
        h('label.field', h('span', '2순위 모델'), m2),
        h('div.field-note', msg, chips),
        h('p.small.muted', '1순위 모델의 사용 한도가 다 차거나 쓸 수 없으면 자동으로 2순위 모델로 넘어가요.'),
      ],
    };
  };

  // ---- Google Gemini (기본) ----
  const gem = { key: secret(s.geminiApiKey, 'AIza…'), rpm: rpmInput('gemini', s.geminiRpm, 60) };
  gem.models = modelFields('gemini', s.geminiModel || PROVIDERS.gemini.defaultModel, s.geminiModel2, PROVIDERS.gemini.defaultModel, () => ({ apiKey: gem.key.value.trim(), baseUrl: gemBase.value.trim() }));

  // ---- OpenAI 호환 (게이트웨이 · 로컬 서버) ----
  const oa = {
    base: text(s.openaiBaseUrl, { placeholder: 'https://api.openai.com/v1' }),
    key: secret(s.openaiApiKey, '(로컬 서버면 비워 둠)'),
    rpm: rpmInput('openai', s.openaiRpm, 1000),
  };
  oa.models = modelFields('openai', s.openaiModel, s.openaiModel2, '예: gpt-5-mini · qwen2.5vl:7b', () => ({ apiKey: oa.key.value.trim(), baseUrl: oa.base.value.trim() }));

  // ---- Anthropic Claude ----
  const cl = { key: secret(s.anthropicApiKey, 'sk-ant-…'), rpm: rpmInput('anthropic', s.anthropicRpm, 1000) };
  cl.models = modelFields('anthropic', s.anthropicModel || PROVIDERS.anthropic.defaultModel, s.anthropicModel2, PROVIDERS.anthropic.defaultModel, () => ({ apiKey: cl.key.value.trim(), baseUrl: claudeBase.value.trim() }));

  // ---- ChatGPT 구독 (Codex CLI) ----
  const cx = { model: text(s.codexModel, { placeholder: '(비우면 Codex 기본 모델)' }), status: h('div.small.muted.codex-status', '') };
  let codexChecked = false;
  const checkCodex = async () => {
    codexChecked = true;
    const say = (cls, msg) => {
      cx.status.className = `small codex-status ${cls}`;
      cx.status.textContent = msg;
    };
    say('muted', 'Codex CLI 를 찾는 중…');
    const r = await api.aiCodexStatus(codexPath.value.trim());
    const ver = r.version ? ` (${r.version})` : '';
    if (!r.found) say('warn-text', 'Codex CLI 를 찾지 못했어요 — 설치한 뒤 "다시 확인"을 누르거나, 고급에 codex 경로를 적어 주세요.');
    else if (!r.loggedIn) say('warn-text', `Codex CLI 찾음${ver} · 로그인 안 됨 — 명령 프롬프트에서 codex login 으로 ChatGPT 계정에 로그인해 주세요.`);
    else if (r.method === 'apikey') say('warn-text', `Codex CLI 찾음${ver} · API 키로 로그인되어 있어서 구독이 아니라 API 요금으로 나가요. ChatGPT 계정으로 쓰려면 codex logout 후 codex login`);
    else say('ok-text', `Codex CLI 찾음${ver} · ChatGPT 계정으로 로그인됨`);
  };

  const panels = {
    gemini: h(
      'div.ai-panel',
      h(
        'p.small.muted',
        '선택한 쪽을 다시 읽거나 한글 문서의 글자·수식으로 옮깁니다. ',
        link('API 키 받기', 'https://aistudio.google.com/apikey'),
        ' · 무료 등급의 이미지는 Google 서비스 개선에 쓰일 수 있습니다.',
      ),
      h('label.field', h('span', 'Gemini API 키'), gem.key),
    ),
    openai: h(
      'div.ai-panel',
      h('p.small.muted', '연결할 서비스의 키를 입력하세요. 주소와 모델은 고급에서 정합니다.'),
      h('label.field', h('span', '서비스 API 키'), oa.key),
    ),
    anthropic: h(
      'div.ai-panel',
      h('p.small.muted', 'Anthropic Claude API 키로 써요. 쓴 만큼 요금이 나가요. ', link('API 키 받기', 'https://console.anthropic.com/settings/keys'), ' · 모델은 바꿀 수 있어요.'),
      h('label.field', h('span', 'API 키'), cl.key),
    ),
    codex: h(
      'div.ai-panel',
      h(
        'p.small.muted',
        '이 컴퓨터에 연결한 ChatGPT 구독으로 정밀 인식을 사용합니다. 설치·로그인 안내는 고급에서 확인하세요.',
      ),
      h('div.field-row', cx.status, h('span.spacer'), h('button.btn.btn-small', { onclick: checkCodex }, icon('refresh'), '다시 확인')),
    ),
  };

  // ---- 세부 설정 ----
  const select = h(
    'select.input',
    Object.entries(PROVIDERS).map(([id, p]) => h('option', { value: id, selected: id === provider }, p.choice)),
  );
  const concInput = h('input.input.input-tiny', { type: 'number', min: 1, max: 8, value: String(s.aiConcurrency || 3) });
  const batchInput = h('input.input.input-tiny', { type: 'number', min: 1, max: 8, value: String(s.aiBatch || 4) });
  const only = (id, ...nodes) => h('div.ai-only', { dataset: { provider: id } }, nodes);
  const kindField = h('label.field', h('span', '인식 서비스'), select);
  const adv = h(
    'details.set-adv',
    h('summary', icon('gear'), '고급', h('span.small.muted', '서비스·모델·연결 설정')),
    kindField,
    only(
      'gemini',
      gem.models.nodes,
      rpmField(gem.rpm, '무료 한도를 넘지 않게 천천히 보내요'),
      h('label.field', h('span', '게이트웨이 주소'), gemBase),
      h('p.small.muted', '비우면 Google 로 바로 보내요. Cloudflare AI Gateway 같은 게이트웨이를 쓰면 그 주소(/v1beta 앞까지)를 적어요.'),
    ),
    only('openai',
      h('p.small.muted', 'OpenAI 방식(Chat Completions)으로 받는 서비스와 연결합니다. OpenAI, OpenRouter, LiteLLM 등의 주소와 그림을 읽을 수 있는 모델을 입력하세요.'),
      h('p.small.muted', '내 컴퓨터에서만 쓰려면 Ollama(http://localhost:11434/v1) · LM Studio(http://localhost:1234/v1) 등의 서버를 실행하세요. 로컬 서버의 API 키는 비워 둘 수 있습니다.'),
      h('label.field', h('span', '주소'), oa.base), oa.models.nodes,
      rpmField(oa.rpm, '서버 한도에 맞춰요 (로컬이면 크게 둬도 돼요)')),
    only('anthropic', cl.models.nodes, rpmField(cl.rpm, '계정 한도에 맞춰요'), h('label.field', h('span', '게이트웨이 주소'), claudeBase), h('p.small.muted', '비우면 https://api.anthropic.com 으로 보내요.')),
    only('codex',
      h('p.small.muted', '공식 Codex CLI 설치 후 명령 프롬프트에서 codex login 으로 로그인하세요. 오답노트는 임시 폴더에서 읽기 전용으로 실행합니다. 한 요청에 수십 초 걸릴 수 있습니다.'),
      h('label.field', h('span', '모델'), cx.model), h('label.field', h('span', 'codex 경로'), codexPath)),
    h('label.field', h('span', '동시 요청 수'), h('div.field-row', concInput, h('span.small.muted', '요청 여러 개를 같이 보내요 (기본 3)'))),
    h('label.field', h('span', '묶음 크기'), h('div.field-row', batchInput, h('span.small.muted', '한글 내보내기에서 한 요청에 담는 문항 수 (기본 4, 1이면 하나씩)'))),
  );

  // 끄면 AI 를 전혀 쓰지 않음 (넣어 둔 키·모델은 그대로 남음)
  const onInput = h('input', { type: 'checkbox', checked: s.aiEnabled !== false });
  const offNote = h('p.small.muted', '정밀 인식 꺼짐. 저장한 키·모델은 유지됩니다. 스캔본을 옮기는 방법은 내보내기에서 선택하세요.');

  // 학원 AI / 내 키 (학원 공간에서만): 학원 AI 는 원장이 통합 클라우드에서 정하고, 키는 보이지 않음
  const academy = !!state.appInfo?.academy;
  const a = s.academyAi;
  let source = s.aiSource === 'personal' ? 'personal' : 'academy';
  const sourceNote = h('div.small.muted.ai-source-note');
  const sourceRow = academy
    ? h(
        'div.ai-source',
        h(
          'div.seg',
          [
            ['academy', '학원 AI 쓰기'],
            ['personal', '내 키 쓰기'],
          ].map(([v, label]) =>
            h(
              'label',
              h('input', {
                type: 'radio',
                name: 'ai-source',
                value: v,
                checked: source === v,
                onchange: () => {
                  source = v;
                  show();
                },
              }),
              h('span', label),
            ),
          ),
        ),
        sourceNote,
      )
    : null;
  const cloudBtn = () => (state.appInfo?.manager ? h('button.link', { onclick: () => api.openCloud() }, '통합 클라우드에서 바꾸기') : '');
  const renderSource = () => {
    if (!academy) return;
    clear(sourceNote);
    if (source === 'personal') sourceNote.append('아래에 넣은 내 키·모델로 써요.');
    else if (a) sourceNote.append(`원장님이 통합 클라우드에서 정한 학원 AI 를 써요: ${PROVIDERS[a.provider]?.label || a.provider}${a.model ? ` · ${a.model}` : ''}. `, cloudBtn());
    else sourceNote.append(`아직 학원 AI 가 없어요. ${state.appInfo?.manager ? '통합 클라우드의 ‘학원 AI’에서 정하면' : '원장님이 통합 클라우드에서 정하면'} 학원 사람 모두가 같이 써요. 그때까지는 아래 내 설정을 써요. `, cloudBtn());
  };

  const show = () => {
    const on = onInput.checked;
    const viaAcademy = academy && source === 'academy' && !!a; // 학원 AI 를 쓰면 내 키·모델 칸은 숨김
    offNote.hidden = on;
    adv.hidden = !on;
    if (sourceRow) sourceRow.hidden = !on;
    renderSource();
    for (const [id, el] of Object.entries(panels)) el.hidden = !on || viaAcademy || id !== provider;
    kindField.hidden = viaAcademy;
    for (const el of adv.querySelectorAll('.ai-only')) el.hidden = viaAcademy || el.dataset.provider !== provider;
    if (on && !viaAcademy && provider === 'codex' && !codexChecked) checkCodex();
  };
  onInput.addEventListener('change', show);
  select.addEventListener('change', () => {
    provider = select.value;
    show();
  });
  const card = h('section.set-card', h('h4', icon('scan'), '정밀 인식 (AI 서비스 키)', h('span.spacer'), h('label.switch.small', onInput, h('span.sw'), '사용')), offNote, sourceRow, Object.values(panels), adv);
  show();

  return {
    card,
    values: () => ({
      aiEnabled: onInput.checked,
      aiSource: source,
      aiProvider: provider,
      geminiApiKey: gem.key.value.trim(),
      geminiModel: gem.models.m1.value.trim() || PROVIDERS.gemini.defaultModel,
      geminiModel2: gem.models.m2.value.trim(),
      geminiRpm: num(gem.rpm, 1, 60, PROVIDERS.gemini.defaultRpm),
      geminiBaseUrl: gemBase.value.trim(),
      openaiBaseUrl: oa.base.value.trim(),
      openaiApiKey: oa.key.value.trim(),
      openaiModel: oa.models.m1.value.trim(),
      openaiModel2: oa.models.m2.value.trim(),
      openaiRpm: num(oa.rpm, 1, 1000, PROVIDERS.openai.defaultRpm),
      anthropicApiKey: cl.key.value.trim(),
      anthropicModel: cl.models.m1.value.trim() || PROVIDERS.anthropic.defaultModel,
      anthropicModel2: cl.models.m2.value.trim(),
      anthropicRpm: num(cl.rpm, 1, 1000, PROVIDERS.anthropic.defaultRpm),
      anthropicBaseUrl: claudeBase.value.trim(),
      codexModel: cx.model.value.trim(),
      codexPath: codexPath.value.trim(),
      aiConcurrency: num(concInput, 1, 8, 3),
      aiBatch: num(batchInput, 1, 8, 4),
    }),
  };
}
