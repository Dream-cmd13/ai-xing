import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createMcpHttpApp } from '../src/app.mjs';
import { ConfirmationStore } from '../src/confirmation-store.mjs';
import { FixedWindowRateLimiter } from '../src/rate-limiter.mjs';
import { SessionRegistry } from '../src/session-registry.mjs';
import { detectPortDrift } from '../src/port-drift.mjs';

const basic = `Basic ${Buffer.from('zhangsan:secret', 'utf8').toString('base64')}`;
const initializeBody = () => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'trae-sim', version: '1.0.0' },
  },
});

function buildAuthProvider() {
  return {
    calls: 0,
    async authenticate() {
      this.calls += 1;
      return {
        userId: 'user-1', role: 'Manager', departmentId: 'dept-1',
        accessToken: 'access-1', refreshToken: 'refresh-1', tokenExpiresAt: Date.now() + 3_600_000,
      };
    },
    async refresh(context) { return context; },
    createUserClient() { return {}; },
  };
}

function buildWriteRepository() {
  let callCount = 0;
  return {
    getContext: undefined,
    async prepareUpdatePadTask({ taskId, changes }) {
      callCount += 1;
      return {
        current: { id: taskId, title: `old-${callCount}` },
        changes: structuredClone(changes ?? {}),
        expectedRowVersion: callCount - 1,
      };
    },
    async lookupWriteResult() { return null; },
    async recordFailedWrite() {},
  };
}

async function startApp({ enableJsonResponse = true, ttlMs = 60_000 } = {}) {
  const logs = [];
  const logger = {
    info: (event) => logs.push(event),
    error: (event) => logs.push(event),
  };
  const authProvider = buildAuthProvider();
  const registry = new SessionRegistry({ ttlMs, refreshWindowMs: 1000, authProvider });
  const createWriteRepository = ({ getContext }) => {
    const repository = buildWriteRepository();
    repository.getContext = getContext;
    return repository;
  };
  const application = createMcpHttpApp({
    config: {
      host: '127.0.0.1',
      allowedHosts: ['127.0.0.1', 'localhost'],
      requireHttps: false,
      port: 8787,
      requestTimeoutMs: 5000,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
      enableJsonResponse,
      sseKeepAliveMs: 1000,
    },
    authProvider,
    sessionRegistry: registry,
    rateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 100 }),
    createRepository: () => ({
      getOrganizationInfo: async () => ({ strategy: null, departments: [], businesses: [] }),
    }),
    createWriteRepository,
    confirmationStore: new ConfirmationStore({ ttlMs: 60_000 }),
    logger,
  });
  const server = await new Promise((resolve) => {
    const instance = application.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    registry,
    authProvider,
    logs,
    async close() {
      await application.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function post(app, body, sessionId) {
  return fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: basic,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function toolCall(app, id, name, args, sessionId) {
  return post(app, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sessionId);
}

async function initialize(app) {
  const response = await post(app, initializeBody());
  assert.equal(response.status, 200);
  const sessionId = response.headers.get('mcp-session-id');
  assert.ok(sessionId, 'initialize 必须返回 mcp-session-id');
  await post(app, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
  return sessionId;
}

async function readJsonResponse(response) {
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  return response.json();
}

async function readSseResponse(response) {
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/i);
  const text = await response.text();
  const events = text.split('\n\n').filter((block) => block.includes('data:'));
  const payload = events.at(-1)?.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
  return JSON.parse(payload);
}

test('同一个 MCP session 连续调用多个工具且每次响应都回传相同 mcp-session-id（JSON 模式）', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const sessionId = await initialize(app);

  const first = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-A' } }, sessionId);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('mcp-session-id'), sessionId);
  const firstBody = await readJsonResponse(first);
  assert.equal(firstBody.result.isError, false);
  assert.equal(firstBody.result.structuredContent.changes.title, 'VERSION-A');

  const second = await toolCall(app, 3, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-B' } }, sessionId);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('mcp-session-id'), sessionId);
  const secondBody = await readJsonResponse(second);
  assert.equal(secondBody.result.isError, false);
  assert.equal(secondBody.result.structuredContent.changes.title, 'VERSION-B');

  const third = await toolCall(app, 4, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-C' } }, sessionId);
  assert.equal(third.status, 200);
  const thirdBody = await readJsonResponse(third);
  assert.equal(thirdBody.result.isError, false);

  assert.equal(app.registry.size, 1);
  assert.equal(app.authProvider.calls, 1);
});

test('第一次 prepare_update 成功后第二次 prepare_update 仍可用（SSE fallback 模式）', async (t) => {
  const app = await startApp({ enableJsonResponse: false });
  t.after(() => app.close());

  const initResponse = await post(app, initializeBody());
  assert.equal(initResponse.status, 200);
  const sessionId = initResponse.headers.get('mcp-session-id');
  await post(app, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);

  const first = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-A' } }, sessionId);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('mcp-session-id'), sessionId);
  const firstBody = await readSseResponse(first);
  assert.equal(firstBody.result.isError, false);
  assert.equal(firstBody.result.structuredContent.changes.title, 'VERSION-A');

  const second = await toolCall(app, 3, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-B' } }, sessionId);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('mcp-session-id'), sessionId);
  const secondBody = await readSseResponse(second);
  assert.equal(secondBody.result.isError, false);
  assert.equal(secondBody.result.structuredContent.changes.title, 'VERSION-B');

  assert.equal(app.registry.size, 1);
});

test('客户端断开 GET SSE 监听流后重新请求不会错误删除仍有效的 session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const sessionId = await initialize(app);

  const controller = new AbortController();
  const stream = await fetch(`${app.base}/mcp`, {
    method: 'GET',
    headers: { authorization: basic, accept: 'text/event-stream', 'mcp-session-id': sessionId },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const afterAbort = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'AFTER-ABORT' } }, sessionId);
  assert.equal(afterAbort.status, 200);
  const afterAbortBody = await readJsonResponse(afterAbort);
  assert.equal(afterAbortBody.result.isError, false);
  assert.equal(app.registry.size, 1);
});

test('瞬时 transport 错误（重复 GET SSE 流 409）不会删除仍有效的 session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const sessionId = await initialize(app);

  const firstStream = await fetch(`${app.base}/mcp`, {
    method: 'GET',
    headers: { authorization: basic, accept: 'text/event-stream', 'mcp-session-id': sessionId },
  });
  assert.equal(firstStream.status, 200);

  const conflict = await fetch(`${app.base}/mcp`, {
    method: 'GET',
    headers: { authorization: basic, accept: 'text/event-stream', 'mcp-session-id': sessionId },
  });
  assert.equal(conflict.status, 409);

  void firstStream.body?.cancel?.().catch?.(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));

  const afterConflict = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'AFTER-409' } }, sessionId);
  assert.equal(afterConflict.status, 200);
  const afterConflictBody = await readJsonResponse(afterConflict);
  assert.equal(afterConflictBody.result.isError, false);
  assert.equal(app.registry.size, 1);
});

test('DELETE 终止 session 后，携带旧 session-id 的请求被拒绝且注册表清空', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const sessionId = await initialize(app);
  const response = await fetch(`${app.base}/mcp`, {
    method: 'DELETE',
    headers: { authorization: basic, 'mcp-session-id': sessionId },
  });
  assert.equal(response.status, 200);
  assert.equal(app.registry.size, 0);

  const stale = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'STALE' } }, sessionId);
  // 失效 session 必须返回 404（MCP 规范），客户端才会自动重新 initialize 恢复。
  assert.equal(stale.status, 404);
  const staleBody = await stale.json();
  assert.equal(staleBody.error.data.code, 'SESSION_EXPIRED');
});

test('session TTL 过期后请求被拒绝且资源被清理', async (t) => {
  const app = await startApp({ ttlMs: 150 });
  t.after(() => app.close());

  const sessionId = await initialize(app);
  assert.equal(app.registry.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const expired = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'EXPIRED' } }, sessionId);
  assert.equal(expired.status, 404);
  assert.equal(app.registry.size, 0);
});

test('会话丢失（模拟服务重启）返回 404，客户端重新 initialize 后立即恢复（TRAE 恢复路径）', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const sessionId = await initialize(app);
  // 模拟服务进程重启：注册表丢失全部会话，但客户端仍持有旧 session-id。
  await app.registry.remove(sessionId);

  const stale = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'STALE' } }, sessionId);
  // 必须是 404 而不是 400：TRAE 等客户端只认 404 作为"重新 initialize"信号，
  // 收到 400 会判定服务不可用并报 "MCP server '' not found"。
  assert.equal(stale.status, 404);

  // 规范恢复路径：不带旧 session-id 重新 initialize。
  const freshSessionId = await initialize(app);
  assert.notEqual(freshSessionId, sessionId);

  const recovered = await toolCall(app, 3, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'RECOVERED' } }, freshSessionId);
  assert.equal(recovered.status, 200);
  const recoveredBody = await readJsonResponse(recovered);
  assert.equal(recoveredBody.result.isError, false);
  assert.equal(recoveredBody.result.structuredContent.changes.title, 'RECOVERED');
  assert.equal(app.registry.size, 1);
});

test('单次工具调用结束后 MCP HTTP 服务进程继续服务（不随请求退出）', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const sessionId = await initialize(app);
  const call = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'ONCE' } }, sessionId);
  assert.equal(call.status, 200);

  const health = await fetch(`${app.base}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.version, '0.2.0');

  const next = await toolCall(app, 3, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'TWICE' } }, sessionId);
  assert.equal(next.status, 200);
});

test('health 端点返回端口与响应模式，用于 8787/8878 配置漂移诊断', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const health = await fetch(`${app.base}/health`);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.version, '0.2.0');
  assert.equal(healthBody.port, 8787);
  assert.equal(healthBody.responseMode, 'json');
  assert.notEqual(healthBody.port, 8878);
});

test('端口漂移探测器：历史端口被旧进程占用时给出明确诊断，空闲端口保持安静', async (t) => {
  const staleServer = net.createServer(() => {});
  await new Promise((resolve) => staleServer.listen(0, '127.0.0.1', resolve));
  const stalePort = staleServer.address().port;
  t.after(() => new Promise((resolve) => staleServer.close(resolve)));

  const occupied = await detectPortDrift({ port: stalePort, host: '127.0.0.1' });
  assert.equal(occupied, true, '被占用的历史端口必须被识别');

  const free = await detectPortDrift({ port: stalePort + 1, host: '127.0.0.1' });
  assert.equal(free, false, '空闲端口不应告警');
});

test('重复 initialize（携带旧 session-id）回收旧会话并返回新 session，而不是 400', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const sessionId = await initialize(app);
  const call = await toolCall(app, 2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'BEFORE-REINIT' } }, sessionId);
  assert.equal(call.status, 200);

  const reInit = await post(app, { ...initializeBody(), id: 20 }, sessionId);
  assert.equal(reInit.status, 200);
  const newSessionId = reInit.headers.get('mcp-session-id');
  assert.ok(newSessionId);
  assert.notEqual(newSessionId, sessionId);
  assert.equal(app.registry.size, 1);

  const afterReInit = await toolCall(app, 3, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'AFTER-REINIT' } }, newSessionId);
  assert.equal(afterReInit.status, 200);
  const afterReInitBody = await readJsonResponse(afterReInit);
  assert.equal(afterReInitBody.result.isError, false);
});

test('并发 ensureReady 共享同一次 token 刷新，避免竞态删除有效 session', async () => {
  let refreshCalls = 0;
  let resolveRefresh;
  const authProvider = {
    async refresh(context) {
      refreshCalls += 1;
      await new Promise((resolve) => { resolveRefresh = resolve; });
      return { ...context, accessToken: `access-${refreshCalls}` };
    },
  };
  const registry = new SessionRegistry({
    ttlMs: 10_000,
    refreshWindowMs: 60_000,
    authProvider,
    now: () => 10_000,
  });
  registry.register('session-1', {
    transport: { async close() {} },
    server: { async close() {} },
    context: { userId: 'user-1', accessToken: 'old', refreshToken: 'r', tokenExpiresAt: 11_000 },
  });

  const pending = Promise.all([registry.ensureReady('session-1'), registry.ensureReady('session-1')]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  resolveRefresh();
  const [first, second] = await pending;

  assert.equal(refreshCalls, 1, '并发请求必须共享一次刷新');
  assert.equal(first.context.accessToken, 'access-1');
  assert.equal(second.context.accessToken, 'access-1');
  assert.equal(registry.size, 1);
});
