import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpApp } from '../src/app.mjs';
import { ConfirmationStore } from '../src/confirmation-store.mjs';
import { FixedWindowRateLimiter } from '../src/rate-limiter.mjs';
import { SessionRegistry } from '../src/session-registry.mjs';

const basic = `Basic ${Buffer.from('zhangsan:secret', 'utf8').toString('base64')}`;

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('official MCP client initializes, lists fifteen tools, calls one and terminates the session', async (t) => {
  const authProvider = {
    calls: 0,
    async checkReadiness() { return { status: 'ready', releaseId: 'test' }; },
    async authenticate() {
      this.calls += 1;
      return {
        userId: 'user-1', role: 'Employee', departmentId: 'dept-1',
        accessToken: 'access-1', refreshToken: 'refresh-1', tokenExpiresAt: Date.now() + 60_000,
      };
    },
    async refresh(context) { return context; },
    createUserClient() { throw new Error('integration test must not call Supabase'); },
  };
  const registry = new SessionRegistry({
    ttlMs: 60_000, refreshWindowMs: 1000, authProvider, now: Date.now,
  });
  const repository = {
    getOrganizationInfo: async () => ({ strategy: null, departments: [], businesses: [] }),
    getDepartmentWeeklyPad: async (args) => ({ ...args, tasks: [] }),
    searchPadTasks: async (args) => ({ ...args, tasks: [], total: 0, hasMore: false }),
    getPersonalWorkbench: async ({ limit }) => ({
      userId: 'user-1', limit, todayTasks: [], thisWeekTasks: [], nextWeekTasks: [], tasks: [],
      pageInfo: {
        today: { hasMore: false, nextCursor: null, truncated: false },
        thisWeek: { hasMore: false, nextCursor: null, truncated: false },
        nextWeek: { hasMore: false, nextCursor: null, truncated: false },
      },
    }),
    getProcessSipoc: async ({ limit }) => ({ limit, processes: [] }),
    getWeeklyReviewGaps: async ({ weekId, limit, offset = 0 }) => ({ weekId, groups: [], total: 0, limit, offset, hasMore: false }),
    getCompanyOkrs: async ({ year, includeTasks }) => ({
      year, okrCount: 1,
      okrs: [{
        id: 'c-okr-1', objective: '公司目标', keyResults: ['KR一'], krCount: 1, truncated: false,
        krTasks: includeTasks === false ? [] : [{
          krIndex: 0, krText: 'KR一', taskCount: 1, tasksTruncated: false,
          tasks: [{ id: 't1', title: '绑定任务', status: 'in-progress', ownerId: 'u1', ownerName: '张三', departmentId: 'dept-1', departmentName: '部门一', targetWeeks: ['2026-W35'], startDate: 100, dueDate: 200 }],
        }],
      }],
    }),
    getDepartmentOkrs: async ({ year, period }) => ({
      year, period: period ?? null, departmentCount: 1, hasMore: false,
      departments: [{
        id: 'dept-1', name: '部门一', managerName: '张三', parentName: null,
        periods: { Annual: [{ id: 'okr-1', objective: '年度目标', keyResults: ['KR一'], krCount: 1, truncated: false, krTasks: [] }] },
      }],
    }),
  };
  const writeResults = new Map();
  const createWriteRepository = ({ getContext }) => ({
    getContext,
    async prepareCreatePadTask({ payload }) { return { payload }; },
    async lookupWriteResult({ toolName, requestId }) {
      return writeResults.get(`${toolName}:${requestId}`) ?? null;
    },
    async commitCreatePadTask({ payload, requestId }) {
      const result = { replayed: false, task: { id: 'task-1', ...payload }, rowVersion: 0 };
      writeResults.set(`commit_create_pad_task:${requestId}`, { status: 'success', resultSummary: result });
      return result;
    },
    async recordFailedWrite() {},
  });
  const confirmationStore = new ConfirmationStore({ ttlMs: 60_000 });
  const application = createMcpHttpApp({
    config: {
      host: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'], requireHttps: false,
      requestTimeoutMs: 1000, rateLimitWindowMs: 60_000, rateLimitMax: 30,
    },
    authProvider,
    sessionRegistry: registry,
    rateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 30 }),
    createRepository: () => repository,
    createWriteRepository,
    confirmationStore,
    logger: { info() {}, error() {} },
  });
  const http = await listen(application.app);
  const transport = new StreamableHTTPClientTransport(new URL(http.url), {
    requestInit: { headers: { Authorization: basic } },
  });
  const client = new Client({ name: 'phase-one-test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await http.close();
    await application.close();
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'get_organization_info',
    'get_department_people',
    'get_department_weekly_pad',
    'search_pad_tasks',
    'get_weekly_review_gaps',
    'get_company_okrs',
    'get_department_okrs',
    'get_personal_workbench',
    'get_process_sipoc',
    'prepare_create_pad_task',
    'commit_create_pad_task',
    'prepare_update_pad_task',
    'commit_update_pad_task',
    'submit_pad_task',
    'save_review_record',
  ]);
  assert.equal(tools.tools.filter((tool) => tool.annotations?.readOnlyHint === true).length, 9);

  const result = await client.callTool({ name: 'get_personal_workbench', arguments: { limit: 5 } });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, {
    userId: 'user-1', limit: 5, todayTasks: [], thisWeekTasks: [], nextWeekTasks: [], tasks: [],
    pageInfo: {
      today: { hasMore: false, nextCursor: null, truncated: false },
      thisWeek: { hasMore: false, nextCursor: null, truncated: false },
      nextWeek: { hasMore: false, nextCursor: null, truncated: false },
    },
  });
  assert.equal(authProvider.calls, 1);
  assert.equal(registry.size, 1);

  const companyOkrs = await client.callTool({
    name: 'get_company_okrs',
    arguments: { year: 2026 },
  });
  assert.equal(companyOkrs.isError, false);
  assert.equal(companyOkrs.structuredContent.okrs[0].krTasks[0].tasks[0].title, '绑定任务');

  const departmentOkrs = await client.callTool({
    name: 'get_department_okrs',
    arguments: { departmentId: 'dept-1', year: 2026, period: 'Annual' },
  });
  assert.equal(departmentOkrs.isError, false);
  assert.equal(departmentOkrs.structuredContent.departments[0].periods.Annual[0].objective, '年度目标');

  const prepared = await client.callTool({
    name: 'prepare_create_pad_task',
    arguments: { payload: { title: '协议测试任务' } },
  });
  assert.equal(prepared.isError, false);
  const confirmationToken = prepared.structuredContent.confirmationToken;
  const commitArguments = {
    title: '协议测试任务',
    confirmationToken,
    requestId: 'protocol-request-1',
  };
  const committed = await client.callTool({ name: 'commit_create_pad_task', arguments: commitArguments });
  assert.equal(committed.isError, false);
  assert.equal(committed.structuredContent.replayed, false);
  const replayed = await client.callTool({ name: 'commit_create_pad_task', arguments: commitArguments });
  assert.equal(replayed.isError, false);
  assert.equal(replayed.structuredContent.replayed, true);

  const unused = await client.callTool({
    name: 'prepare_create_pad_task',
    arguments: { payload: { title: '等待会话撤销的任务' } },
  });
  assert.equal(unused.isError, false);
  assert.equal(confirmationStore.size, 1);

  await transport.terminateSession();
  await client.close();
  assert.equal(registry.size, 0);
  assert.equal(confirmationStore.size, 0);
});

test('targetWeeks-only creation auto-fills dates and lands in today and this-week work', async (t) => {
  // 固定“当前时间”为 2026-08-27（周四，2026-W35），与线上过滤逻辑对齐。
  const nowMs = Date.parse('2026-08-27T04:00:00.000Z');
  const now = () => nowMs;
  const authProvider = {
    async checkReadiness() { return { status: 'ready', releaseId: 'test' }; },
    async authenticate() {
      return {
        userId: 'user-1', role: 'Employee', departmentId: 'dept-1',
        accessToken: 'access-1', refreshToken: 'refresh-1', tokenExpiresAt: nowMs + 60_000,
      };
    },
    async refresh(context) { return context; },
    createUserClient() { throw new Error('integration test must not call Supabase'); },
  };
  const registry = new SessionRegistry({
    ttlMs: 60_000, refreshWindowMs: 1000, authProvider, now,
  });
  const storedTasks = [];
  const writeResults = new Map();
  const createWriteRepository = ({ getContext }) => ({
    getContext,
    async prepareCreatePadTask({ payload }) { return { payload }; },
    async lookupWriteResult({ toolName, requestId }) {
      return writeResults.get(`${toolName}:${requestId}`) ?? null;
    },
    async commitCreatePadTask({ payload, requestId }) {
      const task = { id: `task-${storedTasks.length + 1}`, ...payload };
      storedTasks.push(task);
      const result = { replayed: false, task, rowVersion: 0 };
      writeResults.set(`commit_create_pad_task:${requestId}`, { status: 'success', resultSummary: result });
      return result;
    },
    async recordFailedWrite() {},
  });
  // 与 repository.mjs 相同的双维度过滤：今日按 start_date/due_date，本周按 target_weeks。
  const repository = {
    getPersonalWorkbench: async ({ limit }) => {
      const isToday = (row) => Number.isFinite(row.startDate) && Number.isFinite(row.dueDate)
        && nowMs >= row.startDate && nowMs <= row.dueDate;
      const hasWeek = (row, weekId) => Array.isArray(row.targetWeeks) && row.targetWeeks.includes(weekId);
      return {
        userId: 'user-1', limit,
        todayTasks: storedTasks.filter(isToday),
        thisWeekTasks: storedTasks.filter((row) => hasWeek(row, '2026-W35')),
        nextWeekTasks: [],
        tasks: storedTasks,
        pageInfo: {
          today: { hasMore: false, nextCursor: null, truncated: false },
          thisWeek: { hasMore: false, nextCursor: null, truncated: false },
          nextWeek: { hasMore: false, nextCursor: null, truncated: false },
        },
      };
    },
  };
  const application = createMcpHttpApp({
    config: {
      host: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'], requireHttps: false,
      requestTimeoutMs: 1000, rateLimitWindowMs: 60_000, rateLimitMax: 30,
    },
    authProvider,
    sessionRegistry: registry,
    rateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 30 }),
    createRepository: () => repository,
    createWriteRepository,
    confirmationStore: new ConfirmationStore({ ttlMs: 60_000, now }),
    logger: { info() {}, error() {} },
  });
  const http = await listen(application.app);
  const transport = new StreamableHTTPClientTransport(new URL(http.url), {
    requestInit: { headers: { Authorization: basic } },
  });
  const client = new Client({ name: 'phase-one-test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await http.close();
    await application.close();
  });
  await client.connect(transport);

  const prepared = await client.callTool({
    name: 'prepare_create_pad_task',
    arguments: { payload: { title: '只填周次任务', targetWeeks: ['2026-W35'] } },
  });
  assert.equal(prepared.isError, false);
  // 预览中就能看到自动填充后的起止时间（校准基准值）。
  assert.equal(prepared.structuredContent.preview.payload.startDate, 1787572800000);
  assert.equal(prepared.structuredContent.preview.payload.dueDate, 1788091200000);

  const committed = await client.callTool({
    name: 'commit_create_pad_task',
    arguments: {
      title: '只填周次任务',
      targetWeeks: ['2026-W35'],
      confirmationToken: prepared.structuredContent.confirmationToken,
      requestId: 'protocol-week-fill-1',
    },
  });
  assert.equal(committed.isError, false);
  assert.equal(committed.structuredContent.task.startDate, 1787572800000);
  assert.equal(committed.structuredContent.task.dueDate, 1788091200000);

  const workbench = await client.callTool({ name: 'get_personal_workbench', arguments: { limit: 10 } });
  assert.equal(workbench.isError, false);
  const taskId = committed.structuredContent.task.id;
  assert.equal(workbench.structuredContent.todayTasks.some((task) => task.id === taskId), true);
  assert.equal(workbench.structuredContent.thisWeekTasks.some((task) => task.id === taskId), true);

  await transport.terminateSession();
});

test('uses JSON responses for request/response MCP clients', async (t) => {
  const authProvider = {
    async checkReadiness() { return { status: 'ready', releaseId: 'test' }; },
    async authenticate() {
      return {
        userId: 'user-json', role: 'Employee', departmentId: 'dept-json',
        accessToken: 'access-json', refreshToken: 'refresh-json', tokenExpiresAt: Date.now() + 60_000,
      };
    },
    async refresh(context) { return context; },
    createUserClient() { throw new Error('JSON response test must not call Supabase'); },
  };
  const registry = new SessionRegistry({
    ttlMs: 60_000, refreshWindowMs: 1000, authProvider, now: Date.now,
  });
  const application = createMcpHttpApp({
    config: {
      host: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'], requireHttps: false,
      requestTimeoutMs: 1000, rateLimitWindowMs: 60_000, rateLimitMax: 30, enableJsonResponse: true,
    },
    authProvider,
    sessionRegistry: registry,
    rateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 30 }),
    createRepository: () => ({
      getPersonalWorkbench: async ({ limit }) => ({ userId: 'user-json', limit, todayTasks: [], thisWeekTasks: [], nextWeekTasks: [], tasks: [] }),
    }),
    logger: { info() {}, error() {} },
  });
  const http = await listen(application.app);
  t.after(async () => {
    await http.close();
    await application.close();
  });

  const response = await fetch(http.url, {
    method: 'POST',
    headers: {
      authorization: basic,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'json-test', version: '1' } },
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  const payload = await response.json();
  assert.equal(payload.result.protocolVersion, '2025-06-18');
  assert.equal(registry.size, 1);
});
