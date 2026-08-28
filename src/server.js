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
import { callUpstream, upstreamError, VERSION } from './upstream.js';
import { loadAuth, kgbHome } from './token-store.js';
import { getModelIds } from './models.js';

const SERVICE = 'kimi-gpt-bridge';
const MODEL_CREATED = 1750000000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const BRIDGE_AUTHORIZATION = 'Bearer kimi-gpt-bridge';
const TERMINAL_RESPONSE_EVENTS = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
]);

export function getPort() {
  return Number(process.env.KGB_PORT || 1456);
}

function bridgeError(status, message, type = 'invalid_request_error', code = null) {
  const err = new Error(message);
  err.status = status;
  err.type = type;
  err.code = code;
  return err;
}

function upstreamStreamError(err) {
  const wrapped = bridgeError(502, err?.message || 'Invalid upstream response stream', 'upstream_error');
  wrapped.cause = err;
  return wrapped;
}

function readRequestBody(req, maxBodyBytes) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    req.resume();
    return Promise.reject(bridgeError(413, `Request body exceeds ${maxBodyBytes} bytes`, 'invalid_request_error', 'request_too_large'));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (err, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) req.resume();
      reject(err);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        fail(bridgeError(413, `Request body exceeds ${maxBodyBytes} bytes`, 'invalid_request_error', 'request_too_large'), true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes).toString('utf8'));
    };
    const onError = (err) => fail(err);
    const onAborted = () => fail(bridgeError(400, 'Request body was aborted', 'invalid_request_error', 'request_aborted'));

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

async function readJsonBody(req, maxBodyBytes) {
  const raw = await readRequestBody(req, maxBodyBytes);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw bridgeError(400, `Malformed JSON body: ${err.message}`, 'invalid_request_error', 'invalid_json');
  }
}

function sendJson(res, status, obj, headers = undefined) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function errorBody(err, defaultType = 'server_error') {
  return {
    error: {
      message: err?.message ?? 'Internal bridge error',
      type: err?.type ?? defaultType,
      code: err?.code ?? null,
    },
  };
}

function sendError(res, err) {
  const status = err?.status ?? (err?.message?.includes('Not logged in') ? 401 : 500);
  sendJson(res, status, errorBody(err));
}

function requireGenerationHeaders(req) {
  if (req.headers.authorization !== BRIDGE_AUTHORIZATION) {
    throw bridgeError(401, 'Invalid Authorization header', 'authentication_error', 'invalid_api_key');
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw bridgeError(415, 'Content-Type must be application/json', 'invalid_request_error', 'unsupported_media_type');
  }
}

function requestHeader(req, name) {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : undefined;
}

function reasoningTurnPrefix(messages) {
  if (!Array.isArray(messages)) return [];
  const assistantIndex = messages.findLastIndex((message) => message?.role === 'assistant');
  if (assistantIndex < 0) return messages;
  const toolCalls = Array.isArray(messages[assistantIndex]?.tool_calls)
    ? messages[assistantIndex].tool_calls
    : [];
  const callIds = new Set(toolCalls.map((toolCall) => toolCall?.id).filter(Boolean));
  const toolOutputs = messages.slice(assistantIndex + 1);
  const outputIds = new Set(toolOutputs.map((message) => message?.tool_call_id).filter(Boolean));
  const adjacentToolContinuation =
    callIds.size > 0 &&
    toolOutputs.length > 0 &&
    toolOutputs.every((message) => message?.role === 'tool') &&
    callIds.size === outputIds.size &&
    [...callIds].every((callId) => outputIds.has(callId));
  return adjacentToolContinuation ? messages.slice(0, assistantIndex) : messages;
}

function reasoningCacheKey(req, sessionId, messages) {
  const headerKey = requestHeader(req, 'x-kimi-session-id') ?? requestHeader(req, 'x-session-id');
  if (headerKey) return headerKey;
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(reasoningTurnPrefix(messages)))
    .digest('hex');
  return JSON.stringify([sessionId, digest]);
}

function clientDisconnectedError() {
  const err = new Error('Client disconnected');
  err.code = 'ERR_CLIENT_DISCONNECTED';
  return err;
}

function waitForDrain(res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation(value);
    };
    const onDrain = () => finish(resolve);
    const onClose = () => finish(reject, clientDisconnectedError());
    const onError = (err) => finish(reject, err);

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (res.destroyed || res.writableEnded) onClose();
  });
}

async function writeResponse(res, chunk) {
  if (res.destroyed || res.writableEnded) throw clientDisconnectedError();
  if (!res.write(chunk)) await waitForDrain(res);
}

function sseData(rawEvent) {
  const dataLines = [];
  for (const line of rawEvent.split(/\r\n|\r|\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.length ? dataLines.join('\n') : undefined;
}

function isTerminalResponseEvent(rawEvent) {
  const data = sseData(rawEvent);
  if (data == null || data === '[DONE]') return false;
  let event;
  try {
    event = JSON.parse(data);
  } catch (err) {
    throw upstreamStreamError(err);
  }
  return TERMINAL_RESPONSE_EVENTS.has(event?.type);
}

async function* validateResponsesStream(stream) {
  let buffer = '';
  for await (const chunk of readChunks(stream)) {
    buffer += chunk;
    for (;;) {
      const separator = buffer.match(/\r\n\r\n|\r\r|\n\n/);
      if (!separator) break;
      const frameEnd = separator.index + separator[0].length;
      const rawEvent = buffer.slice(0, separator.index);
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd);
      const terminal = isTerminalResponseEvent(rawEvent);
      yield frame;
      if (terminal) return;
    }
  }
  if (buffer && isTerminalResponseEvent(buffer)) {
    yield buffer;
    return;
  }
  throw upstreamStreamError(new Error('Upstream stream ended before a terminal response event'));
}

async function collectResponse(events) {
  for await (const event of events) {
    if (TERMINAL_RESPONSE_EVENTS.has(event?.type)) {
      if (event.response && typeof event.response === 'object') return event.response;
      throw upstreamStreamError(new Error(`Upstream ${event.type} event omitted its response`));
    }
    if (event?.type === 'error') {
      throw upstreamStreamError(new Error(event.message || 'Upstream stream error'));
    }
  }
  throw upstreamStreamError(new Error('Upstream stream ended before a terminal response event'));
}

async function sendSseError(res, err, format) {
  if (res.destroyed || res.writableEnded) return;
  const body = format === 'responses'
    ? { type: 'error', message: err?.message ?? 'Internal bridge error', code: err?.code ?? null }
    : errorBody(err, 'upstream_error');
  await writeResponse(res, `data: ${JSON.stringify(body)}\n\n`);
}

function endResponse(res) {
  if (!res.destroyed && !res.writableEnded) res.end();
}

// One uuid per server process, reused for upstream prompt-cache stickiness.
export function createBridgeServer({
  sessionId = crypto.randomUUID(),
  fetchImpl,
  log = () => {},
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new TypeError('maxBodyBytes must be a non-negative safe integer');
  }

  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    let streamErrorFormat = 'chat';
    const abortIfIncomplete = () => {
      if (!res.writableFinished && !controller.signal.aborted) controller.abort();
    };
    req.once('aborted', abortIfIncomplete);
    res.once('close', abortIfIncomplete);

    try {
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        throw bridgeError(400, 'Malformed request URL', 'invalid_request_error', 'invalid_url');
      }
      log(`${req.method} ${url.pathname}`);

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        requireGenerationHeaders(req);
        const chatReq = await readJsonBody(req, maxBodyBytes);
        const cacheKey = reasoningCacheKey(req, sessionId, chatReq.messages);
        const translateOptions = { promptCacheKey: sessionId, reasoningCacheKey: cacheKey };
        const responsesBody = chatRequestToResponsesBody(chatReq, translateOptions);
        const upstream = await callUpstream(responsesBody, {
          sessionId,
          fetchImpl,
          signal: controller.signal,
        });
        const streamOptions = { reasoningCacheKey: cacheKey };

        if (chatReq.stream !== true) {
          let completion;
          try {
            completion = await collectChatCompletion(
              parseResponsesSSE(upstream.body),
              responsesBody.model,
              streamOptions,
            );
          } catch (err) {
            throw upstreamStreamError(err);
          }
          sendJson(res, 200, completion);
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for await (const chunk of createChatChunkStream(
          parseResponsesSSE(upstream.body),
          responsesBody.model,
          streamOptions,
        )) {
          await writeResponse(res, `data: ${JSON.stringify(chunk)}\n\n`);
        }
        await writeResponse(res, 'data: [DONE]\n\n');
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        streamErrorFormat = 'responses';
        requireGenerationHeaders(req);
        const body = await readJsonBody(req, maxBodyBytes);
        const include = new Set([...(Array.isArray(body.include) ? body.include : []), 'reasoning.encrypted_content']);
        const passthrough = { ...body, store: false, stream: true, include: [...include] };
        const upstream = await callUpstream(passthrough, {
          sessionId,
          fetchImpl,
          signal: controller.signal,
        });

        if (body.stream !== true) {
          let response;
          try {
            response = await collectResponse(parseResponsesSSE(upstream.body));
          } catch (err) {
            throw err?.status === 502 ? err : upstreamStreamError(err);
          }
          sendJson(res, 200, response);
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for await (const chunk of validateResponsesStream(upstream.body)) {
          await writeResponse(res, chunk);
        }
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
        const address = server.address();
        const health = {
          ok: true,
          service: 'kimi-gpt-bridge',
          version: VERSION,
          pid: process.pid,
          port: address && typeof address === 'object' ? address.port : getPort(),
          authed: Boolean(auth),
        };
        if (auth?.accountId) health.accountId = auth.accountId;
        if (auth?.planType) health.planType = auth.planType;
        if (auth?.email) health.email = auth.email;
        sendJson(res, 200, health);
        return;
      }

      sendJson(res, 404, { error: { message: `Unknown route: ${req.method} ${url.pathname}`, type: 'invalid_request_error', code: null } });
    } catch (err) {
      log(`error: ${err.message}`);
      if (controller.signal.aborted && (req.aborted || res.destroyed)) return;
      if (!res.headersSent) {
        sendError(res, err);
      } else {
        try {
          await sendSseError(res, err, streamErrorFormat);
        } catch (streamErr) {
          log(`stream error: ${streamErr.message}`);
        }
        endResponse(res);
      }
    } finally {
      req.off('aborted', abortIfIncomplete);
      res.off('close', abortIfIncomplete);
    }
  });

  return server;
}

function atomicWriteFile(file, content, mode) {
  const existingMode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined;
  const targetMode = mode ?? existingMode ?? 0o600;
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(tmp, content, { mode: targetMode });
    fs.chmodSync(tmp, targetMode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

function removeOwnedPidRecord(pidFile, expected) {
  try {
    const current = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (
      current?.service === expected.service &&
      current?.pid === expected.pid &&
      current?.port === expected.port
    ) {
      fs.rmSync(pidFile);
      return true;
    }
  } catch {
    // Missing, replaced, or invalid records are not owned by this process.
  }
  return false;
}

// Foreground server used by the `serve` subcommand: owns its port-scoped PID record and log.
export async function startServer({ port = getPort(), sessionId, fetchImpl } = {}) {
  fs.mkdirSync(kgbHome(), { recursive: true, mode: 0o700 });
  const logStream = fs.createWriteStream(path.join(kgbHome(), 'server.log'), { flags: 'a' });
  const log = (line) => logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  const server = createBridgeServer({ sessionId, fetchImpl, log });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  const pidFile = path.join(kgbHome(), `server-${actualPort}.pid`);
  const record = {
    service: SERVICE,
    version: VERSION,
    pid: process.pid,
    port: actualPort,
    startedAt: new Date().toISOString(),
  };
  atomicWriteFile(pidFile, JSON.stringify(record, null, 2), 0o600);
  log(`listening on 127.0.0.1:${actualPort} (pid ${process.pid})`);

  let shuttingDown = false;
  const cleanup = () => removeOwnedPidRecord(pidFile, record);
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      cleanup();
      log('stopped');
      logStream.end(() => process.exit(0));
    });
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 2000).unref();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, log, pidFile, record };
}

export { upstreamError };
