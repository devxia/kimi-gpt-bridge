// Pure translation between OpenAI Chat Completions and the Codex Responses API.
import crypto from 'node:crypto';

export const EFFORT_SUFFIXES = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// `gpt-5.4-high` → { model: 'gpt-5.4', effort: 'high' }
export function parseModelAndEffort(rawModel) {
  const raw = String(rawModel ?? '');
  for (const suffix of EFFORT_SUFFIXES) {
    if (raw.endsWith(`-${suffix}`)) {
      return { model: raw.slice(0, -(suffix.length + 1)), effort: suffix };
    }
  }
  return { model: raw, effort: undefined };
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
  }
  return String(content);
}

// Translate a Chat Completions request into a Codex Responses request body.
export function chatRequestToResponsesBody(req, { promptCacheKey } = {}) {
  const { messages = [], tools, reasoning_effort } = req ?? {};
  const { model, effort: suffixEffort } = parseModelAndEffort(req?.model);

  const instructionParts = [];
  const input = [];

  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === 'system' || m.role === 'developer') {
      const text = textOf(m.content);
      if (text) instructionParts.push(text);
      continue;
    }
    if (m.role === 'user') {
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
      const content = [];
      for (const p of parts) {
        if (!p) continue;
        if (p.type === 'text' || p.type === 'input_text') {
          content.push({ type: 'input_text', text: p.text ?? '' });
        } else if (p.type === 'image_url') {
          const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
          if (url) content.push({ type: 'input_image', image_url: url });
        }
      }
      input.push({ role: 'user', content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = textOf(m.content);
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
          status: 'completed',
        });
      }
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function?.name,
          arguments:
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
        });
      }
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null),
      });
      continue;
    }
  }

  const body = {
    model,
    store: false,
    stream: true,
    instructions: instructionParts.length ? instructionParts.join('\n\n') : 'You are a helpful assistant.',
    input,
    text: { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: promptCacheKey,
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };

  // Explicit reasoning_effort wins over the model-name suffix.
  const effort = reasoning_effort ?? suffixEffort;
  if (effort) body.reasoning = { effort, summary: 'auto' };

  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      name: t.function?.name,
      description: t.function?.description,
      parameters: t.function?.parameters,
      strict: false,
    }));
  }

  return body;
}

// Yields decoded text chunks from a web ReadableStream or any async iterable.
export async function* readChunks(source) {
  const decoder = new TextDecoder();
  if (source && typeof source.getReader === 'function') {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    for await (const chunk of source) {
      yield typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    }
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

// Parses an upstream SSE stream (`data: {json}` lines, event type inside the
// JSON `type` field) into event objects.
export async function* parseResponsesSSE(stream) {
  let buffer = '';
  for await (const chunk of readChunks(stream)) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        const clean = line.replace(/\r$/, '');
        if (clean.startsWith('data:')) dataLines.push(clean.slice(5).replace(/^ /, ''));
      }
      if (!dataLines.length) continue;
      const data = dataLines.join('\n');
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }
  // Flush a trailing event not terminated by a blank line.
  const dataLines = [];
  for (const line of buffer.split('\n')) {
    const clean = line.replace(/\r$/, '');
    if (clean.startsWith('data:')) dataLines.push(clean.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length) {
    const data = dataLines.join('\n');
    if (data !== '[DONE]') yield JSON.parse(data);
  }
}

function usageOf(u) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
  };
}

// Translates Responses SSE events into OpenAI chat.completion.chunk objects.
export async function* createChatChunkStream(events, model) {
  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason = null, usage = undefined) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });

  let toolCallCount = 0;
  yield chunk({ role: 'assistant' });

  for await (const event of events) {
    switch (event.type) {
      case 'response.output_text.delta':
        yield chunk({ content: event.delta ?? '' });
        break;
      case 'response.reasoning_summary_text.delta':
        yield chunk({ reasoning_content: event.delta ?? '' });
        break;
      case 'response.output_item.done':
        if (event.item?.type === 'function_call') {
          yield chunk({
            tool_calls: [
              {
                index: toolCallCount,
                id: event.item.call_id,
                type: 'function',
                function: { name: event.item.name, arguments: event.item.arguments ?? '' },
              },
            ],
          });
          toolCallCount += 1;
        }
        break;
      case 'response.completed':
        yield chunk({}, toolCallCount > 0 ? 'tool_calls' : 'stop', usageOf(event.response?.usage));
        return;
      case 'response.incomplete':
        yield chunk({}, 'length', usageOf(event.response?.usage));
        return;
      case 'response.failed':
        throw new Error(event.response?.error?.message || 'Upstream response failed');
      case 'error':
        throw new Error(event.message || 'Upstream stream error');
      default:
        break; // ignore other event types
    }
  }
}

// Aggregates a full event stream into one non-streaming chat.completion object.
export async function collectChatCompletion(events, model) {
  let id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  let created = Math.floor(Date.now() / 1000);
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let finishReason = 'stop';
  let usage;
  for await (const chunk of createChatChunkStream(events, model)) {
    id = chunk.id;
    created = chunk.created;
    const choice = chunk.choices[0];
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) toolCalls[tc.index] = tc;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}
