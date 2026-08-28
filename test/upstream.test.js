import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAuth } from '../src/token-store.js';
import { callUpstream, upstreamError } from '../src/upstream.js';

function fakeJwt(accountId = 'acct_test') {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.`;
}

function mockResponse(status, data = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (data === null ? '' : JSON.stringify(data)),
  };
}

let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgb-upstream-test-'));
  process.env.KGB_HOME = tmpDir;
  process.env.KGB_UPSTREAM_BASE = 'https://upstream.invalid';
  saveAuth({
    access: 'old-access',
    refresh: 'old-refresh',
    expires: Date.now() + 3_600_000,
    accountId: 'acct_test',
  });
});

test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KGB_HOME;
  delete process.env.KGB_UPSTREAM_BASE;
});

test('callUpstream passes the abort signal to fetch', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled', 'AbortError');
  controller.abort(reason);

  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://upstream.invalid/codex/responses');
    assert.equal(options.signal, controller.signal);
    throw options.signal.reason;
  };

  await assert.rejects(
    callUpstream({ model: 'gpt-test' }, { sessionId: 'sess-abort', fetchImpl, signal: controller.signal }),
    (err) => err === reason,
  );
});

test('callUpstream cancellation interrupts an expiring-token refresh', async () => {
  saveAuth({
    access: 'old-access',
    refresh: 'old-refresh',
    expires: Date.now() + 60_000,
    accountId: 'acct_test',
  });
  const controller = new AbortController();
  const reason = new DOMException('cancelled refresh', 'AbortError');
  let upstreamCalled = false;
  const fetchImpl = async (url, options) => {
    if (url === 'https://auth.openai.com/oauth/token') {
      assert.equal(options.signal, controller.signal);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    upstreamCalled = true;
    return mockResponse(200);
  };
  const request = callUpstream(
    { model: 'gpt-test' },
    { sessionId: 'sess-refresh-abort', fetchImpl, signal: controller.signal },
  );
  controller.abort(reason);
  await assert.rejects(request, (err) => err === reason);
  assert.equal(upstreamCalled, false);
});

test('callUpstream cancellation interrupts refresh after an upstream 401', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled 401 refresh', 'AbortError');
  let upstreamCalls = 0;
  const fetchImpl = async (url, options) => {
    if (url === 'https://upstream.invalid/codex/responses') {
      upstreamCalls += 1;
      return mockResponse(401);
    }
    assert.equal(options.signal, controller.signal);
    return new Promise(() => {});
  };
  const request = callUpstream(
    { model: 'gpt-test' },
    { sessionId: 'sess-401-refresh-abort', fetchImpl, signal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(request, (err) => err === reason);
  assert.equal(upstreamCalls, 1);
});

test('callUpstream cancellation interrupts credential lock waiting', async () => {
  saveAuth({
    access: 'old-access',
    refresh: 'old-refresh',
    expires: Date.now() + 60_000,
    accountId: 'acct_test',
  });
  let releaseFirst;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const first = callUpstream(
    { model: 'gpt-test' },
    {
      sessionId: 'sess-lock-holder',
      fetchImpl: async (url) => {
        if (url === 'https://auth.openai.com/oauth/token') {
          markRefreshStarted();
          await new Promise((resolve) => { releaseFirst = resolve; });
          return mockResponse(200, {
            access_token: fakeJwt(),
            refresh_token: 'new-refresh',
            expires_in: 3600,
          });
        }
        return mockResponse(200);
      },
    },
  );
  await refreshStarted;

  const controller = new AbortController();
  const reason = new DOMException('cancelled lock wait', 'AbortError');
  const second = callUpstream(
    { model: 'gpt-test' },
    {
      sessionId: 'sess-lock-waiter',
      fetchImpl: async () => assert.fail('cancelled waiter must not fetch'),
      signal: controller.signal,
    },
  );
  controller.abort(reason);
  await assert.rejects(second, (err) => err === reason);
  releaseFirst();
  await first;
});

test('callUpstream refreshes after one 401 and retries with the new token', async () => {
  const newAccess = fakeJwt();
  let upstreamCalls = 0;
  let refreshCalls = 0;

  const fetchImpl = async (url, options) => {
    if (url === 'https://upstream.invalid/codex/responses') {
      upstreamCalls += 1;
      assert.equal(options.headers.authorization, `Bearer ${upstreamCalls === 1 ? 'old-access' : newAccess}`);
      return upstreamCalls === 1 ? mockResponse(401) : mockResponse(200);
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      refreshCalls += 1;
      assert.match(options.body, /refresh_token=old-refresh/);
      return mockResponse(200, {
        access_token: newAccess,
        refresh_token: 'new-refresh',
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const response = await callUpstream(
    { model: 'gpt-test' },
    { sessionId: 'sess-retry', fetchImpl },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 2);
  assert.equal(refreshCalls, 1);
});

test('callUpstream surfaces a second 401 without refreshing again', async () => {
  const newAccess = fakeJwt();
  let upstreamCalls = 0;
  let refreshCalls = 0;

  const fetchImpl = async (url) => {
    if (url === 'https://upstream.invalid/codex/responses') {
      upstreamCalls += 1;
      return mockResponse(401, {
        error: { message: 'still unauthorized', type: 'authentication_error', code: 'invalid_token' },
      });
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      refreshCalls += 1;
      return mockResponse(200, {
        access_token: newAccess,
        refresh_token: 'new-refresh',
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await assert.rejects(
    callUpstream({ model: 'gpt-test' }, { sessionId: 'sess-401', fetchImpl }),
    (err) => {
      assert.equal(err.message, 'still unauthorized');
      assert.equal(err.status, 401);
      assert.equal(err.type, 'authentication_error');
      assert.equal(err.code, 'invalid_token');
      return true;
    },
  );
  assert.equal(upstreamCalls, 2);
  assert.equal(refreshCalls, 1);
});

test('429 reset metadata is recognized across top-level and nested error fields', async () => {
  const resetsAt = Math.floor((Date.now() + 600_000) / 1000);
  const cases = [
    {
      body: {
        error: { message: 'top-level limit', type: 'busy' },
        code: 'rate_limit_exceeded',
        resets_at: resetsAt,
      },
      type: 'busy',
      code: 'rate_limit_exceeded',
    },
    {
      body: {
        error: {
          message: 'nested limit',
          type: 'busy',
          code: 'usage_limit_reached',
          resets_at: resetsAt,
        },
      },
      type: 'busy',
      code: 'usage_limit_reached',
    },
    {
      body: {
        message: 'top-level type',
        type: 'usage_not_included',
        code: 'quota_exhausted',
        resets_at: resetsAt,
      },
      type: 'usage_not_included',
      code: 'quota_exhausted',
    },
    {
      body: {
        type: 'usage_not_included',
        code: 'top-level-code',
        resets_at: resetsAt,
        error: {
          message: 'nested error shape',
          type: 'busy',
          code: 'nested-code',
        },
      },
      type: 'busy',
      code: 'nested-code',
    },
  ];

  for (const { body, type, code } of cases) {
    const err = await upstreamError(mockResponse(429, body));
    assert.equal(err.status, 429);
    assert.equal(err.type, type);
    assert.equal(err.code, code);
    assert.match(err.message, /try again in ~10 min/);
  }
});
