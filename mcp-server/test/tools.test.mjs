import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../src/errors.mjs';
import { registerReadTools } from '../src/tools.mjs';

function captureTools(repository) {
  const tools = new Map();
  const server = {
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
  registerReadTools(server, repository);
  return tools;
}

function fakeRepository(overrides = {}) {
  return {
    getOrganizationInfo: async () => ({ strategy: null, departments: [], businesses: [] }),
    getDepartmentWeeklyPad: async (args) => ({ ...args, tasks: [] }),
    searchPadTasks: async (args) => ({ ...args, tasks: [] }),
    getPersonalWorkbench: async (args) => ({ userId: 'user-1', ...args, tasks: [] }),
    getProcessSipoc: async (args) => ({ ...args, processes: [] }),
    ...overrides,
  };
}

function readTextSummary(result) {
  const [, serialized] = result.content[0].text.split('\n', 2);
  return JSON.parse(serialized);
}

test('registers exactly the five phase-one read-only tools', () => {
  const tools = captureTools(fakeRepository());

  assert.deepEqual([...tools.keys()], [
    'get_organization_info',
    'get_department_weekly_pad',
    'search_pad_tasks',
    'get_personal_workbench',
    'get_process_sipoc',
  ]);
  for (const { definition } of tools.values()) {
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.annotations.destructiveHint, false);
    assert.ok(definition.inputSchema);
    assert.ok(definition.outputSchema);
  }
});

test('declares bounded pagination and weekly input schemas', () => {
  const tools = captureTools(fakeRepository());
  const weekly = tools.get('get_department_weekly_pad').definition.inputSchema;
  const search = tools.get('search_pad_tasks').definition.inputSchema;

  assert.equal(weekly.limit.safeParse(50).success, true);
  assert.equal(weekly.limit.safeParse(51).success, false);
  assert.equal(weekly.weekId.safeParse('2026-W34').success, true);
  assert.equal(weekly.weekId.safeParse('week-34').success, false);
  assert.equal(search.offset.safeParse(1000).success, true);
  assert.equal(search.offset.safeParse(1001).success, false);
});

test('returns both text and structured content for successful calls', async () => {
  const tools = captureTools(fakeRepository());

  const result = await tools.get('get_organization_info').handler({});

  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(result.structuredContent, { strategy: null, departments: [], businesses: [] });
});

test('does not duplicate a large structured payload inside text content', async () => {
  const largeValue = 'x'.repeat(70_000);
  const tools = captureTools(fakeRepository({
    async getOrganizationInfo() {
      return {
        strategy: { mission: largeValue },
        departments: [],
        businesses: [],
      };
    },
  }));

  const result = await tools.get('get_organization_info').handler({});

  assert.equal(result.structuredContent.strategy.mission, largeValue);
  assert.equal(result.content[0].text.includes(largeValue), false);
  assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') < 1024);
});

test('puts a compact organization summary in text while preserving full structured data', async () => {
  const full = {
    strategy: { mission: '使命', vision: '愿景', companyOKRs: { huge: 'x'.repeat(10_000) } },
    departments: [{ id: 'd1', name: '市场部', responsibilities: '增长' }],
    businesses: [{ id: 'b1', name: '产品线', customerNeeds: '需求' }],
  };
  const result = await captureTools(fakeRepository({ getOrganizationInfo: async () => full }))
    .get('get_organization_info').handler({});
  const summary = readTextSummary(result);

  assert.deepEqual(summary, {
    strategy: { mission: '使命', vision: '愿景' },
    departmentCount: 1,
    departments: [{ id: 'd1', name: '市场部' }],
    businessCount: 1,
    businesses: [{ id: 'b1', name: '产品线' }],
  });
  assert.equal(result.structuredContent, full);
  assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') < 2_000);
});

test('puts task counts and core fields in text summaries for weekly, search and workbench tools', async () => {
  const task = {
    id: 't1', title: '季度复盘', status: 'in-progress', priority: 'high', ownerId: 'u1',
    departmentId: 'd1', dueDate: 123, plan: 'private details', logs: [{ message: 'private details' }],
  };
  const tools = captureTools(fakeRepository({
    getDepartmentWeeklyPad: async () => ({ departmentId: 'd1', weekId: '2026-W34', limit: 10, tasks: [task] }),
    searchPadTasks: async () => ({ tasks: [task], offset: 0, limit: 10, total: 1, hasMore: false }),
    getPersonalWorkbench: async () => ({ userId: 'u1', limit: 10, tasks: [task] }),
  }));

  const weekly = await tools.get('get_department_weekly_pad').handler({});
  const search = await tools.get('search_pad_tasks').handler({});
  const workbench = await tools.get('get_personal_workbench').handler({});

  assert.deepEqual(readTextSummary(weekly), {
    departmentId: 'd1', weekId: '2026-W34', taskCount: 1,
    tasks: [{ id: 't1', title: '季度复盘', status: 'in-progress', priority: 'high', ownerId: 'u1', departmentId: 'd1', dueDate: 123 }],
  });
  assert.equal(readTextSummary(search).taskCount, 1);
  assert.equal(readTextSummary(search).total, 1);
  assert.equal(readTextSummary(workbench).userId, 'u1');
  assert.equal(readTextSummary(workbench).tasks[0].title, '季度复盘');
  assert.equal(weekly.structuredContent.tasks[0].plan, 'private details');
});

test('puts compact SIPOC nodes and links in the text summary', async () => {
  const process = {
    id: 'p1', departmentId: 'd1', name: '销售流程', level: 1, version: 'v1', isActive: true,
    owner: 'u1', objective: '目标',
    nodes: [{
      id: 'n1', label: '开始', description: '描述', type: 'start', x: 1, y: 2,
      sipoc: { inputs: ['订单'], standard: '标准', outputs: ['结果'], customers: ['客户'], ownerRole: '销售' },
      subProcessNodes: [{ id: 'nested', label: '不应展开' }],
    }],
    links: [{ id: 'l1', from: 'n1', to: 'n2', label: '下一步' }],
  };
  const result = await captureTools(fakeRepository({
    getProcessSipoc: async () => ({ limit: 5, processes: [process] }),
  })).get('get_process_sipoc').handler({});
  const summary = readTextSummary(result);

  assert.equal(summary.processCount, 1);
  assert.equal(summary.processes[0].nodeCount, 1);
  assert.equal(summary.processes[0].linkCount, 1);
  assert.equal(summary.processes[0].nodes[0].sipoc.standard, '标准');
  assert.deepEqual(summary.processes[0].links, [{ id: 'l1', from: 'n1', to: 'n2', label: '下一步' }]);
  assert.equal(result.structuredContent.processes[0].nodes[0].subProcessNodes[0].id, 'nested');
});

test('never accepts an external user id for the personal workbench', async () => {
  const calls = [];
  const tools = captureTools(fakeRepository({
    async getPersonalWorkbench(args) {
      calls.push(args);
      return { userId: 'user-1', tasks: [] };
    },
  }));

  await tools.get('get_personal_workbench').handler({ userId: 'attacker', limit: 10 });

  assert.deepEqual(calls, [{ limit: 10 }]);
  assert.equal('userId' in tools.get('get_personal_workbench').definition.inputSchema, false);
});

test('returns only a stable error code and message when a repository call fails', async () => {
  const secretError = new AppError('DATA_ACCESS_FAILED', '数据读取失败，请稍后重试。', 502);
  secretError.stack = 'internal stack with secret-token';
  const tools = captureTools(fakeRepository({
    async searchPadTasks() { throw secretError; },
  }));

  const result = await tools.get('search_pad_tasks').handler({});
  const serialized = JSON.stringify(result);

  assert.equal(result.isError, true);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('stack'), false);
  assert.equal(serialized.includes('DATA_ACCESS_FAILED'), true);
});
