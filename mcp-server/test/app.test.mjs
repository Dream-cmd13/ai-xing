import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcpHttpApp } from '../src/app.mjs';
import { AppError } from '../src/errors.mjs';
import { FixedWindowRateLimiter } from '../src/rate-limiter.mjs';
import { SessionRegistry } from '../src/session-registry.mjs';

const basic = `Basic ${Buffer.from('zhangsan:secret', 'utf8').toString('base64')}`;
const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function fakeTransportFactory() {
  const transports = [];
  let sessionSequence = 0;
  const createTransport = (options) => {
    const transport = {
      options,
      sessionId: undefined,
      calls: [],
      onclose: undefined,
      async handleRequest(req, res, body) {
        this.calls.push({ method: req.method, body });
        if (req.method === 'POST' && body?.method === 'initialize') {
          sessionSequence += 1;
          this.sessionId = sessionSequence === 1 ? 'session-test' : `session-test-${sessionSequence}`;
          options.onsessioninitialized?.(this.sessionId);
          res.setHeader('Mcp-Session-Id', this.sessionId);
          res.status(200).json({
            jsonrpc: '2.0', id: body.id,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } },
          });
          return;
        }
        if (req.method === 'GET') {
          res.status(200).type('text/event-stream').send('event: message\ndata: {}\n\n');
          return;
        }
        if (req.method === 'DELETE') {
          res.status(204).end();
          this.onclose?.();
          return;
        }
        res.status(202).end();
      },
      async close() {},
    };
    transports.push(transport);
    return transport;
  };
  return { createTransport, transports };
}

function createFixture(overrides = {}) {
  const logs = [];
  const authProvider = overrides.authProvider ?? {
    async checkReadiness() { return { status: 'ready', releaseId: 'test' }; },
    async authenticate(credentials) {
      assert.equal(credentials.username, 'zhangsan');
      return {
        userId: 'user-1', role: 'Employee', departmentId: 'dept-1',
        accessToken: 'access-1', refreshToken: 'refresh-1', tokenExpiresAt: Date.now() + 60_000,
      };
    },
    async refresh(context) { return context; },
    createUserClient() { return {}; },
  };
  const sessionRegistry = new SessionRegistry({
    ttlMs: 60_000, refreshWindowMs: 1000, authProvider, now: Date.now,
  });
  const transportFactory = fakeTransportFactory();
  const config = {
    host: '127.0.0.1',
    allowedHosts: ['127.0.0.1', 'localhost'],
    requireHttps: false,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 30,
    requestTimeoutMs: 1000,
    ...overrides.config,
  };
  const appResult = createMcpHttpApp({
    config,
    authProvider,
    sessionRegistry,
    rateLimiter: overrides.rateLimiter ?? new FixedWindowRateLimiter({ windowMs: 60_000, max: 30 }),
    initializeRateLimiter: overrides.initializeRateLimiter,
    readRateLimiter: overrides.readRateLimiter,
    writeRateLimiter: overrides.writeRateLimiter,
    createTransport: transportFactory.createTransport,
    createRepository: () => ({}),
    createServer: () => ({ async connect() {}, async close() {} }),
    readinessGate: overrides.readinessGate,
    logger: { info: (event) => logs.push(event), error: (event) => logs.push(event) },
  });
  return { ...appResult, sessionRegistry, transportFactory, logs };
}

test('exposes a health endpoint without authentication', async (t) => {
  const fixture = createFixture();
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'ok');
  assert.equal(payload.service, 'ai-xing-okr-mcp');
  assert.equal(payload.version, '0.2.0');
  // port/responseMode 用于 8787/8878 端口漂移诊断，fixture 未传端口时为 null。
  assert.equal(payload.port, null);
  assert.equal(payload.responseMode, 'json');
});

test('reports dependency readiness separately from the unauthenticated health probe', async (t) => {
  const fixture = createFixture({ authProvider: {
    async authenticate() { throw new Error('not used'); },
    async refresh(context) { return context; },
  } });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/ready`);
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.reason, 'READINESS_CHECK_NOT_CONFIGURED');
});

test('fails closed for initialize and existing-session methods while readiness is degraded', async (t) => {
  let readiness = 'ready';
  const authProvider = {
    async checkReadiness() { return { status: readiness, reason: readiness === 'ready' ? undefined : 'RELEASE_CONTRACT_MISMATCH' }; },
    async authenticate() {
      return {
        userId: 'user-1', role: 'Employee', departmentId: 'dept-1',
        accessToken: 'access-1', refreshToken: 'refresh-1', tokenExpiresAt: Date.now() + 60_000,
      };
    },
    async refresh(context) { return context; },
    createUserClient() { return {}; },
  };
  const readinessGate = {
    async status() { return { status: readiness, reason: readiness === 'ready' ? undefined : 'RELEASE_CONTRACT_MISMATCH' }; },
    async requireReady() {
      const value = await this.status();
      if (value.status !== 'ready') throw new AppError('SERVICE_NOT_READY', undefined, 503, { reason: value.reason });
      return value;
    },
  };
  const fixture = createFixture({ authProvider, readinessGate });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const initialized = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get('mcp-session-id');
  readiness = 'degraded';
  for (const request of [
    () => fetch(`${server.url}/mcp`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody) }),
    () => fetch(`${server.url}/mcp`, { headers: { 'mcp-session-id': sessionId } }),
    () => fetch(`${server.url}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }),
  ]) {
    const response = await request();
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, 'SERVICE_NOT_READY');
  }
});

test('requires Basic Auth for MCP initialization', async (t) => {
  const fixture = createFixture();
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate').startsWith('Basic '), true);
  assert.equal(payload.error.code, 'AUTHENTICATION_REQUIRED');
});

test('returns one safe authentication error for invalid credentials', async (t) => {
  const authProvider = {
    async checkReadiness() { return { status: 'ready', releaseId: 'test' }; },
    async authenticate() { throw new AppError('AUTHENTICATION_FAILED', '账号或密码错误。', 401); },
    async refresh(context) { return context; },
  };
  const fixture = createFixture({ authProvider });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });
  const text = await response.text();

  assert.equal(response.status, 401);
  assert.equal(text.includes('AUTHENTICATION_FAILED'), true);
  assert.equal(text.includes('Supabase secret'), false);
});

test('creates a session and routes GET and DELETE to its transport', async (t) => {
  const fixture = createFixture();
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const initResponse = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });
  assert.equal(initResponse.status, 200);
  assert.equal(initResponse.headers.get('mcp-session-id'), 'session-test');
  assert.equal(fixture.sessionRegistry.size, 1);
  assert.equal(fixture.transportFactory.transports[0].options.enableJsonResponse, true);
  assert.equal(fixture.transportFactory.transports[0].options.keepAliveMs, 15_000);

  const getResponse = await fetch(`${server.url}/mcp`, { headers: { 'mcp-session-id': 'session-test' } });
  assert.equal(getResponse.status, 200);
  assert.equal(fixture.transportFactory.transports[0].calls.some((call) => call.method === 'GET'), true);

  const deleteResponse = await fetch(`${server.url}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': 'session-test' } });
  assert.equal(deleteResponse.status, 204);
  assert.equal(fixture.sessionRegistry.size, 0);
});

test('rejects non-initialize calls without a valid MCP session using 404', async (t) => {
  const fixture = createFixture();
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': 'missing' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const payload = await response.json();

  // MCP 规范与 SDK validateSession：未知 session 返回 404，客户端据此自动重新 initialize。
  assert.equal(response.status, 404);
  assert.equal(payload.error.code, -32001);
  assert.equal(payload.error.data.code, 'SESSION_EXPIRED');
});

test('rejects non-HTTPS proxy traffic when HTTPS is required', async (t) => {
  const fixture = createFixture({ config: { requireHttps: true } });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/json', 'x-forwarded-proto': 'http' },
    body: JSON.stringify(initializeBody),
  });

  assert.equal(response.status, 426);
});

test('ignores a spoofed forwarded HTTPS header from an untrusted peer', async (t) => {
  const fixture = createFixture({ config: { requireHttps: true, trustedProxyAddresses: ['192.0.2.10'] } });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify(initializeBody),
  });
  assert.equal(response.status, 426);
});

test('accepts forwarded HTTPS only from a configured loopback proxy', async (t) => {
  const fixture = createFixture({ config: { requireHttps: true, trustedProxyAddresses: ['127.0.0.1'] } });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { authorization: basic, 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify(initializeBody),
  });
  assert.equal(response.status, 200);
});

test('rate limits repeated initialization attempts without logging credentials', async (t) => {
  const fixture = createFixture({
    rateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 1, now: () => 100 }),
  });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });
  const request = () => fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });

  assert.equal((await request()).status, 200);
  const response = await request();
  const serializedLogs = JSON.stringify(fixture.logs);

  assert.equal(response.status, 429);
  assert.equal(serializedLogs.includes('secret'), false);
  assert.equal(serializedLogs.includes('Basic '), false);
  assert.equal(serializedLogs.includes('access-1'), false);
});

test('rate limits calls on an established session and returns Retry-After', async (t) => {
  const fixture = createFixture({
    readRateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 1, now: () => 100 }),
  });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });
  const initResponse = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });
  const sessionId = initResponse.headers.get('mcp-session-id');
  const request = () => fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { 'mcp-session-id': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });

  assert.equal((await request()).status, 202);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(Number(limited.headers.get('retry-after')) >= 1, true);
});

test('does not reset a user rate limit when the same account creates another session', async (t) => {
  const fixture = createFixture({
    readRateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 1, now: () => 100 }),
  });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });
  const initialize = () => fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });
  const firstSession = (await initialize()).headers.get('mcp-session-id');
  const secondSession = (await initialize()).headers.get('mcp-session-id');
  const read = (sessionId) => fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { 'mcp-session-id': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });

  assert.equal((await read(firstSession)).status, 202);
  assert.equal((await read(secondSession)).status, 429);
});

test('applies independent quotas to read and write tool calls', async (t) => {
  const fixture = createFixture({
    readRateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 1, now: () => 100 }),
    writeRateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 1, now: () => 100 }),
  });
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });
  const initResponse = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });
  const sessionId = initResponse.headers.get('mcp-session-id');
  const call = (body) => fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { 'mcp-session-id': sessionId, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const readBody = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const writeBody = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'prepare_create_pad_task', arguments: {} } };

  assert.equal((await call(writeBody)).status, 202);
  assert.equal((await call(readBody)).status, 202);
  assert.equal((await call(writeBody)).status, 429);
  assert.equal((await call(readBody)).status, 429);
});

test('draining rejects new MCP initialization attempts', async (t) => {
  const fixture = createFixture();
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  fixture.setDraining();
  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(initializeBody),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'SERVICE_DRAINING');
});
