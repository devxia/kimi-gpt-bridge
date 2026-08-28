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

test('malformed non-array tool_calls are ignored instead of throwing', () => {
  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [
      { role: 'assistant', content: 'x', tool_calls: 'oops' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ],
  });
  assert.equal(body.input.length, 2);
  assert.equal(body.input[0].type, 'message');
  assert.equal(body.input[1].type, 'function_call_output');
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

test('tool choice, parallel calls, and function strictness are preserved', () => {
  for (const toolChoice of ['none', 'auto', 'required']) {
    const body = chatRequestToResponsesBody({ model: 'gpt-5.4', messages: [], tool_choice: toolChoice });
    assert.equal(body.tool_choice, toolChoice);
  }

  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [],
    tool_choice: { type: 'function', function: { name: 'only_this' } },
    parallel_tool_calls: false,
    tools: [
      {
        type: 'function',
        function: {
          name: 'only_this',
          description: 'the only tool',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
      },
    ],
  });
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'only_this' });
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tools[0].strict, true);
});

test('max is accepted as a model suffix and explicit reasoning effort', () => {
  assert.deepEqual(parseModelAndEffort('gpt-5.4-max'), { model: 'gpt-5.4', effort: 'max' });
  assert.deepEqual(
    chatRequestToResponsesBody({ model: 'gpt-5.4', messages: [], reasoning_effort: 'max' }).reasoning,
    { effort: 'max', summary: 'auto' },
  );
});

test('image detail and tool text content parts are preserved', () => {
  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png', detail: 'high' } }],
      },
      { role: 'tool', tool_call_id: 'call_text', content: [{ type: 'text', text: 'first' }, { type: 'text', text: ' second' }] },
    ],
  });
  assert.deepEqual(body.input[0].content, [
    { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'high' },
  ]);
  assert.equal(body.input[1].output, 'first second');
});

test('SSE parser accepts fragmented CRLF and multiline data fields', async () => {
  async function* fragmented() {
    yield 'data: {"type":\r';
    yield '\ndata: "response.output_text.delta","delta":"crlf"}\r';
    yield '\n\r\ndata: {"type":"response.completed","response":{}}\r\n\r\n';
  }
  const chunks = await collect(createChatChunkStream(parseResponsesSSE(fragmented()), 'gpt-5.4'));
  assert.deepEqual(chunks[1].choices[0].delta, { content: 'crlf' });
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
});

test('an upstream EOF before a terminal response event throws', async () => {
  const events = parseResponsesSSE(sse([{ type: 'response.output_text.delta', delta: 'partial' }]));
  await assert.rejects(
    collect(createChatChunkStream(events, 'gpt-5.4')),
    /ended before a terminal response event/i,
  );
});

test('refusal and incomplete details are preserved', async () => {
  const refusal = await collectChatCompletion(
    parseResponsesSSE(sse([
      { type: 'response.refusal.delta', delta: 'not allowed' },
      { type: 'response.completed', response: {} },
    ])),
    'gpt-5.4',
  );
  assert.equal(refusal.choices[0].message.refusal, 'not allowed');

  const incomplete = await collectChatCompletion(
    parseResponsesSSE(sse([
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'content_filter' } },
      },
    ])),
    'gpt-5.4',
  );
  assert.equal(incomplete.choices[0].finish_reason, 'content_filter');
  assert.equal(incomplete.choices[0].incomplete_reason, 'content_filter');
});

test('ending chat translation early cancels the upstream ReadableStream', async () => {
  let canceled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{}}\n\n'));
    },
    cancel() {
      canceled = true;
    },
  });
  await collect(createChatChunkStream(parseResponsesSSE(stream), 'gpt-5.4'));
  assert.equal(canceled, true);
});

test('encrypted reasoning round-trips through the chat response field', async () => {
  const completion = await collectChatCompletion(
    parseResponsesSSE(sse([
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ciphertext-1' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_reasoned', name: 'lookup', arguments: '{}' },
      },
      { type: 'response.completed', response: {} },
    ])),
    'gpt-5.4',
    { reasoningCacheKey: 'round-trip' },
  );

  assert.deepEqual(completion.choices[0].message.reasoning_items, [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'ciphertext-1',
      call_ids: ['call_reasoned'],
    },
  ]);

  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [
      completion.choices[0].message,
      { role: 'tool', tool_call_id: 'call_reasoned', content: 'result' },
    ],
  });
  assert.deepEqual(body.input[0], {
    type: 'reasoning',
    id: 'rs_1',
    summary: [],
    encrypted_content: 'ciphertext-1',
  });
  assert.equal(body.input[1].type, 'function_call');
  assert.equal(body.input[2].type, 'function_call_output');
});

test('assistant text precedes accurately associated reasoning and function call groups', () => {
  const assistant = {
    role: 'assistant',
    content: 'I found two steps.',
    reasoning_items: [
      { type: 'reasoning', id: 'rs_first', encrypted_content: 'cipher-first', call_ids: ['call_a', 'call_b'] },
      { type: 'reasoning', id: 'rs_second', encrypted_content: 'cipher-second', call_ids: ['call_c'] },
    ],
    tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'first', arguments: '{}' } },
      { id: 'call_b', type: 'function', function: { name: 'parallel', arguments: '{}' } },
      { id: 'call_c', type: 'function', function: { name: 'second', arguments: '{}' } },
    ],
  };
  const body = chatRequestToResponsesBody({
    model: 'gpt-5.4',
    messages: [
      assistant,
      { role: 'tool', tool_call_id: 'call_a', content: 'a' },
      { role: 'tool', tool_call_id: 'call_b', content: 'b' },
      { role: 'tool', tool_call_id: 'call_c', content: 'c' },
    ],
  });

  assert.deepEqual(body.input.slice(0, 6).map((item) => item.type), [
    'message',
    'reasoning',
    'function_call',
    'function_call',
    'reasoning',
    'function_call',
  ]);
  assert.equal(body.input[0].content[0].text, 'I found two steps.');
  assert.equal(body.input[1].encrypted_content, 'cipher-first');
  assert.deepEqual(body.input.slice(2, 4).map((item) => item.call_id), ['call_a', 'call_b']);
  assert.equal(body.input[4].encrypted_content, 'cipher-second');
  assert.equal(body.input[5].call_id, 'call_c');
});

test('output item order creates accurate portable reasoning groups', async () => {
  const completion = await collectChatCompletion(
    parseResponsesSSE(sse([
      { type: 'response.output_text.delta', delta: 'Using tools.' },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_group_1', encrypted_content: 'group-1' },
      },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_a', name: 'a', arguments: '{}' } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_b', name: 'b', arguments: '{}' } },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_group_2', encrypted_content: 'group-2' },
      },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_c', name: 'c', arguments: '{}' } },
      { type: 'response.completed', response: {} },
    ])),
    'gpt-5.4',
    { reasoningCacheKey: 'grouped-output' },
  );

  assert.equal(completion.choices[0].message.content, 'Using tools.');
  assert.deepEqual(completion.choices[0].message.reasoning_items, [
    {
      type: 'reasoning',
      id: 'rs_group_1',
      encrypted_content: 'group-1',
      call_ids: ['call_a', 'call_b'],
    },
    {
      type: 'reasoning',
      id: 'rs_group_2',
      encrypted_content: 'group-2',
      call_ids: ['call_c'],
    },
  ]);
});

test('encrypted reasoning cache fallback preserves call grouping', async () => {
  await collectChatCompletion(
    parseResponsesSSE(sse([
      { type: 'response.output_item.done', item: { type: 'reasoning', encrypted_content: 'cached-group-1' } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_group_a', name: 'a', arguments: '{}' } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_group_b', name: 'b', arguments: '{}' } },
      { type: 'response.output_item.done', item: { type: 'reasoning', encrypted_content: 'cached-group-2' } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_group_c', name: 'c', arguments: '{}' } },
      { type: 'response.completed', response: {} },
    ])),
    'gpt-5.4',
    { reasoningCacheKey: 'grouped-cache' },
  );

  const toolCalls = [
    { id: 'call_group_a', type: 'function', function: { name: 'a', arguments: '{}' } },
    { id: 'call_group_b', type: 'function', function: { name: 'b', arguments: '{}' } },
    { id: 'call_group_c', type: 'function', function: { name: 'c', arguments: '{}' } },
  ];
  const messages = [
    { role: 'assistant', content: 'Cached tools.', tool_calls: toolCalls },
    ...toolCalls.map((toolCall) => ({ role: 'tool', tool_call_id: toolCall.id, content: 'done' })),
  ];
  const recovered = chatRequestToResponsesBody(
    { model: 'gpt-5.4', messages },
    { reasoningCacheKey: 'grouped-cache' },
  );

  assert.deepEqual(recovered.input.slice(0, 6).map((item) => item.type), [
    'message',
    'reasoning',
    'function_call',
    'function_call',
    'reasoning',
    'function_call',
  ]);
  assert.equal(recovered.input[1].encrypted_content, 'cached-group-1');
  assert.deepEqual(recovered.input.slice(2, 4).map((item) => item.call_id), ['call_group_a', 'call_group_b']);
  assert.equal(recovered.input[4].encrypted_content, 'cached-group-2');
  assert.equal(recovered.input[5].call_id, 'call_group_c');
});

test('encrypted reasoning cache fallback is scoped and only used for an adjacent tool continuation', async () => {
  await collectChatCompletion(
    parseResponsesSSE(sse([
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', encrypted_content: 'cached-ciphertext' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_cached', name: 'lookup', arguments: '{}' },
      },
      { type: 'response.completed', response: {} },
    ])),
    'gpt-5.4',
    { reasoningCacheKey: 'session-a' },
  );

  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_cached', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_cached', content: 'result' },
  ];
  const recovered = chatRequestToResponsesBody(
    { model: 'gpt-5.4', messages },
    { reasoningCacheKey: 'session-a' },
  );
  assert.deepEqual(recovered.input[0], { type: 'reasoning', encrypted_content: 'cached-ciphertext' });

  const otherSession = chatRequestToResponsesBody(
    { model: 'gpt-5.4', messages },
    { reasoningCacheKey: 'session-b' },
  );
  assert.equal(otherSession.input.some((item) => item.type === 'reasoning'), false);

  const notAdjacent = chatRequestToResponsesBody(
    { model: 'gpt-5.4', messages: [...messages, { role: 'user', content: 'new topic' }] },
    { reasoningCacheKey: 'session-a' },
  );
  assert.equal(notAdjacent.input.some((item) => item.type === 'reasoning'), false);
});

test('encrypted reasoning cache is one-shot and requires an explicit cache key', async () => {
  async function seed(cacheKey, callId, encryptedContent) {
    await collectChatCompletion(
      parseResponsesSSE(sse([
        {
          type: 'response.output_item.done',
          item: { type: 'reasoning', encrypted_content: encryptedContent },
        },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: callId, name: 'lookup', arguments: '{}' },
        },
        { type: 'response.completed', response: {} },
      ])),
      'gpt-5.4',
      { reasoningCacheKey: cacheKey },
    );
  }

  const messages = (callId) => [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: callId, content: 'result' },
  ];

  await seed('one-shot', 'call_once', 'once');
  const first = chatRequestToResponsesBody(
    { model: 'gpt-5.4', messages: messages('call_once') },
    { reasoningCacheKey: 'one-shot' },
  );
  assert.equal(first.input[0].encrypted_content, 'once');
  const second = chatRequestToResponsesBody(
    { model: 'gpt-5.4', messages: messages('call_once') },
    { reasoningCacheKey: 'one-shot' },
  );
  assert.equal(second.input.some((item) => item.type === 'reasoning'), false);

  await seed('explicit-only', 'call_explicit', 'explicit');
  const noKey = chatRequestToResponsesBody(
    { model: 'gpt-5.4', messages: messages('call_explicit') },
    { promptCacheKey: 'explicit-only' },
  );
  assert.equal(noKey.input.some((item) => item.type === 'reasoning'), false);
});
