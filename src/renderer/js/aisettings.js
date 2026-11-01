// 설정 창의 AI 카드: 키 · 1·2순위 모델 · 분당 요청 수 + 세부 설정(AI 종류 · 게이트웨이 주소 · 속도)
// 기본은 Google Gemini. 세부 설정에서 OpenAI 호환(로컬 서버 포함) · Claude · ChatGPT 구독(Codex CLI)으로 바꿀 수 있음

import { h, clear, icon } from './ui.js';
import { api } from './shared.js';
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
    if (!r.found) say('warn-text', 'Codex CLI 를 찾지 못했어요 — 설치한 뒤 "다시 확인"을 누르거나, 세부 설정에 codex 경로를 적어 주세요.');
    else if (!r.loggedIn) say('warn-text', `Codex CLI 찾음${ver} · 로그인 안 됨 — 명령 프롬프트에서 codex login 으로 ChatGPT 계정에 로그인해 주세요.`);
    else if (r.method === 'apikey') say('warn-text', `Codex CLI 찾음${ver} · API 키로 로그인되어 있어서 구독이 아니라 API 요금으로 나가요. ChatGPT 계정으로 쓰려면 codex logout 후 codex login`);
    else say('ok-text', `Codex CLI 찾음${ver} · ChatGPT 계정으로 로그인됨`);
  };

  const panels = {
    gemini: h(
      'div.ai-panel',
      h(
        'p.small.muted',
        '자동 인식이 애매한 쪽을 골라서 AI에게 맡기고, 한글(HWPX)로 내보낼 때 문항을 글자·수식으로 옮겨요. 기본은 Google Gemini — 무료 Google AI Studio API 키면 됩니다. ',
        link('API 키 받기', 'https://aistudio.google.com/apikey'),
        ' · 무료 등급에서는 보낸 이미지가 Google 서비스 개선에 쓰일 수 있어요.',
      ),
      h('label.field', h('span', 'API 키'), gem.key),
      gem.models.nodes,
      rpmField(gem.rpm, '무료 한도를 넘지 않게 천천히 보내요'),
    ),
    openai: h(
      'div.ai-panel',
      h(
        'p.small.muted',
        'OpenAI 방식(Chat Completions)으로 받는 곳이면 어디든 돼요 — OpenAI, OpenRouter(https://openrouter.ai/api/v1), LiteLLM·Cloudflare AI Gateway 같은 게이트웨이. 그림을 읽을 수 있는 모델이어야 해요.',
      ),
      h(
        'p.small.muted',
        h('strong', '인터넷 없이 내 컴퓨터에서만: '),
        'Ollama(http://localhost:11434/v1) · LM Studio(http://localhost:1234/v1) · llama.cpp 서버(http://localhost:8080/v1)에 그림을 읽는 모델(예: qwen2.5vl)을 띄우고 주소와 모델 이름만 적으세요. API 키는 비워 두면 되고, 문항 그림이 밖으로 나가지 않아요.',
      ),
      h('label.field', h('span', '주소'), oa.base),
      h('label.field', h('span', 'API 키'), oa.key),
      oa.models.nodes,
      rpmField(oa.rpm, '서버 한도에 맞춰요 (로컬이면 크게 둬도 돼요)'),
    ),
    anthropic: h(
      'div.ai-panel',
      h('p.small.muted', 'Anthropic Claude API 키로 써요. 쓴 만큼 요금이 나가요. ', link('API 키 받기', 'https://console.anthropic.com/settings/keys'), ' · 모델은 바꿀 수 있어요.'),
      h('label.field', h('span', 'API 키'), cl.key),
      cl.models.nodes,
      rpmField(cl.rpm, '계정 한도에 맞춰요'),
    ),
    codex: h(
      'div.ai-panel',
      h(
        'p.small.muted',
        'ChatGPT Plus/Pro 구독의 사용량으로 처리해요 (API 요금 따로 없음). 공식 Codex CLI 를 설치하고 명령 프롬프트에서 codex login 으로 ChatGPT 계정에 로그인해 두세요. 오답노트는 로그인 정보를 읽지 않고, codex 를 임시 폴더에서 읽기 전용으로 실행해 답만 받아요. 한 요청에 수십 초 걸릴 수 있어요.',
      ),
      h('div.field-row', cx.status, h('span.spacer'), h('button.btn.btn-small', { onclick: checkCodex }, icon('refresh'), '다시 확인')),
      h('label.field', h('span', '모델'), cx.model),
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
  const adv = h(
    'details.set-adv',
    { open: provider !== 'gemini' },
    h('summary', icon('gear'), '세부 설정', h('span.small.muted', '다른 AI · 게이트웨이 · 속도')),
    h('label.field', h('span', 'AI 종류'), select),
    only(
      'gemini',
      h('label.field', h('span', '게이트웨이 주소'), gemBase),
      h('p.small.muted', '비우면 Google 로 바로 보내요. Cloudflare AI Gateway 같은 게이트웨이를 쓰면 그 주소(/v1beta 앞까지)를 적어요.'),
    ),
    only('anthropic', h('label.field', h('span', '게이트웨이 주소'), claudeBase), h('p.small.muted', '비우면 https://api.anthropic.com 으로 보내요.')),
    only('codex', h('label.field', h('span', 'codex 경로'), codexPath)),
    h('label.field', h('span', '동시 요청 수'), h('div.field-row', concInput, h('span.small.muted', '요청 여러 개를 같이 보내요 (기본 3)'))),
    h('label.field', h('span', '묶음 크기'), h('div.field-row', batchInput, h('span.small.muted', '한글 내보내기에서 한 요청에 담는 문항 수 (기본 4, 1이면 하나씩)'))),
  );

  const show = () => {
    for (const [id, el] of Object.entries(panels)) el.hidden = id !== provider;
    for (const el of adv.querySelectorAll('.ai-only')) el.hidden = el.dataset.provider !== provider;
    if (provider === 'codex' && !codexChecked) checkCodex();
  };
  select.addEventListener('change', () => {
    provider = select.value;
    show();
  });
  const card = h('section.set-card', h('h4', icon('sparkle'), 'AI 보조 인식 (선택)'), Object.values(panels), adv);
  show();

  return {
    card,
    values: () => ({
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
