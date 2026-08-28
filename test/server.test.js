import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAuth } from '../src/token-store.js';
import { createBridgeServer } from '../src/server.js';
import { STATIC_FALLBACK_MODELS } from '../src/models.js';
import { VERSION } from '../src/upstream.js';

const TEXT_SSE = [
  { type: 'response.output_text.delta', delta: 'Hello' },
  { type: 'response.output_text.delta', delta: ' world' },
  { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
  { type: 'response.completed', response: { id: 'resp_text', object: 'response', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
];

const TOOL_SSE = [
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' } },
  { type: 'response.completed', response: { id: 'resp_tool', object: 'response', status: 'completed', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
];

const REASONING_TOOL_SSE = [
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-reasoning', summary: [] } },
  ...TOOL_SSE,
];

const EARLY_EOF_SSE = [
  { type: 'response.output_text.delta', delta: 'partial' },
];

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

let bridge;
let base;
let tmpDir;
let lastUpstream;
let nextEvents;
let nextResponseFactory;

async function fetchImpl(url, options = {}) {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('/codex/models')) {
    return new Response(JSON.stringify({ error: { message: 'offline catalog fixture' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!pathname.endsWith('/codex/responses')) throw new Error(`Unexpected offline fetch: ${url}`);

  lastUpstream = {
    headers: Object.fromEntries(new Headers(options.headers)),
    body: JSON.parse(options.body),
    signal: options.signal,
  };
  if (nextResponseFactory) {
    const factory = nextResponseFactory;
    nextResponseFactory = undefined;
    return factory(options);
  }
  const events = nextEvents ?? (lastUpstream.body.tools ? TOOL_SSE : TEXT_SSE);
  nextEvents = undefined;
  return new Response(sse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-server-test-'));
  process.env.KGB_HOME = tmpDir;
  saveAuth({ access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600_000, accountId: 'acct_1', email: 'u@example.com', planType: 'pro' });

  bridge = createBridgeServer({ sessionId: 'sess-test', fetchImpl });
  await listen(bridge);
  base = `http://127.0.0.1:${bridge.address().port}`;
});

test.after(async () => {
  await close(bridge);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KGB_HOME;
});

function post(pathname, body, { headers = {}, rawBody } = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer kimi-gpt-bridge',
      ...headers,
    },
    body: rawBody ?? JSON.stringify(body),
  });
}

function postChat(body, options) {
  return post('/v1/chat/completions', body, options);
}

function postResponses(body, options) {
  return post('/v1/responses', body, options);
}

function parseSseData(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data:') && !block.includes('[DONE]'))
    .map((block) => JSON.parse(block.slice(5)));
}

function rawHttpRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1', () => socket.end(request));
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

function postInChunks(port, pathname, chunks) {
  return new Promise((resolve, reject) => {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        authorization: 'Bearer kimi-gpt-bridge',
        'content-type': 'application/json',
        'content-length': length,
      },
    }, (res) => {
      const responseChunks = [];
      res.on('data', (chunk) => responseChunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(responseChunks).toString('utf8') }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('streaming chat completion yields chunk sequence, usage and [DONE]', async () => {
  const res = await postChat({ model: 'gpt-5.4-high', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  const chunks = parseSseData(text);

  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.deepEqual(chunks.map((chunk) => chunk.choices[0].delta.content).filter(Boolean), ['Hello', ' world']);
  assert.deepEqual(chunks.map((chunk) => chunk.choices[0].delta.reasoning_content).filter(Boolean), ['thinking']);
  const last = chunks.at(-1);
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.deepEqual(last.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

  assert.equal(lastUpstream.body.model, 'gpt-5.4');
  assert.deepEqual(lastUpstream.body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(lastUpstream.body.store, false);
  assert.equal(lastUpstream.body.stream, true);
  assert.equal(lastUpstream.body.prompt_cache_key, 'sess-test');
  assert.equal(lastUpstream.headers['chatgpt-account-id'], 'acct_1');
  assert.equal(lastUpstream.headers.authorization, 'Bearer test-access');
  assert.equal(lastUpstream.headers.originator, 'kimi-gpt-bridge');
  assert.equal(lastUpstream.headers['session-id'], 'sess-test');
  assert.equal(lastUpstream.headers['x-client-request-id'], 'sess-test');
  assert.equal(lastUpstream.signal.aborted, false);
});

test('chat defaults to non-streaming and stream:false also returns JSON', async () => {
  for (const stream of [undefined, false]) {
    const request = { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] };
    if (stream !== undefined) request.stream = stream;
    const res = await postChat(request);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Hello world');
    assert.equal(body.choices[0].message.reasoning_content, 'thinking');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  }
});

test('tool calls stream as a complete tool_call chunk with finish_reason tool_calls', async () => {
  const res = await postChat({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } } }],
    stream: true,
  });
  const chunks = parseSseData(await res.text());
  const toolChunk = chunks.find((chunk) => chunk.choices[0].delta.tool_calls);
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls, [
    { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
  ]);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(lastUpstream.body.tools, [
    { type: 'function', name: 'get_weather', description: 'd', parameters: { type: 'object' }, strict: false },
  ]);
});

test('Responses defaults to JSON and stream:false aggregates the terminal response', async () => {
  for (const stream of [undefined, false]) {
    const request = { model: 'gpt-5.4', input: 'hi' };
    if (stream !== undefined) request.stream = stream;
    const res = await postResponses(request);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), TEXT_SSE.at(-1).response);
    assert.equal(lastUpstream.body.store, false);
    assert.equal(lastUpstream.body.stream, true);
    assert.deepEqual(lastUpstream.body.include, ['reasoning.encrypted_content']);
  }
});

test('Responses stream:true passes SSE through after observing a terminal event', async () => {
  const expected = sse(TEXT_SSE);
  const res = await postResponses({ model: 'gpt-5.4', input: 'hi', stream: true, include: ['message.output_text.logprobs'] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(await res.text(), expected);
  assert.deepEqual(lastUpstream.body.include, ['message.output_text.logprobs', 'reasoning.encrypted_content']);
});

test('Responses streaming emits complete frames only and drops data after the terminal frame', async () => {
  const terminal = sse([
    { type: 'response.output_text.delta', delta: 'complete' },
    { type: 'response.completed', response: { id: 'resp_terminal', status: 'completed' } },
  ]);
  const chunkings = [
    [terminal + 'data: [DONE]\n\n'],
    [terminal.slice(0, -5), `${terminal.slice(-5)}da`, 'ta: [DONE]\n\n'],
  ];

  for (const chunks of chunkings) {
    let cancelled = false;
    nextResponseFactory = () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const res = await postResponses({ model: 'gpt-5.4', input: 'hi', stream: true });
    assert.equal(await res.text(), terminal);
    assert.equal(cancelled, true);
  }
});

test('Responses streaming accepts a complete terminal event without a final blank line', async () => {
  const terminal = `data: ${JSON.stringify({
    type: 'response.completed',
    response: { id: 'resp_terminal_eof', status: 'completed' },
  })}`;
  nextResponseFactory = () => new Response(terminal, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const res = await postResponses({ model: 'gpt-5.4', input: 'hi', stream: true });
  assert.equal(await res.text(), terminal);
});

test('streaming waits for drain after response backpressure', async () => {
  const originalEmit = bridge.emit;
  let forcedBackpressure = false;
  let observedDrain = false;
  bridge.emit = function emit(event, req, res) {
    if (event === 'request' && req.url === '/v1/responses') {
      const originalWrite = res.write.bind(res);
      res.write = (chunk, ...args) => {
        const writable = originalWrite(chunk, ...args);
        if (!forcedBackpressure) {
          forcedBackpressure = true;
          setTimeout(() => {
            observedDrain = true;
            res.emit('drain');
          }, 20);
          return false;
        }
        return writable;
      };
    }
    return originalEmit.call(this, event, req, res);
  };

  try {
    const res = await postResponses({ model: 'gpt-5.4', input: 'hi', stream: true });
    assert.equal(await res.text(), sse(TEXT_SSE));
    assert.equal(forcedBackpressure, true);
    assert.equal(observedDrain, true);
  } finally {
    bridge.emit = originalEmit;
  }
});

test('generation routes require the exact bearer key and JSON media type', async () => {
  for (const pathname of ['/v1/chat/completions', '/v1/responses']) {
    const missing = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 401);

    const wrong = await post(pathname, {}, { headers: { authorization: 'Bearer anything' } });
    assert.equal(wrong.status, 401);

    const mediaType = await post(pathname, {}, { headers: { 'content-type': 'text/plain' } });
    assert.equal(mediaType.status, 415);
  }
});

test('malformed JSON and malformed request URLs return 400', async () => {
  for (const pathname of ['/v1/chat/completions', '/v1/responses']) {
    const malformedJson = await post(pathname, null, { rawBody: '{"broken":' });
    assert.equal(malformedJson.status, 400);
    assert.equal((await malformedJson.json()).error.code, 'invalid_json');
  }

  const response = await rawHttpRequest(
    bridge.address().port,
    'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
  );
  assert.match(response, /^HTTP\/1\.1 400 Bad Request\r\n/);
  assert.match(response, /"code":"invalid_url"/);
});

test('request bodies are byte-limited and UTF-8 is decoded only after buffering', async () => {
  const limited = createBridgeServer({ sessionId: 'limited', fetchImpl, maxBodyBytes: 32 });
  await listen(limited);
  try {
    const limitedBase = `http://127.0.0.1:${limited.address().port}`;
    for (const pathname of ['/v1/chat/completions', '/v1/responses']) {
      const tooLarge = await fetch(`${limitedBase}${pathname}`, {
        method: 'POST',
        headers: { authorization: 'Bearer kimi-gpt-bridge', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'too large' }] }),
      });
      assert.equal(tooLarge.status, 413);
      assert.equal((await tooLarge.json()).error.code, 'request_too_large');
    }
  } finally {
    await close(limited);
  }

  const raw = Buffer.from(JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: '你好' }] }));
  const split = raw.indexOf(Buffer.from('你')) + 1;
  const response = await postInChunks(bridge.address().port, '/v1/chat/completions', [raw.subarray(0, split), raw.subarray(split)]);
  assert.equal(response.status, 200);
  assert.equal(lastUpstream.body.input[0].content[0].text, '你好');
});

test('reasoning cache keys prefer x-kimi-session-id, then x-session-id', async () => {
  const toolRequest = {
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
  };
  const continuation = {
    model: 'gpt-5.4',
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    ],
  };

  nextEvents = REASONING_TOOL_SSE;
  await (await postChat({ ...toolRequest, stream: true }, { headers: { 'x-session-id': 'secondary' } })).text();
  await (await postChat(continuation, { headers: { 'x-session-id': 'secondary' } })).json();
  assert.equal(lastUpstream.body.input.find((item) => item.type === 'reasoning').encrypted_content, 'encrypted-reasoning');

  nextEvents = REASONING_TOOL_SSE;
  await (await postChat(toolRequest, { headers: { 'x-kimi-session-id': 'primary', 'x-session-id': 'secondary' } })).json();
  await (await postChat(continuation, { headers: { 'x-session-id': 'secondary' } })).json();
  assert.equal(lastUpstream.body.input.some((item) => item.type === 'reasoning'), false);
  await (await postChat(continuation, { headers: { 'x-kimi-session-id': 'primary', 'x-session-id': 'other' } })).json();
  assert.equal(lastUpstream.body.input.find((item) => item.type === 'reasoning').encrypted_content, 'encrypted-reasoning');
});

test('headerless reasoning fallback survives interleaved requests and isolates identical call ids by turn prefix', async () => {
  const request = (topic) => ({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: topic }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
  });
  const continuation = (topic) => ({
    model: 'gpt-5.4',
    messages: [
      { role: 'user', content: topic },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ],
  });
  const reasoningEvents = (encryptedContent) => [
    { type: 'response.output_item.done', item: { type: 'reasoning', id: `rs_${encryptedContent}`, encrypted_content: encryptedContent, summary: [] } },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' } },
    { type: 'response.completed', response: { id: `resp_${encryptedContent}`, status: 'completed' } },
  ];

  nextEvents = reasoningEvents('reasoning-a');
  await (await postChat(request('topic-a'))).json();
  await (await postChat({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'unrelated topic-b' }] })).json();
  await (await postChat(continuation('topic-a'))).json();
  assert.equal(lastUpstream.body.input.find((item) => item.type === 'reasoning').encrypted_content, 'reasoning-a');

  nextEvents = reasoningEvents('reasoning-a-same-call');
  await (await postChat(request('prefix-a'))).json();
  nextEvents = reasoningEvents('reasoning-b-same-call');
  await (await postChat(request('prefix-b'))).json();
  await (await postChat(continuation('prefix-a'))).json();
  assert.equal(lastUpstream.body.input.find((item) => item.type === 'reasoning').encrypted_content, 'reasoning-a-same-call');
  await (await postChat(continuation('prefix-b'))).json();
  assert.equal(lastUpstream.body.input.find((item) => item.type === 'reasoning').encrypted_content, 'reasoning-b-same-call');
});

test('early chat EOF is 502 for JSON and an SSE error without [DONE] for streams', async () => {
  nextEvents = EARLY_EOF_SSE;
  const nonStreaming = await postChat({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(nonStreaming.status, 502);
  assert.equal((await nonStreaming.json()).error.type, 'upstream_error');

  nextEvents = EARLY_EOF_SSE;
  const streaming = await postChat({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(streaming.status, 200);
  const text = await streaming.text();
  assert.doesNotMatch(text, /data: \[DONE\]/);
  const events = parseSseData(text);
  assert.equal(events.at(-1).error.type, 'upstream_error');
  assert.match(events.at(-1).error.message, /terminal response event/);
});

test('early Responses EOF is 502 for JSON and emits a Responses error event after headers', async () => {
  nextEvents = EARLY_EOF_SSE;
  const nonStreaming = await postResponses({ model: 'gpt-5.4', input: 'hi', stream: false });
  assert.equal(nonStreaming.status, 502);
  assert.equal((await nonStreaming.json()).error.type, 'upstream_error');

  nextEvents = EARLY_EOF_SSE;
  const streaming = await postResponses({ model: 'gpt-5.4', input: 'hi', stream: true });
  assert.equal(streaming.status, 200);
  const events = parseSseData(await streaming.text());
  assert.equal(events[0].type, 'response.output_text.delta');
  assert.deepEqual(Object.keys(events.at(-1)).sort(), ['code', 'message', 'type']);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).code, null);
  assert.match(events.at(-1).message, /terminal response event/);
});

test('downstream response close aborts the in-flight upstream call', async () => {
  let resolveAborted;
  const aborted = new Promise((resolve) => { resolveAborted = resolve; });
  nextResponseFactory = ({ signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([{ type: 'response.output_text.delta', delta: 'partial' }])));
      signal.addEventListener('abort', () => {
        resolveAborted();
        controller.error(new Error('aborted by bridge'));
      }, { once: true });
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: bridge.address().port,
      path: '/v1/responses',
      method: 'POST',
      headers: { authorization: 'Bearer kimi-gpt-bridge', 'content-type': 'application/json' },
    }, (res) => {
      res.once('data', () => {
        res.destroy();
        resolve();
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'gpt-5.4', input: 'hi', stream: true }));
  });

  await Promise.race([
    aborted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream signal was not aborted')), 1000)),
  ]);
  assert.equal(lastUpstream.signal.aborted, true);
});

test('GET models and health remain available without generation headers', async () => {
  const models = await fetch(`${base}/v1/models`);
  assert.equal(models.status, 200);
  const catalog = await models.json();
  assert.equal(catalog.object, 'list');
  assert.deepEqual(catalog.data.map((model) => model.id), STATIC_FALLBACK_MODELS.map((model) => model.slug));
  assert.equal(catalog.data[0].object, 'model');
  assert.equal(catalog.data[0].owned_by, 'openai');

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: 'kimi-gpt-bridge',
    version: VERSION,
    pid: process.pid,
    port: bridge.address().port,
    authed: true,
    accountId: 'acct_1',
    planType: 'pro',
    email: 'u@example.com',
  });
});

test('unknown routes return an OpenAI-style error', async () => {
  const res = await fetch(`${base}/v1/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.type, 'invalid_request_error');
});
