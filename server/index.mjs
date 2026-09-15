import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnectionInfo } from './network.mjs';
import {
  findKnowledgePoint,
  getKnowledgePoints,
  intersectQuestionTypes,
  resolveQuestionType,
} from './knowledge-points.mjs';
import { expandGeneratePlan } from './generate-plan.mjs';
import { generateQuestion, generateRequestOptions, getMathModelStatus, getModelStatus, runVisionTask } from './model-adapter.mjs';
import { createTask, getTaskSnapshot } from './task-store.mjs';
import {
  logQueryRecord,
  initDbTransport,
  queryHistory,
  queryHistoryResult,
  queryIpStats,
  queryRecords,
} from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const clientDist = path.join(rootDir, 'dist');
const port = Number(process.env.PORT ?? 8787);
const maxBodySize = 12 * 1024 * 1024;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function requestLog(id, message) {
  console.log('request ' + id + ' ' + message);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBodySize) {
        reject(new Error('请求图片过大，请压缩后重试。'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('请求格式不是有效 JSON。'));
      }
    });
    request.on('error', reject);
  });
}

function validateImagePayload(payload) {
  if (!payload?.imageDataUrl || typeof payload.imageDataUrl !== 'string') {
    throw new Error('请先上传一张题目或作答照片。');
  }
  if (!payload.imageDataUrl.startsWith('data:image/')) {
    throw new Error('只支持图片格式。');
  }
}

function normalizeClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  const raw = request.socket?.remoteAddress ?? 'unknown';
  return raw.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
}

// 出题可以选多个知识点（高中复合知识点，需求 3）。题型必须落在这些知识点的
// 白名单交集里；不合法就静默回落到交集首项，绝不把自相矛盾的要求丢给模型。
function resolveGenerationPoints(payload = {}) {
  const ids = (Array.isArray(payload.knowledgePointIds) ? payload.knowledgePointIds : [payload.knowledgePointId])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  const points = ids.map((id) => findKnowledgePoint(id)).filter(Boolean);
  if (!points.length) throw new Error('请选择有效的知识点。');
  const allowed = intersectQuestionTypes(points);
  return {
    points,
    questionType: resolveQuestionType({ questionTypes: allowed }, payload.questionType),
  };
}

function batchConcurrency() {
  const configured = Number(process.env.GENERATE_BATCH_CONCURRENCY);
  if (Number.isFinite(configured) && configured > 0) return Math.min(4, Math.floor(configured));
  // 单机 llama.cpp 默认只有一个 slot，并发只会排队并把超时叠起来，所以默认串行。
  return 1;
}

// 批量出题用 NDJSON 流式回传：一道题一出结果，学生能看到「第 x/N 道」的进度，
// 而不是盯着一个转圈等十分钟（需求 10）。
async function streamGenerateBatch(request, response, payload) {
  const plan = expandGeneratePlan(payload, getKnowledgePoints(), {});
  const total = plan.items.length;
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  request.on('close', () => { closed = true; });
  const write = (chunk) => {
    if (closed || response.writableEnded) return;
    response.write(`${JSON.stringify(chunk)}\n`);
  };

  write({ type: 'plan', total, errors: plan.errors });

  const startedAt = Date.now();
  const clientIp = normalizeClientIp(request);
  const stage = String(payload.stage ?? '').trim();
  const subject = String(payload.subject ?? '').trim();
  // 整卷默认走快通道：专用数学服务单题 5-14 分钟，一张卷子会变成一小时以上。
  const useSpecialized = String(process.env.GENERATE_BATCH_USE_SPECIALIZED ?? '') === '1';
  const itemTimeoutMs = Number(process.env.GENERATE_BATCH_ITEM_TIMEOUT_MS ?? 240000);
  const results = new Array(total).fill(null);
  let cursor = 0;
  let failed = 0;

  const worker = async () => {
    while (!closed) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      const item = plan.items[index];
      try {
        const result = await generateQuestion(
          {
            stage,
            subject,
            knowledgePointId: item.knowledgePointIds[0],
            knowledgePointNames: item.knowledgePointNames,
            questionType: item.questionType,
            difficulty: item.difficulty,
          },
          { useSpecialized, timeoutMs: itemTimeoutMs },
        );
        results[index] = result;
        write({
          type: 'question',
          index: index + 1,
          total,
          questionType: item.questionType,
          difficulty: item.difficulty,
          knowledgePointNames: item.knowledgePointNames,
          result,
        });
      } catch (error) {
        failed += 1;
        write({
          type: 'failed',
          index: index + 1,
          total,
          questionType: item.questionType,
          knowledgePointNames: item.knowledgePointNames,
          message: String(error?.message ?? error),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(batchConcurrency(), total) }, () => worker()));

  const questions = results.map((result, index) => ({
    ...(result ?? {}),
    order: index + 1,
    questionType: plan.items[index].questionType,
    difficulty: plan.items[index].difficulty,
    knowledgePointNames: plan.items[index].knowledgePointNames,
  })).filter((item) => item.question || item.referenceAnswer || item.answer);
  const durationMs = Date.now() - startedAt;

  if (questions.length) {
    logQueryRecord({
      clientIp,
      kind: 'generate',
      subject: subject || null,
      stage: stage || null,
      questionText: `批量出题：${questions.length} 道 · ${stage}${subject} · ${[...new Set(plan.items.map((item) => item.questionType))].join('/')}`,
      modelMode: 'local',
      modelCalls: { kind: 'generate', batch: true, total, failed },
      durationMs,
      result: { batch: true, total, failed, questions },
    });
  }

  write({ type: 'done', total, succeeded: questions.length, failed, durationMs });
  if (!response.writableEnded) response.end();
}

async function routeApi(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/health') {
    const model = await getModelStatus();
    // 数学服务有两种跑法（PyTorch 服务 / llama.cpp），探测方式不同，交给适配层判断。
    const mathModel = await getMathModelStatus();
    let scienceModel = { available: false, model: process.env.SCIENCE_MODEL_NAME ?? 'Intern-S1-mini' };
    try {
      const scienceResponse = await fetch(`${process.env.SCIENCE_MODEL_BASE_URL ?? 'http://127.0.0.1:8100/v1'}/models`);
      if (scienceResponse.ok) {
        const data = await scienceResponse.json();
        const models = Array.isArray(data.data) ? data.data.map((item) => item.id).filter(Boolean) : [];
        scienceModel = {
          available: models.length > 0,
          model: process.env.SCIENCE_MODEL_NAME ?? 'Intern-S1-mini',
          models,
        };
      }
    } catch {}
    return sendJson(response, 200, {
      ok: true,
      service: 'ai-teacher-lan',
      model,
      mathModel,
      scienceModel,
      connection: getConnectionInfo(port),
    });
  }
  if (request.method === 'GET' && pathname === '/api/knowledge-points') {
    return sendJson(response, 200, { items: getKnowledgePoints() });
  }
  if (request.method === 'POST' && ['/api/solve', '/api/grade'].includes(pathname)) {
    const requestId = randomUUID().slice(0, 8);
    requestLog(requestId, request.method + ' ' + pathname + ' started');
    const payload = await readJson(request);
    requestLog(requestId, 'image body read (' + Buffer.byteLength(payload.imageDataUrl ?? '', 'utf8') + ' bytes)');
    validateImagePayload(payload);
    const kind = pathname.endsWith('/grade') ? 'grade' : 'solve';
    const clientIp = normalizeClientIp(request);
    const startedAt = Date.now();
    const stages = [];
    const task = createTask(async () => {
      try {
        const result = await runVisionTask(kind, payload, {
          onStage: (stage) => {
            stages.push(stage);
            requestLog(requestId, stage);
          },
        });
        stages.push('completed');
        logQueryRecord({
          clientIp,
          kind,
          subject: payload.subject ?? result.subject ?? null,
          stage: payload.stage ?? null,
          questionText: payload.problemText || result.problemText || '(图片中未识别出题目文本)',
          modelMode: result.mode ?? null,
          modelCalls: { requestId, kind, stages },
          durationMs: Date.now() - startedAt,
          result,
        });
        requestLog(requestId, 'completed (' + JSON.stringify(result).length + ' bytes)');
        return result;
      } catch (error) {
        requestLog(requestId, 'failed: ' + (error.stack || error.message || error));
        throw error;
      }
    });
    requestLog(requestId, 'queued task ' + task.id);
    return sendJson(response, 202, { taskId: task.id, status: 'running' });
  }
  if (request.method === 'GET' && pathname.startsWith('/api/tasks/')) {
    const taskId = pathname.slice('/api/tasks/'.length);
    const snapshot = getTaskSnapshot(taskId);
    if (!snapshot) return sendJson(response, 404, { error: '任务不存在，可能是电脑端服务刚刚重启。' });
    return sendJson(response, 200, snapshot);
  }
  if (request.method === 'POST' && pathname === '/api/generate') {
    const payload = await readJson(request);
    const { points, questionType } = resolveGenerationPoints(payload);
    const startedAt = Date.now();
    const result = await generateQuestion({
      ...payload,
      knowledgePointName: points.map((point) => point.name).join('、'),
      knowledgePointNames: points.map((point) => point.name),
      questionType,
    });
    logQueryRecord({
      clientIp: normalizeClientIp(request),
      kind: 'generate',
      subject: points[0].subject ?? null,
      stage: points[0].stage ?? null,
      questionText: `出题：${points.map((point) => point.name).join('、')} · ${questionType}`,
      modelMode: result?.mode ?? null,
      modelCalls: { kind: 'generate' },
      durationMs: Date.now() - startedAt,
      result,
    });
    return sendJson(response, 200, { result, questionType, knowledgePointNames: points.map((point) => point.name) });
  }
  if (request.method === 'POST' && pathname === '/api/generate/batch') {
    const payload = await readJson(request);
    return await streamGenerateBatch(request, response, payload);
  }
  if (request.method === 'GET' && pathname === '/api/history') {
    const url = new URL(request.url, 'http://localhost');
    const clientIp = normalizeClientIp(request);
    // 默认只看本机（这个浏览器所在设备）的记录，避免把局域网里别人的题也翻出来。
    const scope = (url.searchParams.get('scope') ?? 'self').toLowerCase();
    const ip = scope === 'all' ? (url.searchParams.get('ip') ?? '').trim() : clientIp;
    const result = await queryHistory({
      ip,
      kind: (url.searchParams.get('kind') ?? '').trim(),
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 20),
    });
    return sendJson(response, 200, { ...result, clientIp, scope });
  }
  if (request.method === 'GET' && pathname.startsWith('/api/history/')) {
    const id = Number(pathname.slice('/api/history/'.length));
    if (!Number.isFinite(id) || id <= 0) return sendJson(response, 400, { error: '记录编号无效。' });
    const result = await queryHistoryResult(id);
    if (!result) return sendJson(response, 404, { error: '这条记录没有可回看的结果，可能产生于本次升级之前。' });
    return sendJson(response, 200, { id, result });
  }
  if (request.method === 'GET' && pathname === '/api/admin/records') {
    const url = new URL(request.url, 'http://localhost');
    const result = await queryRecords({
      ip: (url.searchParams.get('ip') ?? '').trim(),
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 20),
    });
    return sendJson(response, 200, result);
  }
  if (request.method === 'GET' && pathname === '/api/admin/ips') {
    return sendJson(response, 200, { items: await queryIpStats() });
  }
  return sendJson(response, 404, { error: '接口不存在。' });
}

function serveAdminPage(response, pathname) {
  if (pathname !== '/admin' && pathname !== '/admin/') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  const adminFile = path.join(__dirname, 'admin', 'admin.html');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  fs.createReadStream(adminFile).pipe(response);
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(path.join(clientDist, requested));
  if (!safePath.startsWith(clientDist) || !fs.existsSync(safePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  const extension = path.extname(safePath);
  const contentType =
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    }[extension] ?? 'application/octet-stream';
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': pathname === '/' || pathname === '/index.html'
      ? 'no-store'
      : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(safePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await routeApi(request, response, url.pathname);
      return;
    }
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      serveAdminPage(response, url.pathname);
      return;
    }
    serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 400, { error: error.message || '请求失败。' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`AI Teacher server listening on ${port}`);
  for (const url of getConnectionInfo(port).urls) console.log(`LAN: ${url}`);
  initDbTransport().catch(() => {});
});
