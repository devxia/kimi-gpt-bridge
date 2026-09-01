// Pure translation between OpenAI Chat Completions and the Codex Responses API.
import crypto from 'node:crypto';

export const EFFORT_SUFFIXES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const MAX_REASONING_CACHE_ENTRIES = 128;
const encryptedReasoningCache = new Map();

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
      .filter(
        (p) =>
          p &&
          (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') &&
          typeof p.text === 'string',
      )
      .map((p) => p.text)
      .join('');
  }
  return String(content);
}

function toolOutputOf(content) {
  if (typeof content === 'string') return content;
  if (
    Array.isArray(content) &&
    content.every(
      (p) =>
        p &&
        (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') &&
        typeof p.text === 'string',
    )
  ) {
    return textOf(content);
  }
  return JSON.stringify(content ?? null);
}

function mapToolChoice(toolChoice) {
  if (toolChoice == null) return 'auto';
  if (typeof toolChoice === 'string') return toolChoice;
  const name = toolChoice.function?.name ?? toolChoice.name;
  if (toolChoice.type === 'function' && name) return { type: 'function', name };
  return toolChoice;
}

function toResponseReasoningItem(item) {
  if (!item || item.type !== 'reasoning' || typeof item.encrypted_content !== 'string') return undefined;
  return {
    type: 'reasoning',
    ...(item.id ? { id: item.id } : {}),
    ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
    encrypted_content: item.encrypted_content,
  };
}

function reasoningIdentity(item) {
  return `${item.id ?? ''}\u0000${item.encrypted_content}`;
}

function uniqueReasoningItems(items) {
  const seen = new Set();
  const result = [];
  for (const raw of items) {
    const item = toResponseReasoningItem(raw);
    if (!item) continue;
    const identity = reasoningIdentity(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(item);
  }
  return result;
}

function reasoningCacheId(cacheKey, callId) {
  return JSON.stringify([String(cacheKey), String(callId)]);
}

function cacheReasoningItems(cacheKey, callId, items) {
  if (cacheKey == null || !callId || !items.length) return;
  const key = reasoningCacheId(cacheKey, callId);
  encryptedReasoningCache.delete(key);
  encryptedReasoningCache.set(key, uniqueReasoningItems(items));
  while (encryptedReasoningCache.size > MAX_REASONING_CACHE_ENTRIES) {
    encryptedReasoningCache.delete(encryptedReasoningCache.keys().next().value);
  }
}

function consumeReasoningItems(cacheKey, callIds) {
  if (cacheKey == null) return [];
  const itemsByIdentity = new Map();
  for (const callId of callIds) {
    const key = reasoningCacheId(cacheKey, callId);
    const cached = encryptedReasoningCache.get(key);
    for (const item of cached ?? []) {
      const identity = reasoningIdentity(item);
      let portableItem = itemsByIdentity.get(identity);
      if (!portableItem) {
        portableItem = { ...item, call_ids: [] };
        itemsByIdentity.set(identity, portableItem);
      }
      portableItem.call_ids.push(callId);
    }
    encryptedReasoningCache.delete(key);
  }
  return [...itemsByIdentity.values()];
}

function pruneReasoningCache(cacheKey, allowedCallIds = []) {
  if (cacheKey == null) return;
  const allowed = new Set(allowedCallIds.map((callId) => reasoningCacheId(cacheKey, callId)));
  const namespace = String(cacheKey);
  for (const key of encryptedReasoningCache.keys()) {
    const [storedNamespace] = JSON.parse(key);
    if (storedNamespace === namespace && !allowed.has(key)) encryptedReasoningCache.delete(key);
  }
}

function isAdjacentToolContinuation(messages, assistantIndex, callIds) {
  const continuation = messages.slice(assistantIndex + 1);
  if (!continuation.length || continuation.some((m) => m?.role !== 'tool')) return false;
  const expected = new Set(callIds);
  const actual = new Set(continuation.map((m) => m.tool_call_id));
  return expected.size === actual.size && [...expected].every((id) => actual.has(id));
}

// Extract tool-call IDs from the last assistant turn only if they are followed
// by an adjacent, complete tool continuation (all tool messages, every call ID
// answered exactly once). This is the condition under which encrypted reasoning
// cache entries remain valid and should be attached.
function latestToolCallsIfAdjacent(messages) {
  const lastAssistantIndex = messages.findLastIndex((m) => m?.role === 'assistant');
  if (lastAssistantIndex < 0) return [];
  const toolCalls = Array.isArray(messages[lastAssistantIndex]?.tool_calls)
    ? messages[lastAssistantIndex].tool_calls
    : [];
  const callIds = toolCalls.map((tc) => tc?.id).filter(Boolean);
  return isAdjacentToolContinuation(messages, lastAssistantIndex, callIds) ? callIds : [];
}

function reasoningGroups(rawItems, callIds) {
  const groupsByCallIds = new Map();
  for (const raw of rawItems) {
    const item = toResponseReasoningItem(raw);
    if (!item) continue;
    const declaredCallIds = Array.isArray(raw.call_ids) ? new Set(raw.call_ids) : undefined;
    const associatedCallIds = declaredCallIds
      ? callIds.filter((callId) => declaredCallIds.has(callId))
      : [...callIds];
    if (!associatedCallIds.length) continue;
    const key = JSON.stringify(associatedCallIds);
    let group = groupsByCallIds.get(key);
    if (!group) {
      group = { items: [], callIds: associatedCallIds };
      groupsByCallIds.set(key, group);
    }
    group.items.push(item);
  }
  return [...groupsByCallIds.values()].map((group) => ({
    ...group,
    items: uniqueReasoningItems(group.items),
  }));
}

// Translate a Chat Completions request into a Codex Responses request body.
// `reasoningCacheKey` namespaces the one-turn encrypted-reasoning fallback.
export function chatRequestToResponsesBody(req, { promptCacheKey, reasoningCacheKey } = {}) {
  const { messages = [], tools, reasoning_effort } = req ?? {};
  const { model, effort: suffixEffort } = parseModelAndEffort(req?.model);
  const cacheKey = reasoningCacheKey;

  const instructionParts = [];
  const input = [];
  const latestCallIds = latestToolCallsIfAdjacent(messages);
  pruneReasoningCache(cacheKey, latestCallIds);

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const m = messages[messageIndex];
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
          const detail = typeof p.image_url === 'object' ? p.image_url?.detail : p.detail;
          if (url) {
            content.push({ type: 'input_image', image_url: url, ...(detail ? { detail } : {}) });
          }
        }
      }
      input.push({ role: 'user', content });
      continue;
    }
    if (m.role === 'assistant') {
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const callIds = toolCalls.map((tc) => tc.id).filter(Boolean);
      const adjacentToolContinuation = isAdjacentToolContinuation(messages, messageIndex, callIds);
      const explicitGroups = adjacentToolContinuation
        ? reasoningGroups(Array.isArray(m.reasoning_items) ? m.reasoning_items : [], callIds)
        : [];
      const cachedItems = adjacentToolContinuation ? consumeReasoningItems(cacheKey, callIds) : [];
      const groups = explicitGroups.length ? explicitGroups : reasoningGroups(cachedItems, callIds);

      const text = textOf(m.content);
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
          status: 'completed',
        });
      }

      const callsById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
      const emittedCallIds = new Set();
      const pushFunctionCall = (toolCall) => {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function?.name,
          arguments:
            typeof toolCall.function?.arguments === 'string'
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function?.arguments ?? {}),
        });
        emittedCallIds.add(toolCall.id);
      };
      for (const group of groups) {
        const groupedCalls = group.callIds
          .filter((callId) => !emittedCallIds.has(callId))
          .map((callId) => callsById.get(callId))
          .filter(Boolean);
        if (!groupedCalls.length) continue;
        input.push(...group.items);
        for (const toolCall of groupedCalls) pushFunctionCall(toolCall);
      }
      for (const toolCall of toolCalls) {
        if (!emittedCallIds.has(toolCall.id)) pushFunctionCall(toolCall);
      }
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: toolOutputOf(m.content),
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
    tool_choice: mapToolChoice(req?.tool_choice),
    parallel_tool_calls: req?.parallel_tool_calls ?? true,
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
      strict: t.function?.strict ?? false,
    }));
  }

  return body;
}

// Yields decoded text chunks from a web ReadableStream or any async iterable.
export async function* readChunks(source) {
  const decoder = new TextDecoder();
  if (source && typeof source.getReader === 'function') {
    const reader = source.getReader();
    let reachedEnd = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          reachedEnd = true;
          break;
        }
        yield decoder.decode(value, { stream: true });
      }
    } finally {
      if (!reachedEnd) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already have closed while cancellation was pending.
        }
      }
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

function sseData(rawEvent) {
  const dataLines = [];
  for (const line of rawEvent.split(/\r\n|\r|\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.length ? dataLines.join('\n') : undefined;
}

// Parses an upstream SSE stream (`data: {json}` lines, event type inside the
// JSON `type` field) into event objects.
const MAX_SSE_BUFFER_BYTES = 1024 * 1024; // 1 MiB

export async function* parseResponsesSSE(stream) {
  let buffer = '';
  for await (const chunk of readChunks(stream)) {
    buffer += chunk;
    if (buffer.length > MAX_SSE_BUFFER_BYTES) {
      throw new Error(`SSE buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a complete event — upstream may not be sending blank lines.`);
    }
    for (;;) {
      const separator = buffer.match(/\r\n\r\n|\r\r|\n\n/);
      if (!separator) break;
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = sseData(rawEvent);
      if (data == null) continue;
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }

  // Accept a final complete data event even if the upstream omitted its blank line.
  const data = sseData(buffer);
  if (data != null && data !== '[DONE]') {
    try {
      yield JSON.parse(data);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Upstream connection closed with incomplete SSE event (${buffer.length} bytes in buffer) — expected a terminal response event before EOF.`);
      }
      throw err;
    }
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

function incompleteReasonOf(response) {
  const details = response?.incomplete_details;
  if (typeof details === 'string') return details;
  return details?.reason;
}

function incompleteFinishReason(reason) {
  return reason === 'content_filter' ? 'content_filter' : 'length';
}

function portableReasoningItems(groups) {
  return groups.flatMap((group) =>
    uniqueReasoningItems(group.items).map((item) => ({ ...item, call_ids: [...group.callIds] })),
  );
}

// Translates Responses SSE events into OpenAI chat.completion.chunk objects.
// `reasoningCacheKey` must be stable for one client conversation.
export async function* createChatChunkStream(events, model, { reasoningCacheKey } = {}) {
  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason = null, usage = undefined, choiceFields = undefined) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason, ...choiceFields }],
    ...(usage ? { usage } : {}),
  });

  let toolCallCount = 0;
  let activeReasoningGroup;
  const outputReasoningGroups = [];
  yield chunk({ role: 'assistant' });

  for await (const event of events) {
    switch (event.type) {
      case 'response.output_text.delta':
        yield chunk({ content: event.delta ?? '' });
        break;
      case 'response.reasoning_summary_text.delta':
        yield chunk({ reasoning_content: event.delta ?? '' });
        break;
      case 'response.refusal.delta':
      case 'response.output_refusal.delta':
        yield chunk({ refusal: event.delta ?? '' });
        break;
      case 'response.output_item.done':
        if (event.item?.type === 'reasoning') {
          const item = toResponseReasoningItem(event.item);
          if (item) {
            activeReasoningGroup = { items: [item], callIds: [] };
            outputReasoningGroups.push(activeReasoningGroup);
          }
        } else if (event.item?.type === 'function_call') {
          if (activeReasoningGroup) {
            activeReasoningGroup.callIds.push(event.item.call_id);
            cacheReasoningItems(reasoningCacheKey, event.item.call_id, activeReasoningGroup.items);
          }
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
      case 'response.completed': {
        const portableItems = portableReasoningItems(outputReasoningGroups);
        if (portableItems.length) yield chunk({ reasoning_items: portableItems });
        yield chunk({}, toolCallCount > 0 ? 'tool_calls' : 'stop', usageOf(event.response?.usage));
        return;
      }
      case 'response.incomplete': {
        const reason = incompleteReasonOf(event.response);
        const portableItems = portableReasoningItems(outputReasoningGroups);
        if (portableItems.length) yield chunk({ reasoning_items: portableItems });
        yield chunk(
          {},
          incompleteFinishReason(reason),
          usageOf(event.response?.usage),
          reason ? { incomplete_reason: reason } : undefined,
        );
        return;
      }
      case 'response.failed':
        throw new Error(event.response?.error?.message || 'Upstream response failed');
      case 'error':
        throw new Error(event.message || 'Upstream stream error');
      default:
        break; // ignore other event types
    }
  }

  throw new Error('Upstream stream ended before a terminal response event');
}

// Aggregates a full event stream into one non-streaming chat.completion object.
export async function collectChatCompletion(events, model, options) {
  let id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  let created = Math.floor(Date.now() / 1000);
  let content = '';
  let reasoning = '';
  let refusal = '';
  const reasoningItems = [];
  const toolCalls = [];
  let finishReason = 'stop';
  let incompleteReason;
  let usage;
  for await (const chunk of createChatChunkStream(events, model, options)) {
    id = chunk.id;
    created = chunk.created;
    const choice = chunk.choices[0];
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice.delta?.refusal) refusal += choice.delta.refusal;
    if (choice.delta?.reasoning_items) reasoningItems.push(...choice.delta.reasoning_items);
    if (choice.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) toolCalls[tc.index] = tc;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.incomplete_reason) incompleteReason = choice.incomplete_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (refusal) message.refusal = refusal;
  if (reasoningItems.length) message.reasoning_items = reasoningItems;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        ...(incompleteReason ? { incomplete_reason: incompleteReason } : {}),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}
