const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 37921;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const logsDirectory = path.resolve(__dirname, '..', 'logs');
const sessionTimestamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const logPath = path.join(logsDirectory, `gmgn-diagnostic-${sessionTimestamp}-${process.pid}.ndjson`);

function getLogPath() {
  return logPath;
}

function getLogSize() {
  try {
    return fs.statSync(logPath).size;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function respond(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  response.end(JSON.stringify(body));
}

function normalizeEntries(payload) {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({ collectorTs: Date.now(), ...entry }));
}

fs.mkdirSync(logsDirectory, { recursive: true });

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    respond(response, 204, {});
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    respond(response, 200, {
      ok: true,
      logPath: getLogPath(),
      bytes: getLogSize(),
      maxBytes: MAX_LOG_BYTES
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/log') {
    respond(response, 404, { ok: false, error: 'not_found' });
    return;
  }

  let body = '';
  let bodyBytes = 0;
  let tooLarge = false;
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    bodyBytes += Buffer.byteLength(chunk);
    if (bodyBytes > MAX_BODY_BYTES) {
      tooLarge = true;
      return;
    }
    body += chunk;
  });
  request.on('end', () => {
    if (tooLarge) {
      respond(response, 413, { ok: false, error: 'payload_too_large' });
      return;
    }
    try {
      const entries = normalizeEntries(JSON.parse(body));
      if (entries.length === 0) {
        respond(response, 400, { ok: false, error: 'empty_payload' });
        return;
      }
      const lines = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
      const appendBytes = Buffer.byteLength(lines, 'utf8');
      if (getLogSize() + appendBytes > MAX_LOG_BYTES) {
        respond(response, 507, { ok: false, error: 'log_size_limit_reached' });
        return;
      }
      fs.appendFileSync(getLogPath(), lines, 'utf8');
      respond(response, 200, { ok: true, written: entries.length });
    } catch (error) {
      respond(response, 400, {
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  });
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`[GMGN diagnostic] http://${HOST}:${PORT} 已有日志收集器运行，无需重复启动。`);
    console.error(`[GMGN diagnostic] 可打开 http://${HOST}:${PORT}/health 查看当前日志文件。`);
    process.exitCode = 1;
    return;
  }
  console.error('[GMGN diagnostic] server error:', error);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`[GMGN diagnostic] listening on http://${HOST}:${PORT}`);
  console.log(`[GMGN diagnostic] writing to ${getLogPath()}`);
  console.log(`[GMGN diagnostic] max file size ${MAX_LOG_BYTES / 1024 / 1024} MB; press Ctrl+C to stop`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
