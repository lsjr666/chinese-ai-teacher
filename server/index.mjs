import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnectionInfo } from './network.mjs';
import { findKnowledgePoint, getKnowledgePoints } from './knowledge-points.mjs';
import { generateQuestion, getModelStatus, runVisionTask } from './model-adapter.mjs';
import { createTask, getTaskSnapshot } from './task-store.mjs';
import { logQueryRecord, initDbTransport, queryRecords, queryIpStats } from './db.mjs';

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

async function routeApi(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/health') {
    const model = await getModelStatus();
    let mathModel = { available: false, model: process.env.MATH_MODEL_NAME ?? 'Qwen2.5-Math-7B-Instruct' };
    try {
      const mathResponse = await fetch(`${process.env.MATH_MODEL_BASE_URL ?? 'http://127.0.0.1:8090'}/math/health`);
      if (mathResponse.ok) mathModel = await mathResponse.json();
    } catch {}
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
    const point = findKnowledgePoint(payload.knowledgePointId);
    if (!point) throw new Error('请选择有效的知识点。');
    const startedAt = Date.now();
    const result = await generateQuestion({
      ...payload,
      knowledgePointName: point.name,
    });
    logQueryRecord({
      clientIp: normalizeClientIp(request),
      kind: 'generate',
      subject: point.subject ?? null,
      stage: point.stage ?? null,
      questionText: `出题：${point.name}`,
      modelMode: result?.mode ?? null,
      modelCalls: { kind: 'generate' },
      durationMs: Date.now() - startedAt,
    });
    return sendJson(response, 200, { result });
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
