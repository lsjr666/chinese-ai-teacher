export function beginHeartbeatJsonResponse(response, { intervalMs = 15000 } = {}) {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
  });
  response.write(' ');
  const timer = setInterval(() => {
    if (!response.writableEnded && !response.destroyed) response.write(' ');
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function finishHeartbeatJsonResponse(response, body) {
  if (response.writableEnded || response.destroyed) return;
  response.end(JSON.stringify(body));
}
