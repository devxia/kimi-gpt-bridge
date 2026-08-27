// Loopback-only OpenAI-compatible HTTP server.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  chatRequestToResponsesBody,
  parseResponsesSSE,
  createChatChunkStream,
  collectChatCompletion,
  readChunks,
} from './translate.js';
import { callUpstream, upstreamError } from './upstream.js';
import { loadAuth, kgbHome } from './token-store.js';
import { getModelIds } from './models.js';

const MODEL_CREATED = 1750000000;

export function getPort() {
  return Number(process.env.KGB_PORT || 1456);
}

async function readRequestBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sendError(res, err) {
  const status = err?.status ?? (err?.message?.includes('Not logged in') ? 401 : 500);
  sendJson(res, status, {
    error: {
      message: err?.message ?? 'Internal bridge error',
      type: err?.type ?? 'server_error',
      code: err?.code ?? null,
    },
  });
}

// One uuid per server process, reused for prompt-cache stickiness.
export function createBridgeServer({ sessionId = crypto.randomUUID(), fetchImpl, log = () => {} } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    log(`${req.method} ${url.pathname}`);
    try {
      // Any Authorization header value is accepted: the server binds to
      // loopback only, so the key is a placeholder for client compatibility.
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const chatReq = JSON.parse(await readRequestBody(req));
        const responsesBody = chatRequestToResponsesBody(chatReq, { promptCacheKey: sessionId });
        const upstream = await callUpstream(responsesBody, { sessionId, fetchImpl });

        if (chatReq.stream === false) {
          const completion = await collectChatCompletion(parseResponsesSSE(upstream.body), responsesBody.model);
          sendJson(res, 200, completion);
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        try {
          for await (const chunk of createChatChunkStream(parseResponsesSSE(upstream.body), responsesBody.model)) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
        } catch (err) {
          log(`stream error: ${err.message}`);
          res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error', code: null } })}\n\n`);
        }
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const body = JSON.parse(await readRequestBody(req));
        const include = new Set([...(Array.isArray(body.include) ? body.include : []), 'reasoning.encrypted_content']);
        const passthrough = { ...body, store: false, stream: true, include: [...include] };
        const upstream = await callUpstream(passthrough, { sessionId, fetchImpl });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for await (const chunk of readChunks(upstream.body)) res.write(chunk);
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const ids = await getModelIds({ fetchImpl });
        sendJson(res, 200, {
          object: 'list',
          data: ids.map((id) => ({ id, object: 'model', created: MODEL_CREATED, owned_by: 'openai' })),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        const auth = loadAuth();
        const health = { ok: true, authed: Boolean(auth) };
        if (auth?.accountId) health.accountId = auth.accountId;
        if (auth?.planType) health.planType = auth.planType;
        if (auth?.email) health.email = auth.email;
        sendJson(res, 200, health);
        return;
      }

      sendJson(res, 404, { error: { message: `Unknown route: ${req.method} ${url.pathname}`, type: 'invalid_request_error', code: null } });
    } catch (err) {
      log(`error: ${err.message}`);
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  });
}

// Foreground server used by the `serve` subcommand: manages the pid file and log.
export async function startServer({ port = getPort(), sessionId, fetchImpl } = {}) {
  fs.mkdirSync(kgbHome(), { recursive: true, mode: 0o700 });
  const logStream = fs.createWriteStream(path.join(kgbHome(), 'server.log'), { flags: 'a' });
  const log = (line) => logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  const server = createBridgeServer({ sessionId, fetchImpl, log });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const pidFile = path.join(kgbHome(), 'server.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  log(`listening on 127.0.0.1:${port} (pid ${process.pid})`);

  const shutdown = () => {
    server.close(() => {
      try { fs.rmSync(pidFile); } catch { /* best effort */ }
      log('stopped');
      logStream.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, log };
}

export { upstreamError };
