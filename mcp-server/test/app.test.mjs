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
  const createTransport = (options) => {
    const transport = {
      options,
      sessionId: undefined,
      calls: [],
      onclose: undefined,
      async handleRequest(req, res, body) {
        this.calls.push({ method: req.method, body });
        if (req.method === 'POST' && body?.method === 'initialize') {
          this.sessionId = 'session-test';
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
    createTransport: transportFactory.createTransport,
    createRepository: () => ({}),
    createServer: () => ({ async connect() {}, async close() {} }),
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
  assert.deepEqual(await response.json(), { status: 'ok', service: 'ai-xing-okr-mcp', version: '0.1.0' });
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

  const getResponse = await fetch(`${server.url}/mcp`, { headers: { 'mcp-session-id': 'session-test' } });
  assert.equal(getResponse.status, 200);
  assert.equal(fixture.transportFactory.transports[0].calls.some((call) => call.method === 'GET'), true);

  const deleteResponse = await fetch(`${server.url}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': 'session-test' } });
  assert.equal(deleteResponse.status, 204);
  assert.equal(fixture.sessionRegistry.size, 0);
});

test('rejects non-initialize calls without a valid MCP session', async (t) => {
  const fixture = createFixture();
  const server = await listen(fixture.app);
  t.after(async () => { await server.close(); await fixture.close(); });

  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': 'missing' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
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
