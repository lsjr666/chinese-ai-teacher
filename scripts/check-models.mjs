#!/usr/bin/env node
/**
 * Smoke-test the three local model services.
 *
 *   node scripts/check-models.mjs
 *   node scripts/check-models.mjs --prompt "一个物体受 10 N 的力，质量 2 kg，求加速度"
 *
 * The first form only probes reachability, which is what you want before starting
 * the app. Passing --prompt additionally sends a real generation round trip to the
 * science model so you can see whether Intern-S1-mini actually answers, and how
 * long a deep-thinking request takes on this machine.
 *
 * On Windows a Chinese --prompt survives the trip through the console badly, so
 * SCIENCE_CHECK_PROMPT is read as well and is the safer way to pass one:
 *
 *   $env:SCIENCE_CHECK_PROMPT = '一个物体受 10 N 的力，质量 2 kg，求加速度'
 *   node scripts/check-models.mjs
 */

const VISION = process.env.LOCAL_MODEL_BASE_URL ?? 'http://127.0.0.1:8080/v1';
const MATH = process.env.MATH_MODEL_BASE_URL ?? 'http://127.0.0.1:8090';
const SCIENCE = process.env.SCIENCE_MODEL_BASE_URL ?? 'http://127.0.0.1:8100/v1';
const SCIENCE_NAME = process.env.SCIENCE_MODEL_NAME ?? 'Intern-S1-mini';
const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 30000);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function getJson(url, timeout = TIMEOUT_MS) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function origin(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/, '');
}

async function checkVision() {
  const data = await getJson(`${VISION}/models`);
  const models = (data.data ?? []).map((item) => item.id).filter(Boolean);
  return { ok: models.length > 0, detail: models.join(', ') || 'no model reported' };
}

async function checkMath() {
  const data = await getJson(`${MATH}/math/health`);
  return {
    ok: Boolean(data.available),
    detail: `${data.model ?? 'unknown'} ready=${Boolean(data.ready)}`,
  };
}

async function checkScience() {
  // llama.cpp answers {"status":"ok"} while the Python service answers
  // {"available":true,...}; accept either.
  let health = null;
  try {
    health = await getJson(`${origin(SCIENCE)}/health`);
  } catch {
    health = null;
  }
  const data = await getJson(`${SCIENCE}/models`);
  const models = (data.data ?? []).map((item) => item.id).filter(Boolean);
  const healthy = health?.available === true
    || (typeof health?.status === 'string' && health.status === 'ok')
    || Boolean(health?.ready);
  const detail = [
    models.join(', ') || 'no model reported',
    health?.device ? `device=${health.device}` : '',
    health?.status ? `status=${health.status}` : '',
  ].filter(Boolean).join(' ');
  return { ok: models.length > 0 && healthy, detail };
}

async function askScience(prompt) {
  const body = {
    model: SCIENCE_NAME,
    stream: false,
    temperature: 0.2,
    max_tokens: 700,
    // Mirrors server/model-adapter.mjs: without this the reasoning model spends
    // the whole budget in reasoning_content and returns an empty content.
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: '你是一个理科老师，请给出简洁准确的解答。' },
      { role: 'user', content: prompt },
    ],
  };
  const started = Date.now();
  const response = await fetch(`${SCIENCE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.SCIENCE_REQUEST_TIMEOUT_MS ?? 600000)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  const message = data.choices?.[0]?.message ?? {};
  const usage = data.usage ?? {};
  const seconds = (Date.now() - started) / 1000;
  const tokens = usage.completion_tokens ?? 0;
  return {
    text: String(message.content ?? '').trim() || String(message.reasoning_content ?? '').trim(),
    reasoningLength: String(message.reasoning_content ?? '').length,
    seconds,
    tokens,
    rate: seconds > 0 && tokens ? (tokens / seconds).toFixed(1) : '?',
  };
}

const targets = [
  ['vision  Qwen3-VL-4B', VISION, checkVision],
  ['math    Qwen2.5-Math-7B', MATH, checkMath],
  ['science Intern-S1-mini', SCIENCE, checkScience],
];

let failures = 0;
for (const [label, url, probe] of targets) {
  try {
    const { ok, detail } = await probe();
    if (!ok) failures += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(24)} ${url.padEnd(30)} ${detail}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label.padEnd(24)} ${url.padEnd(30)} ${error.message}`);
  }
}

const prompt = argument('--prompt') ?? process.env.SCIENCE_CHECK_PROMPT;
if (prompt) {
  console.log('');
  console.log(`science prompt: ${prompt}`);
  try {
    const result = await askScience(prompt);
    console.log(`took ${result.seconds.toFixed(1)}s for ${result.tokens} tokens (~${result.rate} tok/s)`);
    console.log('---');
    console.log(result.text);
  } catch (error) {
    failures += 1;
    console.log(`science request failed: ${error.message}`);
  }
}

process.exit(failures > 0 ? 1 : 0);
