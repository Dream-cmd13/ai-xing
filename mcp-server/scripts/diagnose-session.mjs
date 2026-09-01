// 会话弹性诊断脚本：模拟 TRAE 客户端对 MCP 服务端的连续调用行为（JSON/SSE 双模式），
// 覆盖连续工具调用、SSE 断流重连、重复 initialize、旧 session 404 拒绝等场景。
// 运行：node scripts/diagnose-session.mjs（DIAG_SSE=1 切换 SSE 模式）。
// 安全约束：不记录任何密码、令牌或请求体。
import { createMcpHttpApp } from '../src/app.mjs';
import { ConfirmationStore } from '../src/confirmation-store.mjs';
import { FixedWindowRateLimiter } from '../src/rate-limiter.mjs';
import { SessionRegistry } from '../src/session-registry.mjs';

const basic = `Basic ${Buffer.from('zhangsan:secret', 'utf8').toString('base64')}`;
const events = [];
const logger = {
  info: (e) => { events.push(`INFO ${e.event} ${e.method ?? ''} ${e.status ?? ''}`); },
  error: (e) => { events.push(`ERROR ${e.event} ${e.code ?? ''}`); },
};

const authProvider = {
  async authenticate() {
    return {
      userId: 'user-1', role: 'Manager', departmentId: 'dept-1',
      accessToken: 'access-1', refreshToken: 'refresh-1', tokenExpiresAt: Date.now() + 3_600_000,
    };
  },
  async refresh(context) { return context; },
  createUserClient() { return {}; },
};

const registry = new SessionRegistry({ ttlMs: 8 * 3_600_000, refreshWindowMs: 60_000, authProvider });

let callCount = 0;
const createWriteRepository = ({ getContext }) => ({
  getContext,
  async prepareUpdatePadTask({ taskId, changes }) {
    callCount += 1;
    return { expectedRowVersion: callCount - 1, current: { title: `old-${callCount}` }, changes: structuredClone(changes ?? {}) };
  },
  async lookupWriteResult() { return null; },
  async recordFailedWrite() {},
});

const application = createMcpHttpApp({
  config: {
    host: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'], requireHttps: false,
    requestTimeoutMs: 5000, rateLimitWindowMs: 60_000, rateLimitMax: 100,
    enableJsonResponse: process.env.DIAG_SSE === '1' ? false : true,
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
const base = `http://127.0.0.1:${server.address().port}/mcp`;
const mode = process.env.DIAG_SSE === '1' ? 'SSE' : 'JSON';

function post(body, sessionId) {
  return fetch(base, {
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

function toolCall(id, name, args, sessionId) {
  return post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sessionId);
}

async function readJsonOrText(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text.slice(0, 120); }
}

const results = [];
function report(step, res, extra = '') {
  const entry = `${step}: HTTP ${res.status} ${extra}`;
  results.push(entry);
  console.log(entry);
}

// --- 模拟 TRAE 序列 ---
const initRes = await post({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trae-sim', version: '1' } },
});
const initPayload = await readJsonOrText(initRes);
const sessionId = initRes.headers.get('mcp-session-id');
report('initialize', initRes, `session=${sessionId ? 'yes' : 'no'}`);

const notifRes = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
report('notifications/initialized', notifRes);

// TRAE 常见行为：打开 GET SSE 监听流
const sseController = new AbortController();
const sseResPromise = fetch(base, {
  method: 'GET',
  headers: { authorization: basic, accept: 'text/event-stream', 'mcp-session-id': sessionId },
  signal: sseController.signal,
}).catch((e) => ({ status: `ERR:${e.name}` }));
const sseRes = await sseResPromise;
report('GET sse open', sseRes);
void sseRes.body?.cancel?.().catch?.(() => {});

// 第一次 prepare_update（VERSION-A）
const first = await toolCall(2, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-A' } }, sessionId);
const firstBody = await readJsonOrText(first);
report('prepare_update #1', first, `isError=${firstBody?.result?.isError ?? firstBody?.error?.message ?? '?'} err=${JSON.stringify(firstBody?.result?.content?.[0]?.text ?? firstBody?.error ?? '').slice(0, 200)}`);

// 第二次 prepare_update（VERSION-B）—— 用户报错的关键场景
const second = await toolCall(3, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-B' } }, sessionId);
const secondBody = await readJsonOrText(second);
report('prepare_update #2', second, `isError=${secondBody?.result?.isError ?? secondBody?.error?.message ?? '?'}`);

// 关闭 SSE 流后立刻第三次调用（模拟 TRAE 断开监听流后再调用工具）
sseController.abort();
await new Promise((r) => setTimeout(r, 300));
const third = await toolCall(4, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-C' } }, sessionId);
const thirdBody = await readJsonOrText(third);
report('prepare_update #3 after SSE abort', third, `isError=${thirdBody?.result?.isError ?? thirdBody?.error?.message ?? '?'}`);

// SSE 流断开后重开（模拟 TRAE 重连监听流）—— 409 检查
const reSse = await fetch(base, {
  method: 'GET',
  headers: { authorization: basic, accept: 'text/event-stream', 'mcp-session-id': sessionId },
}).catch((e) => ({ status: `ERR:${e.name}` }));
report('GET sse reopen', reSse);
void reSse.body?.cancel?.().catch?.(() => {});

// 重开流后第四次调用
const fourth = await toolCall(5, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'VERSION-D' } }, sessionId);
const fourthBody = await readJsonOrText(fourth);
report('prepare_update #4 after reopen', fourth, `isError=${fourthBody?.result?.isError ?? fourthBody?.error?.message ?? '?'}`);

// 带旧 session-id 重复 initialize（部分客户端重连逻辑会这样）
const reInit = await post({
  jsonrpc: '2.0', id: 10, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trae-sim', version: '1' } },
}, sessionId);
const reInitSessionId = reInit.headers.get('mcp-session-id') ?? sessionId;
report('re-initialize with session-id', reInit, `newSession=${reInitSessionId !== sessionId ? 'yes' : 'same'}`);

// 旧 session-id 在回收后必须被拒绝（防止幽灵会话）
const staleCall = await toolCall(15, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'STALE' } }, sessionId);
report('stale session rejected', staleCall);

// 并发调用：TRAE 会同时发 listTools + callTool（使用 re-init 后的新 session）
const [c1, c2, c3] = await Promise.all([
  toolCall(11, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'CONCURRENT-1' } }, reInitSessionId),
  toolCall(12, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'CONCURRENT-2' } }, reInitSessionId),
  post({ jsonrpc: '2.0', id: 13, method: 'tools/list' }, reInitSessionId),
]);
report('concurrent #1', c1);
report('concurrent #2', c2);
report('concurrent tools/list', c3);

// 并发后串行调用确认会话仍健康
const afterConcurrent = await toolCall(14, 'prepare_update_pad_task', { taskId: 'task-1', changes: { title: 'AFTER-CONCURRENT' } }, reInitSessionId);
report('prepare_update after concurrent', afterConcurrent);

console.log(`\n--- mode=${mode} registry.size=${registry.size} ---`);
console.log('server events:', events.length ? events.join(' | ') : '(none)');

await application.close();
await new Promise((r) => server.close(r));
