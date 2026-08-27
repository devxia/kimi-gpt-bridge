import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelAndEffort,
  chatRequestToResponsesBody,
  parseResponsesSSE,
  createChatChunkStream,
  collectChatCompletion,
} from '../src/translate.js';

test('system and developer messages become instructions, not input', () => {
  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'developer', content: 'Use RFC 2119.' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(body.instructions, 'Be terse.\n\nUse RFC 2119.');
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].role, 'user');
});

test('instructions fall back to a default when no system message exists', () => {
  const body = chatRequestToResponsesBody({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.instructions, 'You are a helpful assistant.');
});

test('user text and image parts convert to input_text / input_image', () => {
  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });
  assert.deepEqual(body.input[0].content, [
    { type: 'input_text', text: 'what is this?' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
  ]);
});

test('assistant text and tool calls become message + function_call items', () => {
  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: { temp: 62 } },
    ],
  });
  assert.deepEqual(body.input[0], {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Let me check.' }],
    status: 'completed',
  });
  assert.deepEqual(body.input[1], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '{"city":"SF"}',
  });
  assert.deepEqual(body.input[2], {
    type: 'function_call_output',
    call_id: 'call_1',
    output: '{"temp":62}',
  });
});

test('tools flatten to Responses function tools with strict:false', () => {
  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [],
    tools: [
      {
        type: 'function',
        function: { name: 'f', description: 'does f', parameters: { type: 'object', properties: {} } },
      },
    ],
  });
  assert.deepEqual(body.tools, [
    { type: 'function', name: 'f', description: 'does f', parameters: { type: 'object', properties: {} }, strict: false },
  ]);
});

test('base body shape: store/stream/text/include/tool_choice and no max_tokens', () => {
  const body = chatRequestToResponsesBody(
    { model: 'gpt-5.4', messages: [], max_tokens: 100, max_completion_tokens: 100 },
    { promptCacheKey: 'sess-1' },
  );
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.text, { verbosity: 'low' });
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(body.prompt_cache_key, 'sess-1');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, true);
  assert.equal('max_tokens' in body, false);
  assert.equal('max_completion_tokens' in body, false);
});

test('model name suffix parses effort; explicit reasoning_effort wins', () => {
  assert.deepEqual(parseModelAndEffort('gpt-5.4-high'), { model: 'gpt-5.4', effort: 'high' });
  assert.deepEqual(parseModelAndEffort('gpt-5.4-mini'), { model: 'gpt-5.4-mini', effort: undefined });

  const fromSuffix = chatRequestToResponsesBody({ model: 'gpt-5.4-xhigh', messages: [] });
  assert.equal(fromSuffix.model, 'gpt-5.4');
  assert.deepEqual(fromSuffix.reasoning, { effort: 'xhigh', summary: 'auto' });

  const explicit = chatRequestToResponsesBody({ model: 'gpt-5.4-high', messages: [], reasoning_effort: 'low' });
  assert.deepEqual(explicit.reasoning, { effort: 'low', summary: 'auto' });

  const none = chatRequestToResponsesBody({ model: 'gpt-5.4', messages: [] });
  assert.equal('reasoning' in none, false);
});

function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
}

async function collect(stream) {
  const out = [];
  for await (const item of stream) out.push(item);
  return out;
}

test('SSE event sequence translates to chat chunks with usage and stop', async () => {
  const events = parseResponsesSSE(
    sse([
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking ' },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' world' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]),
  );
  const chunks = await collect(createChatChunkStream(events, 'gpt-5.4'));
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' });
  assert.deepEqual(chunks[1].choices[0].delta, { reasoning_content: 'thinking ' });
  assert.deepEqual(chunks[2].choices[0].delta, { content: 'Hello' });
  assert.deepEqual(chunks[3].choices[0].delta, { content: ' world' });
  const last = chunks.at(-1);
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.deepEqual(last.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('function_call output_item.done emits a complete tool_call chunk', async () => {
  const events = parseResponsesSSE(
    sse([
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'f', arguments: '{"a":1}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
    ]),
  );
  const chunks = await collect(createChatChunkStream(events, 'gpt-5.4'));
  const toolChunk = chunks.find((c) => c.choices[0].delta.tool_calls);
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls, [
    { index: 0, id: 'call_9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
  ]);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('response.incomplete maps to finish_reason length', async () => {
  const events = parseResponsesSSE(sse([{ type: 'response.incomplete', response: {} }]));
  const chunks = await collect(createChatChunkStream(events, 'gpt-5.4'));
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'length');
});

test('response.failed and error events throw', async () => {
  const failed = collect(createChatChunkStream(parseResponsesSSE(sse([{ type: 'response.failed', response: { error: { message: 'boom' } } }])), 'm'));
  await assert.rejects(failed, /boom/);
  const errored = collect(createChatChunkStream(parseResponsesSSE(sse([{ type: 'error', message: 'stream died' }])), 'm'));
  await assert.rejects(errored, /stream died/);
});

test('non-stream aggregation builds one chat.completion', async () => {
  const events = parseResponsesSSE(
    sse([
      { type: 'response.reasoning_summary_text.delta', delta: 'because ' },
      { type: 'response.output_text.delta', delta: 'Hi' },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ]),
  );
  const completion = await collectChatCompletion(events, 'gpt-5.4');
  assert.equal(completion.object, 'chat.completion');
  const msg = completion.choices[0].message;
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, 'Hi');
  assert.equal(msg.reasoning_content, 'because ');
  assert.deepEqual(msg.tool_calls, [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }]);
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(completion.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
});

test('SSE parser handles events split across chunks', async () => {
  async function* fragmented() {
    yield 'data: {"type":"response.output_text.delta","del';
    yield 'ta":"x"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
  }
  const chunks = await collect(createChatChunkStream(parseResponsesSSE(fragmented()), 'gpt-5.4'));
  assert.deepEqual(chunks[1].choices[0].delta, { content: 'x' });
  assert.equal(chunks.at(-1).usage.total_tokens, 2);
});
