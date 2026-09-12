import test from 'node:test';
import assert from 'node:assert/strict';
import { beginHeartbeatJsonResponse, finishHeartbeatJsonResponse } from './response-utils.mjs';

function fakeResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    write(chunk) { this.chunks.push(String(chunk)); },
    end(chunk = '') { if (chunk) this.chunks.push(String(chunk)); this.writableEnded = true; },
  };
}

test('long JSON responses send legal whitespace heartbeats before the final result', async () => {
  const response = fakeResponse();
  const stop = beginHeartbeatJsonResponse(response, { intervalMs: 10 });
  assert.equal(response.status, 200);
  assert.equal(response.chunks.join(''), ' ');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(response.chunks.length >= 2);
  stop();
  finishHeartbeatJsonResponse(response, { result: { answer: 'x=2' } });
  assert.deepEqual(JSON.parse(response.chunks.join('')), { result: { answer: 'x=2' } });
  assert.equal(response.writableEnded, true);
});
