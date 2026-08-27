import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAuth } from '../src/token-store.js';
import { createBridgeServer } from '../src/server.js';
import { STATIC_FALLBACK_MODELS } from '../src/models.js';

const TEXT_SSE = [
  { type: 'response.output_text.delta', delta: 'Hello' },
  { type: 'response.output_text.delta', delta: ' world' },
  { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
  { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
];

const TOOL_SSE = [
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' } },
  { type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

let upstream;
let bridge;
let base;
let tmpDir;
let lastUpstream; // { headers, body } captured by the mock

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/codex/responses') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastUpstream = { headers: req.headers, body: JSON.parse(raw) };
        const events = lastUpstream.body.tools ? TOOL_SSE : TEXT_SSE;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(upstream);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-server-test-'));
  process.env.KGB_HOME = tmpDir;
  process.env.KGB_UPSTREAM_BASE = `http://127.0.0.1:${upstream.address().port}`;
  saveAuth({ access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600_000, accountId: 'acct_1', email: 'u@example.com', planType: 'pro' });

  bridge = createBridgeServer({ sessionId: 'sess-test' });
  await listen(bridge);
  base = `http://127.0.0.1:${bridge.address().port}`;
});

test.after(async () => {
  bridge.close();
  upstream.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KGB_HOME;
  delete process.env.KGB_UPSTREAM_BASE;
});

function postChat(body) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
    body: JSON.stringify(body),
  });
}

test('streaming chat completion yields chunk sequence, usage and [DONE]', async () => {
  const res = await postChat({ model: 'gpt-5.4-high', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  const chunks = text
    .split('\n\n')
    .filter((b) => b.startsWith('data:') && !b.includes('[DONE]'))
    .map((b) => JSON.parse(b.slice(5)));

  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const contents = chunks.map((c) => c.choices[0].delta.content).filter(Boolean);
  assert.deepEqual(contents, ['Hello', ' world']);
  const reasoning = chunks.map((c) => c.choices[0].delta.reasoning_content).filter(Boolean);
  assert.deepEqual(reasoning, ['thinking']);
  const last = chunks.at(-1);
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.deepEqual(last.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

  // The upstream request was translated and authenticated correctly.
  assert.equal(lastUpstream.body.model, 'gpt-5.4'); // -high suffix stripped
  assert.deepEqual(lastUpstream.body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(lastUpstream.body.store, false);
  assert.equal(lastUpstream.body.stream, true);
  assert.equal(lastUpstream.body.prompt_cache_key, 'sess-test');
  assert.equal(lastUpstream.headers['chatgpt-account-id'], 'acct_1');
  assert.equal(lastUpstream.headers.authorization, 'Bearer test-access');
  assert.equal(lastUpstream.headers.originator, 'kimi-gpt-bridge');
  assert.equal(lastUpstream.headers['session-id'], 'sess-test');
  assert.equal(lastUpstream.headers['x-client-request-id'], 'sess-test');
});

test('non-streaming chat completion aggregates into one JSON object', async () => {
  const res = await postChat({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: false });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Hello world');
  assert.equal(body.choices[0].message.reasoning_content, 'thinking');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('tool calls stream as a complete tool_call chunk with finish_reason tool_calls', async () => {
  const res = await postChat({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } } }],
    stream: true,
  });
  const text = await res.text();
  const chunks = text
    .split('\n\n')
    .filter((b) => b.startsWith('data:') && !b.includes('[DONE]'))
    .map((b) => JSON.parse(b.slice(5)));
  const toolChunk = chunks.find((c) => c.choices[0].delta.tool_calls);
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls, [
    { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
  ]);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(lastUpstream.body.tools, [
    { type: 'function', name: 'get_weather', description: 'd', parameters: { type: 'object' }, strict: false },
  ]);
});

test('GET /v1/models falls back to the static catalog when the live fetch fails', async () => {
  // The mock upstream has no /codex/models route (404), so the static list is served.
  const res = await fetch(`${base}/v1/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'list');
  assert.deepEqual(
    body.data.map((m) => m.id),
    STATIC_FALLBACK_MODELS.map((m) => m.slug),
  );
  assert.equal(body.data[0].object, 'model');
  assert.equal(body.data[0].owned_by, 'openai');
});

test('GET /health reports auth state and account info', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, authed: true, accountId: 'acct_1', planType: 'pro', email: 'u@example.com' });
});

test('unknown routes return an OpenAI-style error', async () => {
  const res = await fetch(`${base}/v1/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.type, 'invalid_request_error');
});
