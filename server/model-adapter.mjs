import http from 'node:http';
import https from 'node:https';

const DEFAULT_RUNTIME = process.env.LOCAL_MODEL_RUNTIME ?? 'llama.cpp';
const DEFAULT_BASE_URL = process.env.LOCAL_MODEL_BASE_URL ?? 'http://127.0.0.1:8080/v1';
const DEFAULT_MODEL =
  process.env.LOCAL_MODEL_NAME ?? 'Qwen/Qwen3-VL-4B-Instruct-GGUF';
const DEFAULT_MATH_BASE_URL = process.env.MATH_MODEL_BASE_URL ?? 'http://127.0.0.1:8090';
const DEFAULT_MATH_MODEL = process.env.MATH_MODEL_NAME ?? 'Qwen2.5-Math-7B-Instruct';
const DEFAULT_SCIENCE_BASE_URL = process.env.SCIENCE_MODEL_BASE_URL ?? 'http://127.0.0.1:8100/v1';
const DEFAULT_SCIENCE_MODEL = process.env.SCIENCE_MODEL_NAME ?? 'Intern-S1-mini';
const RESULT_FIELDS = new Set([
  'answer',
  'finalAnswer',
  'steps',
  'keyIdeas',
  'keyPoints',
  'knowledgePoints',
  'scorePercent',
  'verdict',
  'mistakes',
  'suggestions',
  'question',
  'options',
  'referenceAnswer',
  'explanation',
]);

function stripDataUrl(dataUrl = '') {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  return match?.[1] ?? dataUrl;
}

export function requestJsonNoTimeout(urlString, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('本地数学服务 HTTP ' + response.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(text || '{}'));
        } catch {
          reject(new Error('本地数学服务返回了无效 JSON。'));
        }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

export function parseModelJson(value) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return unwrapNestedResult(value);
  }

  const text = stripMarkdownFences(String(value ?? ''));
  const candidates = [text, ...extractJsonFragments(text)];
  const parsedFragments = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const parsed = parseJsonCandidate(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsedFragments.push(parsed);
    }
  }

  if (parsedFragments.length === 0) {
    return { answer: text, steps: [], keyIdeas: [], knowledgePoints: [] };
  }

  return unwrapNestedResult(Object.assign({}, ...parsedFragments));
}

function stripMarkdownFences(text) {
  return text
    .replace(/```[ \t]*(?:json)?[ \t]*\r?\n?/gi, '')
    .replace(/```/g, '')
    .trim();
}

function extractJsonFragments(text) {
  const fragments = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        fragments.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return fragments;
}

function parseJsonCandidate(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairJsonBackslashes(candidate));
    } catch {
      return null;
    }
  }
}

function repairJsonBackslashes(candidate) {
  let repaired = '';
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (character !== '\\') {
      repaired += character;
      continue;
    }

    const next = candidate[index + 1];
    const afterNext = candidate[index + 2];
    if (next === '"' || next === '\\' || next === '/') {
      repaired += `\\${next}`;
      index += 1;
      continue;
    }
    if (next === 'u' && /^[0-9a-f]{4}$/i.test(candidate.slice(index + 2, index + 6))) {
      repaired += candidate.slice(index, index + 6);
      index += 5;
      continue;
    }

    // LaTeX commands such as \frac, \ln, \text and \neq begin with
    // letters that JSON also treats as control escapes. Keep the slash.
    if ('bfnrt'.includes(next ?? '') && /[A-Za-z]/.test(afterNext ?? '')) {
      repaired += `\\\\${next}`;
    } else if ('bfnrt'.includes(next ?? '')) {
      repaired += `\\${next}`;
    } else {
      repaired += `\\\\${next ?? ''}`;
    }
    if (next) index += 1;
  }
  return repaired;
}

function unwrapNestedResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (typeof value.answer !== 'string' || !/[{}]|```/.test(value.answer)) return value;

  const nestedText = stripMarkdownFences(value.answer);
  const nestedCandidates = [nestedText, ...extractJsonFragments(nestedText)];
  for (const candidate of nestedCandidates) {
    const nested = parseJsonCandidate(candidate);
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const hasResultField = Object.keys(nested).some((key) => RESULT_FIELDS.has(key));
    if (hasResultField) return Object.assign({}, value, nested);
  }
  return value;
}

function parseGeneratedText(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const sections = {
    question: [],
    referenceAnswer: [],
    explanation: [],
  };
  const aliases = {
    question: new Set(['题目', '问题', '试题']),
    referenceAnswer: new Set(['答案', '参考答案', '正确答案']),
    explanation: new Set(['解析', '分析', '解答', '解题思路']),
  };
  // Models label the sections in several ways: 「题目：」, 「**题目**」 or 「【题目】」.
  // The header may also be followed by content on the same line, so the matched
  // prefix is sliced off the original line rather than re-read from the capture
  // group, which would mangle LaTeX such as \[ F = ma \].
  const header = /^\s*\*{0,2}\s*(?:[【\[［(（]\s*)?(题目|问题|试题|答案|参考答案|正确答案|解析|分析|解答|解题思路)\s*(?:[】\]］)）])?\s*\*{0,2}\s*(?:[:：]\s*)?\*{0,2}\s*/;
  let current = '';
  let foundHeader = false;

  for (const line of source.split('\n')) {
    const match = line.match(header);
    if (match) {
      current = Object.entries(aliases).find(([, names]) => names.has(match[1]))?.[0] ?? '';
      foundHeader = true;
      const rest = line.slice(match[0].length).trim();
      if (rest) sections[current].push(rest);
      continue;
    }
    if (current) sections[current].push(line);
  }

  if (!foundHeader) return {};
  return Object.fromEntries(
    Object.entries(sections).map(([key, lines]) => [key, lines.join('\n').trim()]),
  );
}

function firstDefined(value, keys, fallback = '') {
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return fallback;
}

function firstNonEmpty(value, keys, fallback = '') {
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) {
      return value[key];
    }
  }
  return fallback;
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(/\n|\r|[;；]/).map((item) => item.replace(/^\s*[-*\d.、]+\s*/, '').trim()).filter(Boolean);
  }
  return [];
}

export function getRuntimeConfig(environment = process.env) {
  return {
    runtime: environment.LOCAL_MODEL_RUNTIME ?? DEFAULT_RUNTIME,
    baseUrl: (environment.LOCAL_MODEL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    model: environment.LOCAL_MODEL_NAME ?? DEFAULT_MODEL,
    mathBaseUrl: (environment.MATH_MODEL_BASE_URL ?? DEFAULT_MATH_BASE_URL).replace(/\/$/, ''),
    mathModel: environment.MATH_MODEL_NAME ?? DEFAULT_MATH_MODEL,
    scienceBaseUrl: (environment.SCIENCE_MODEL_BASE_URL ?? DEFAULT_SCIENCE_BASE_URL).replace(/\/$/, ''),
    scienceModel: environment.SCIENCE_MODEL_NAME ?? DEFAULT_SCIENCE_MODEL,
  };
}

export function buildChineseTeacherInstruction() {
  return '你是一个AI教师，请根据用户提供的内容完成任务。';
}

export function normalizeTaskResult(raw, kind) {
  const value = raw?.result ?? raw ?? {};
  const generated = kind === 'generate' ? parseGeneratedText(value.answer) : {};
  const answer = String(firstNonEmpty(value, ['answer', 'finalAnswer', 'final_answer', '答案', 'explanation', 'analysis'], ''));
  const suggestions = asStringArray(firstDefined(value, ['suggestions', '改进建议']));
  if (!answer.trim() && raw?.mode === 'math') {
    suggestions.push('这次没有返回可显示的答案，请重试。');
  }
  return {
    mode: raw?.mode ?? 'local',
    kind,
    subject: String(value.subject ?? ''),
    problemText: String(value.problemText ?? value.problem ?? ''),
    studentAnswer: String(value.studentAnswer ?? value.userAnswer ?? ''),
    answer: answer || (raw?.mode === 'math' ? '没有返回可显示的数学答案。' : ''),
    steps: asStringArray(firstDefined(value, ['steps', 'solutionSteps', 'solution_steps', '解题步骤'])),
    keyIdeas: asStringArray(firstDefined(value, ['keyIdeas', 'keyideas', 'keyPoints', 'keypoints', 'key_ideas', '关键思路'])),
    knowledgePoints: asStringArray(firstDefined(value, ['knowledgePoints', 'knowledgepoints', 'knowledge_points', '知识点'])),
    scorePercent: Number.isFinite(Number(value.scorePercent))
      ? Math.max(0, Math.min(100, Number(value.scorePercent)))
      : 0,
    verdict: String(value.verdict ?? ''),
    mistakes: asStringArray(firstDefined(value, ['mistakes', 'errors', '错误'])),
    suggestions,
    question: String(value.question || value.problem || generated.question || (kind === 'generate' ? value.answer || '' : '')),
    options: Array.isArray(value.options) ? value.options.map(String) : [],
    referenceAnswer: String(value.referenceAnswer || value.correctAnswer || generated.referenceAnswer || ''),
    explanation: String(value.explanation || value.analysis || generated.explanation || ''),
  };
}

export function isMathTask(result = {}) {
  const subject = String(result.subject ?? '').trim();
  if (subject) return subject === '\u6570\u5b66';
  const text = [
    result.problemText,
    result.studentAnswer,
    result.answer,
    ...(result.steps ?? []),
    ...(result.keyIdeas ?? []),
  ].filter(Boolean).join(' ');
  return /(?:[=＋\-*/×÷^]|\d+\s*[a-zA-Z]|\b(?:x|y|sin|cos|tan|ln|log)\b|\u65b9\u7a0b|\u4e0d\u7b49\u5f0f|\u51fd\u6570|\u5206\u6570|\u51e0\u4f55)/i.test(text);
}

export function isScienceTask(result = {}) {
  return ['物理', '化学', '生物', '地理'].includes(String(result.subject ?? '').trim());
}

export function buildMathSolvePayload({ problemText = '', answerText = '', kind = 'solve' } = {}) {
  return {
    kind,
    problem: String(problemText || '').trim(),
    studentAnswer: String(answerText || '').trim(),
  };
}

export function buildScienceSolvePayload({ imageDataUrl = '', problemText = '', answerText = '', kind = 'solve' } = {}) {
  return {
    kind,
    imageDataUrl: String(imageDataUrl || ''),
    problem: String(problemText || '').trim(),
    studentAnswer: String(answerText || '').trim(),
  };
}

export function buildDemoResult(kind) {
  if (kind === 'generate') {
    return normalizeTaskResult(
      {
        mode: 'demo',
        question: '一盒彩笔原有 24 支，用去其中的 1/3 后，还剩多少支？',
        options: [],
        referenceAnswer: '16 支',
        explanation: '先求用去的数量：24 × 1/3 = 8（支）；再用总数减去用去的数量：24 - 8 = 16（支）。',
        knowledgePoints: ['分数意义', '分数乘法', '两步应用题'],
      },
      kind,
    );
  }
  if (kind === 'grade') {
    return normalizeTaskResult(
      {
        mode: 'demo',
        answer: '识别到作答过程：先计算 24 × 1/3 = 8，再计算 24 - 8 = 16。',
        steps: ['列出第一步：求用去的彩笔数量。', '列出第二步：用总数减去用去的数量。'],
        scorePercent: 92,
        verdict: '思路正确，计算结果正确。',
        mistakes: ['第二步的单位建议写成“支”。'],
        suggestions: ['应用题最后检查单位和答句。'],
        knowledgePoints: ['分数乘法', '两步应用题'],
      },
      kind,
    );
  }
  return normalizeTaskResult(
    {
      mode: 'demo',
      answer: '16 支',
      steps: ['先求用去的彩笔：24 × 1/3 = 8（支）。', '再求剩余的彩笔：24 - 8 = 16（支）。'],
      keyIdeas: ['把“用去其中的 1/3”转化为乘法。', '最后用总数减去用去的数量。'],
      knowledgePoints: ['分数乘法', '两步应用题'],
    },
    kind,
  );
}

function buildVisionPrompt(kind, promptOrOptions = '') {
  const options =
    typeof promptOrOptions === 'string'
      ? { prompt: promptOrOptions, ocrText: '' }
      : promptOrOptions ?? {};
  const ocrContext = options.ocrText
    ? `\n本地 OCR 识别结果（仅作为辅助，必须与图片互相核对）：\n${options.ocrText}\n`
    : '';
  // The science model runs only after the vision model has already read the
  // image, so the question it worked out is handed over explicitly. Without this
  // the model receives a picture plus a field list, concludes there is nothing to
  // answer, and returns every field empty -- which renders as a blank answer card.
  const problem = String(options.problem ?? '').trim();
  const studentAnswer = String(options.studentAnswer ?? '').trim();
  const problemContext = problem
    ? `\n题目原文（已从图片中读出，以此为准，不要再重新识别）：\n${problem}\n`
    : '';
  const studentContext = studentAnswer
    ? `\n学生作答（来自图片，批改时作为对照）：\n${studentAnswer}\n`
    : '';
  const expectSolution = problem
    ? kind === 'grade'
      ? '\n请务必在 answer 字段给出完整的标准解答，steps 分步说明，并填写 verdict、mistakes、suggestions，任何字段都不要留空。'
      : '\n请务必在 answer 字段给出完整解答，steps 分步说明，不要把 answer 留空。'
    : '';
  return `${buildChineseTeacherInstruction()}
请读取图片中的题目或作答内容并完成任务。先判断学科，只能填写“数学”“语文”“英语”“物理”“化学”“生物”或“地理”。
请返回 JSON，字段为 subject、problemText、studentAnswer、answer、steps、keyIdeas、knowledgePoints、scorePercent、verdict、mistakes、suggestions。subject 必须是最匹配的学科；problemText 填完整题目；studentAnswer 填图片中的作答（没有则为空）。不要输出 JSON 以外的解释。${ocrContext}${problemContext}${studentContext}${expectSolution}${options.prompt ?? ''}`;
}

// Intern-S1-mini is a reasoning model: its chat template opens a chain-of-thought
// block, and against a "reply with JSON only" prompt it spends the entire token
// budget there and returns an empty `content`. The teacher pipeline needs
// structured output, so thinking is disabled for its requests. Set
// SCIENCE_ENABLE_THINKING=1 to get the raw reasoning model behaviour instead
// (expect long waits and empty answers for the JSON tasks).
export function scienceRequestOptions(environment = process.env) {
  const wanted = String(environment.SCIENCE_ENABLE_THINKING ?? '').trim().toLowerCase();
  const configured = Number(environment.SCIENCE_MODEL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SCIENCE_TIMEOUT_MS;
  return { disableThinking: !['1', 'true', 'yes', 'on'].includes(wanted), timeoutMs };
}

// A local llama.cpp server can stay wedged on a request that it never answers:
// the port keeps accepting connections and /health keeps replying "ok", but no
// token ever comes back. Without a deadline the caller waits for undici's own
// 5-minute header timeout and the student stares at a spinner. Fail earlier with
// a message that says what happened.
const DEFAULT_SCIENCE_TIMEOUT_MS = 240000;

// The vision model is the busiest path (every solve/grade request goes through
// it) and it can wedge in exactly the same way: the request is accepted, the
// prompt is counted, and then nothing is ever processed, so no answer and no
// error ever comes back. A normal image request takes 15-25 seconds; anything
// past this deadline is a stuck server, not a slow answer.
const DEFAULT_VISION_TIMEOUT_MS = 180000;

export function visionRequestOptions(environment = process.env) {
  const configured = Number(environment.VISION_MODEL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_VISION_TIMEOUT_MS;
  return { timeoutMs };
}

// After a science failure we skip the specialised model for a while. The likely
// causes (server wedged, weights being paged out under memory pressure, GPU
// contention) do not fix themselves between two questions, and retrying means
// another multi-minute wait before the same fallback answer.
const SCIENCE_COOLDOWN_MS = (() => {
  const configured = Number(process.env.SCIENCE_COOLDOWN_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 180000;
})();

let scienceCooldown = { until: 0, reason: '' };

export function resetScienceCooldown() {
  scienceCooldown = { until: 0, reason: '' };
}

function noteScienceFailure(reason) {
  scienceCooldown = { until: Date.now() + SCIENCE_COOLDOWN_MS, reason };
}

function scienceIsCoolingDown() {
  return Date.now() < scienceCooldown.until;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(url, init);
  const controller = new AbortController();
  let timer;
  // Race instead of relying on the abort alone: a wedged server can accept the
  // connection and then never answer, and some transports ignore the signal.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`本次推理超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回（服务可能已卡住）。请重新发起；若反复出现，请重启电脑端服务。`));
    }, timeoutMs);
  });
  const pending = fetch(url, { ...init, signal: controller.signal });
  pending.catch(() => {});
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function buildLocalChatPayload(kind, payload, environment = process.env, options = {}) {
  const config = getRuntimeConfig(environment);
  const body = {
    model: config.model,
    stream: false,
    temperature: 0.2,
    max_tokens: 1800,
    messages: [
      {
        role: 'system',
        content: buildChineseTeacherInstruction(),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildVisionPrompt(kind, {
              prompt: payload.prompt,
              ocrText: payload.ocrText,
              problem: payload.problem,
              studentAnswer: payload.studentAnswer,
            }),
          },
          { type: 'image_url', image_url: { url: payload.imageDataUrl } },
        ],
      },
    ],
  };
  if (options.disableThinking) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return body;
}

export function buildScienceChatPayload(kind, payload) {
  return buildLocalChatPayload(kind, payload, {
    ...process.env,
    LOCAL_MODEL_BASE_URL: getRuntimeConfig().scienceBaseUrl,
    LOCAL_MODEL_NAME: getRuntimeConfig().scienceModel,
  }, scienceRequestOptions());
}

function hasEnglishText(result) {
  const text = [
    result.answer,
    ...result.steps,
    ...result.keyIdeas,
    ...result.knowledgePoints,
    result.verdict,
    ...result.mistakes,
    ...result.suggestions,
    result.question,
    result.referenceAnswer,
    result.explanation,
  ]
    .filter(Boolean)
    .join(' ');
  return (text.match(/\b[A-Za-z]{3,}\b/g) ?? []).length >= 2;
}

function hasUnclearImageResult(result) {
  const text = [
    result.answer,
    ...result.steps,
    ...result.keyIdeas,
    ...result.knowledgePoints,
    result.verdict,
    ...result.mistakes,
    ...result.suggestions,
  ]
    .filter(Boolean)
    .join(' ');
  return /图片内容看不清|看不清图片|无法看清|无法辨认|无法识别图片|无法识别题目|图片.*模糊|照片.*模糊/.test(
    text,
  );
}

// A specialised model can accept a request and still return nothing worth
// showing. That renders as an empty answer card, which reads as a broken app, so
// callers prefer the vision result whenever this is false.
function hasVisibleAnswer(result) {
  return [
    result.answer,
    result.verdict,
    result.explanation,
    result.question,
    result.referenceAnswer,
    ...(result.steps ?? []),
    ...(result.keyIdeas ?? []),
    ...(result.knowledgePoints ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .trim().length > 0;
}

// The vision model answers plenty of questions that it cannot actually read:
// a blurry photo, a proof, a question with no text in it. It then returns JSON
// whose every field is empty, and the student is shown a blank answer card that
// looks like a crash. Give them something actionable instead. Model names and
// routing stay out of the UI, so the wording only talks about the photo and the
// retry - never about which model ran.
const NO_VISIBLE_ANSWER_MESSAGE =
  '这次没有识别出可显示的答案。请换一张更清晰的题目照片再试一次（文字正对镜头、光线均匀、拍全题目）。';

export function ensureVisibleAnswer(result) {
  if (hasVisibleAnswer(result)) return result;
  const answer = String(result.answer ?? '').trim();
  return {
    ...result,
    answer: answer || NO_VISIBLE_ANSWER_MESSAGE,
    suggestions: [
      ...(result.suggestions ?? []),
      '如果题目比较复杂，可以勾选“深度思考”后再试一次。',
    ],
  };
}

async function requestLocalChat(kind, payload, correction = '', onStage = () => {}, environment = process.env, options = {}) {
  onStage('vision request started');
  const config = getRuntimeConfig(environment);
  const body = buildLocalChatPayload(kind, {
    ...payload,
    prompt: `${payload.prompt ?? ''}\n${correction}`.trim(),
  }, environment, options);
  const response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, options.timeoutMs);
  if (!response.ok) throw new Error(`本地模型 HTTP ${response.status}`);
  const data = await response.json();
  onStage('vision response received');
  const message = data.choices?.[0]?.message ?? {};
  // A reasoning model can answer entirely inside reasoning_content. Falling back
  // keeps the answer instead of silently returning an empty card.
  const text = String(message.content ?? '').trim() ? message.content : (message.reasoning_content ?? '');
  return parseModelJson(text);
}

async function callLocalChat(kind, payload, onStage = () => {}, environment = process.env, stageName = 'vision') {
  const first = normalizeTaskResult(
    { mode: stageName === 'vision' ? 'local' : 'science', ...(await requestLocalChat(kind, payload, '', onStage, environment, visionRequestOptions(environment))) },
    kind,
  );
  return first;
}

async function callScienceChat(kind, payload, onStage = () => {}) {
  const config = getRuntimeConfig();
  const first = normalizeTaskResult(
    { mode: 'science', ...(await requestLocalChat(kind, payload, '', onStage, {
      ...process.env,
      LOCAL_MODEL_BASE_URL: config.scienceBaseUrl,
      LOCAL_MODEL_NAME: config.scienceModel,
    }, scienceRequestOptions())) },
    kind,
  );
  return first;
}

export function buildLocalGeneratePayload(payload, environment = process.env, options = {}) {
  const config = getRuntimeConfig(environment);
  const point = payload.knowledgePointName || payload.knowledgePointId || '指定知识点';
  const prompt = `请生成一道${payload.stage}${payload.subject}的${payload.questionType}，知识点为“${point}”，难度为“${payload.difficulty}”。
请直接给出生成的题目、答案和解析。题目要适合学生练习，条件完整，答案唯一。${payload.correction ? `\n${payload.correction}` : ''}
`;
  const body = {
    model: config.model,
    stream: false,
    temperature: 0.2,
    max_tokens: 1200,
    messages: [
      { role: 'system', content: buildChineseTeacherInstruction() },
      { role: 'user', content: prompt },
    ],
  };
  if (options.disableThinking) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return body;
}

async function callLocalGenerate(payload, environment = process.env, mode = 'local', options = {}) {
  const config = getRuntimeConfig(environment);
  const response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildLocalGeneratePayload(payload, environment, options)),
  }, options.timeoutMs);
  if (!response.ok) throw new Error(`本地模型 HTTP ${response.status}`);
  const data = await response.json();
  const message = data.choices?.[0]?.message ?? {};
  const text = String(message.content ?? '').trim() ? message.content : (message.reasoning_content ?? '');
  return normalizeTaskResult(
    { mode, ...parseModelJson(text) },
    'generate',
  );
}

async function callMathService(pathname, payload, onStage = () => {}, requestJson = requestJsonNoTimeout) {
  const config = getRuntimeConfig();
  onStage(`math request started: ${pathname}`);
  const data = await requestJson(`${config.mathBaseUrl}${pathname}`, payload);
  onStage(`math response received: ${pathname}`);
  return normalizeTaskResult({ mode: 'math', ...(data.result ?? data) }, payload.kind ?? 'solve');
}

async function getMathModelStatus() {
  const config = getRuntimeConfig();
  try {
    const response = await fetch(`${config.mathBaseUrl}/math/health`);
    if (!response.ok) return { available: false, model: config.mathModel };
    const data = await response.json();
    return { ...data, model: data.model ?? config.mathModel };
  } catch {
    return { available: false, model: config.mathModel };
  }
}

// The science service exposes an OpenAI-compatible /v1/models plus a /health
// probe that additionally reports whether the weights are present, which device
// is used and whether the checkpoint was 4-bit quantized. The probe is
// optional: when it is missing we keep the plain OpenAI availability check.
async function fetchScienceHealth(config) {
  const healthUrl = `${config.scienceBaseUrl.replace(/\/v1$/, '')}/health`;
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function getScienceModelStatus() {
  const config = getRuntimeConfig();
  try {
    const response = await fetch(`${config.scienceBaseUrl}/models`);
    if (!response.ok) return { available: false, model: config.scienceModel };
    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data : [];
    if (models.length === 0) return { available: false, model: config.scienceModel, models: [] };

    const health = await fetchScienceHealth(config);
    // Weights missing -> do not even attempt a generation round trip.
    if (health && health.available === false) {
      return {
        available: false,
        model: config.scienceModel,
        models,
        device: health.device,
        missingFiles: health.missingFiles ?? [],
        error: health.error ?? '',
      };
    }
    // llama.cpp's /health reports a status string rather than a boolean, and it
    // answers before the memory-mapped weights are fully paged in.
    if (health && typeof health.status === 'string' && health.status !== 'ok') {
      return {
        available: false,
        model: config.scienceModel,
        models,
        ready: false,
        error: `science model status: ${health.status}`,
      };
    }
    return {
      available: true,
      model: config.scienceModel,
      models,
      device: health?.device,
      dtype: health?.dtype,
      quantized: Boolean(health?.quantized),
      ready: Boolean(health?.ready),
    };
  } catch {
    return { available: false, model: config.scienceModel, models: [] };
  }
}

export async function getModelStatus() {
  const config = getRuntimeConfig();
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
    });
    if (!response.ok) return { available: false, model: config.model, runtime: config.runtime };
    const data = await response.json();
    const models = Array.isArray(data.data)
      ? data.data.map((item) => item.id).filter(Boolean)
      : [];
    return {
      available: models.length > 0,
      model: config.model,
      runtime: config.runtime,
      models,
    };
  } catch {
    return { available: false, model: config.model, runtime: config.runtime, models: [] };
  }
}

export async function runVisionTask(kind, payload, { onStage = () => {}, mathRequest = requestJsonNoTimeout } = {}) {
  onStage('checking vision model');
  const status = await getModelStatus();
  if (!status.available || !payload.imageDataUrl) throw new Error('本地模型不可用或未提供图片。');
  const vision = await callLocalChat(kind, { ...payload, ocrText: '' }, onStage);
  onStage(`vision classified subject: ${vision.subject || 'unknown'}`);

  // 未勾选深度思考时，语文、英语、数学和自然科学都沿用 Qwen3-VL 的结果。
  if (!payload.deepThink) {
    onStage('deep thinking not selected; using vision result');
    return ensureVisibleAnswer({ ...vision, mode: 'local-vision' });
  }

  // 勾选深度思考且识别为自然科学（物理、化学、生物、地理）时，交给 Intern-S1-mini。
  // 回退必须完全静默：学生端不应看到「用了哪个模型」或「模型挂了」的痕迹，
  // 拿到的就是一份完整可用的解答。诊断信息只写进服务端日志（onStage）。
  if (isScienceTask(vision)) {
    onStage('science task detected');
    if (scienceIsCoolingDown()) {
      onStage(`science model cooling down: ${scienceCooldown.reason}`);
      return ensureVisibleAnswer({ ...vision, mode: 'local-vision' });
    }
    const scienceStatus = await getScienceModelStatus();
    onStage(`science model available: ${scienceStatus.available}`);
    if (!scienceStatus.available) return ensureVisibleAnswer({ ...vision, mode: 'local-vision' });
    try {
      const science = await callScienceChat(kind, buildScienceSolvePayload({
        imageDataUrl: payload.imageDataUrl,
        problemText: vision.problemText || vision.answer,
        answerText: vision.studentAnswer,
        kind,
      }), onStage);
      if (hasVisibleAnswer(science)) return science;
      // The model replied but left every field empty. Showing that would be worse
      // than the answer the vision model already produced.
      onStage('science model returned no visible answer; using vision result');
      return ensureVisibleAnswer({ ...vision, mode: 'local-vision' });
    } catch (error) {
      // The 8B science model can legitimately fail: weights still downloading,
      // not enough RAM for the first load, a wedged llama.cpp server, or a slow
      // first-load timeout. Losing the vision answer the student already has
      // would be worse, so fall back - and stop calling it for a while so the
      // next question is answered immediately instead of waiting again.
      onStage(`science model failed; falling back to vision: ${error.message}`);
      noteScienceFailure(error.message);
      return ensureVisibleAnswer({ ...vision, mode: 'local-vision' });
    }
  }

  // 勾选深度思考但不属于自然科学时，只有数学会交给 Qwen2.5-Math。
  if (!isMathTask(vision)) {
    onStage('non-math result returned from vision model');
    return ensureVisibleAnswer({ ...vision, mode: 'local-vision' });
  }
  onStage('math task detected');
  const mathStatus = await getMathModelStatus();
  onStage(`math model available: ${mathStatus.available}`);
  if (!mathStatus.available) return ensureVisibleAnswer({ ...vision, mode: 'local-vision' });
  return await callMathService('/math/solve', buildMathSolvePayload({
    problemText: vision.problemText || vision.answer,
    answerText: vision.studentAnswer,
    kind,
  }), onStage, mathRequest);
}

export async function generateQuestion(payload) {
  if (payload.subject === '\u6570\u5b66') {
    const mathStatus = await getMathModelStatus();
    if (mathStatus.available) {
      return await callMathService('/math/generate', { kind: 'generate', ...payload });
    }
  }
  if (['物理', '化学', '生物', '地理'].includes(payload.subject)) {
    const scienceStatus = await getScienceModelStatus();
    if (scienceStatus.available) {
      return await callLocalGenerate(payload, {
        ...process.env,
        LOCAL_MODEL_BASE_URL: getRuntimeConfig().scienceBaseUrl,
        LOCAL_MODEL_NAME: getRuntimeConfig().scienceModel,
      }, 'science', scienceRequestOptions());
    }
  }
  const status = await getModelStatus();
  if (!status.available) throw new Error('本地模型不可用。');
  return await callLocalGenerate(payload, process.env, 'local', visionRequestOptions());
}
