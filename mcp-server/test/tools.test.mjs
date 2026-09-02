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

test('registers the phase-one read-only tools plus nested department people and weekly review gaps', () => {
  const tools = captureTools(fakeRepository());

  assert.deepEqual([...tools.keys()], [
    'get_organization_info',
    'get_department_people',
    'get_department_weekly_pad',
    'search_pad_tasks',
    'get_weekly_review_gaps',
    'get_company_okrs',
    'get_department_okrs',
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
  assert.equal(search.userName.safeParse('张三').success, true);
  assert.equal(search.departmentName.safeParse('市场部').success, true);
  assert.equal(search.month.safeParse('2026-08').success, true);
  assert.equal(search.month.safeParse('2026-13').success, false);
  assert.equal(search.relation.safeParse('participant').success, true);
  assert.equal(search.weekId.safeParse('2026-W53').success, true);
});

test('registers OKR tools with bounded year, period and includeTasks schemas', () => {
  const tools = captureTools(fakeRepository());
  const company = tools.get('get_company_okrs').definition.inputSchema;
  const department = tools.get('get_department_okrs').definition.inputSchema;

  assert.equal(company.year.safeParse(2026).success, true);
  assert.equal(company.year.safeParse(1999).success, false);
  assert.equal(company.year.safeParse(3001).success, false);
  assert.equal(company.includeTasks.safeParse(false).success, true);
  assert.equal(company.includeTasks.safeParse('yes').success, false);

  assert.equal(department.period.safeParse('Annual').success, true);
  assert.equal(department.period.safeParse('Q5').success, false);
  assert.equal(department.period.safeParse('annual').success, false);
  assert.equal(department.limit.safeParse(50).success, true);
  assert.equal(department.limit.safeParse(51).success, false);
  assert.equal(department.departmentName.safeParse('市场部').success, true);
});

test('returns compact OKR summaries with bound tasks in text and full data in structured content', async () => {
  const full = {
    year: 2026,
    okrCount: 1,
    okrs: [{
      id: 'c-okr-1',
      objective: '公司年度目标',
      keyResults: ['KR一', 'KR二'],
      krCount: 2,
      truncated: false,
      krTasks: [{
        krIndex: 0,
        krText: 'KR一',
        taskCount: 1,
        tasksTruncated: false,
        tasks: [{
          id: 't1', title: '绑定任务', status: 'in-progress', ownerId: 'u1', ownerName: '张三',
          departmentId: 'd1', departmentName: '市场部', targetWeeks: ['2026-W35'],
          startDate: 100, dueDate: 200,
        }],
      }],
    }],
  };
  const tools = captureTools(fakeRepository({
    getCompanyOkrs: async () => full,
  }));

  const result = await tools.get('get_company_okrs').handler({ year: 2026 });
  const summary = readTextSummary(result);

  assert.equal(result.structuredContent, full);
  assert.equal(summary.year, 2026);
  assert.equal(summary.okrCount, 1);
  assert.equal(summary.okrs[0].objective, '公司年度目标');
  assert.equal(summary.okrs[0].keyResults[0], 'KR一');
  assert.equal(summary.okrs[0].krTasks[0].tasks[0].title, '绑定任务');
  assert.equal(summary.okrs[0].krTasks[0].tasks[0].ownerName, '张三');
  assert.equal('ownerId' in summary.okrs[0].krTasks[0].tasks[0], false);
});

test('returns compact department OKR summaries with nested periods', async () => {
  const full = {
    year: 2026,
    period: null,
    departmentCount: 1,
    hasMore: false,
    departments: [{
      id: 'd1', name: '市场部', managerName: '张三', parentName: null,
      periods: {
        Annual: [{
          id: 'okr-1', objective: '年度目标', keyResults: ['KR一'], krCount: 1, truncated: false,
          krTasks: [{ krIndex: 0, krText: 'KR一', taskCount: 0, tasks: [], tasksTruncated: false }],
        }],
      },
    }],
  };
  const tools = captureTools(fakeRepository({
    getDepartmentOkrs: async () => full,
  }));

  const result = await tools.get('get_department_okrs').handler({ year: 2026 });
  const summary = readTextSummary(result);

  assert.equal(result.structuredContent, full);
  assert.equal(summary.departmentCount, 1);
  assert.equal(summary.departments[0].name, '市场部');
  assert.equal(summary.departments[0].periods.Annual[0].objective, '年度目标');
  assert.equal(summary.departments[0].periods.Annual[0].krTasks[0].krText, 'KR一');
  assert.ok(!('managerName' in summary.departments[0]) || summary.departments[0].managerName === '张三');
});

test('forwards OKR tool arguments to the repository unchanged', async () => {
  const calls = [];
  const tools = captureTools(fakeRepository({
    async getCompanyOkrs(args) { calls.push(['company', args]); return { year: 2026, okrCount: 0, okrs: [] }; },
    async getDepartmentOkrs(args) { calls.push(['department', args]); return { year: 2026, period: null, departmentCount: 0, hasMore: false, departments: [] }; },
  }));

  await tools.get('get_company_okrs').handler({ year: 2026, includeTasks: false });
  await tools.get('get_department_okrs').handler({ departmentId: 'd1', year: 2026, period: 'Q3', includeTasks: true, limit: 10 });

  assert.deepEqual(calls, [
    ['company', { year: 2026, includeTasks: false }],
    ['department', { departmentId: 'd1', year: 2026, period: 'Q3', includeTasks: true, limit: 10 }],
  ]);
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
    ownerName: '张三', ownerDepartmentName: '市场部',
    participantIds: ['u2'], participants: [{ id: 'u2', name: '李四', departmentId: 'd2', departmentName: '研发部' }],
    approverIds: ['missing-user'], approvers: [{ id: 'missing-user', name: null, departmentId: null, departmentName: null }],
    departmentId: 'd1', dueDate: 123, plan: 'private details', logs: [{ message: 'private details' }],
  };
  const tools = captureTools(fakeRepository({
    getDepartmentWeeklyPad: async () => ({ departmentId: 'd1', weekId: '2026-W34', limit: 10, tasks: [task], hasMore: false, truncated: false }),
    searchPadTasks: async () => ({ tasks: [task], offset: 0, limit: 10, total: 1, hasMore: false, truncated: false }),
    getPersonalWorkbench: async () => ({
      userId: 'u1', limit: 10, currentWeekId: '2026-W34', nextWeekId: '2026-W35',
      todayTasks: [task], thisWeekTasks: [task], nextWeekTasks: [], tasks: [task],
      pageInfo: {
        today: { hasMore: false, nextCursor: null, truncated: false },
        thisWeek: { hasMore: false, nextCursor: null, truncated: false },
        nextWeek: { hasMore: false, nextCursor: null, truncated: false },
      },
    }),
  }));

  const weekly = await tools.get('get_department_weekly_pad').handler({});
  const search = await tools.get('search_pad_tasks').handler({});
  const workbench = await tools.get('get_personal_workbench').handler({});

  assert.deepEqual(readTextSummary(weekly), {
    departmentId: 'd1', weekId: '2026-W34', hasMore: false, nextCursor: null, truncated: false, taskCount: 1,
    tasks: [{
      id: 't1', title: '季度复盘', status: 'in-progress', priority: 'high',
      ownerId: 'u1', ownerName: '张三', ownerDepartmentName: '市场部',
      departmentId: 'd1', dueDate: 123,
      participantIds: ['u2'], participants: [{ id: 'u2', name: '李四', departmentId: 'd2', departmentName: '研发部' }],
      approverIds: ['missing-user'], approvers: [{ id: 'missing-user', name: '人员不存在', departmentId: null, departmentName: null }],
    }],
  });
  assert.equal(readTextSummary(search).taskCount, 1);
  assert.equal(readTextSummary(search).total, 1);
  assert.equal(readTextSummary(workbench).userId, 'u1');
  assert.equal(readTextSummary(workbench).tasks[0].title, '季度复盘');
  assert.equal(readTextSummary(workbench).todayTaskCount, 1);
  assert.equal(readTextSummary(workbench).thisWeekTaskCount, 1);
  assert.equal(readTextSummary(workbench).nextWeekTaskCount, 0);
  assert.equal(readTextSummary(workbench).todayTasks[0].title, '季度复盘');
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
      return { userId: 'user-1', todayTasks: [], thisWeekTasks: [], nextWeekTasks: [], tasks: [] };
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

test('returns safe department candidates when a department name is ambiguous', async () => {
  const candidates = [
    {
      id: 'operations-east',
      name: '运营部',
      parentId: 'market-east',
      parentName: '华东市场部',
      rootId: 'market-east',
      rootName: '华东市场部',
      depth: 1,
      path: ['market-east', 'operations-east'],
      namePath: ['华东市场部', '运营部'],
      hasChildren: false,
    },
    {
      id: 'operations-west',
      name: '运营部',
      parentId: 'market-west',
      parentName: '华西市场部',
      rootId: 'market-west',
      rootName: '华西市场部',
      depth: 1,
      path: ['market-west', 'operations-west'],
      namePath: ['华西市场部', '运营部'],
      hasChildren: true,
    },
  ];
  const tools = captureTools(fakeRepository({
    async getDepartmentPeople() {
      throw new AppError('DEPARTMENT_NAME_AMBIGUOUS', undefined, 400, { candidates });
    },
  }));

  const result = await tools.get('get_department_people').handler({ departmentName: '运营部' });
  const publicError = JSON.parse(result.content[0].text);

  assert.equal(result.isError, true);
  assert.equal(publicError.code, 'DEPARTMENT_NAME_AMBIGUOUS');
  assert.deepEqual(publicError.details.candidates, candidates);
  assert.equal('managerUserId' in publicError.details.candidates[0], false);
});

test('registers weekly review gaps as a bounded read-only tool', async () => {
  const tools = captureTools(fakeRepository({
    async getWeeklyReviewGaps() {
      return {
        weekId: '2026-W33',
        groups: [{ user: { name: '张三', departmentName: '市场部' }, tasks: [{
          id: 't1', title: '任务一', departmentName: '市场部', reviewState: 'missing', inconsistent: true,
        }] }],
        total: 1, limit: 50, offset: 0, hasMore: false,
      };
    },
  }));

  assert.ok(tools.has('get_weekly_review_gaps'));
  const definition = tools.get('get_weekly_review_gaps').definition;
  assert.equal(definition.annotations.readOnlyHint, true);
  assert.equal(definition.inputSchema.weekId.safeParse('2026-W33').success, true);
  assert.equal(definition.inputSchema.weekId.safeParse('W33').success, false);
  assert.equal(definition.inputSchema.limit.safeParse(51).success, false);

  const result = await tools.get('get_weekly_review_gaps').handler({ weekId: '2026-W33' });
  assert.equal(result.isError, false);
  const summary = readTextSummary(result);
  assert.equal(summary.groups[0].user.name, '张三');
  assert.equal(summary.groups[0].tasks[0].reviewState, 'missing');
  assert.equal(summary.groups[0].tasks[0].departmentName, '市场部');
  assert.equal(summary.groups[0].tasks[0].inconsistent, true);
});
