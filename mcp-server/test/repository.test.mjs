import test from 'node:test';
import assert from 'node:assert/strict';

import { createReadRepository } from '../src/repository.mjs';
import { getCurrentIsoWeekPeriod } from '../src/task-period-defaults.mjs';

function fakeSupabase(results = {}) {
  const calls = [];

  function query(table) {
    const chain = {
      select(...args) { calls.push([table, 'select', ...args]); return chain; },
      eq(...args) { calls.push([table, 'eq', ...args]); return chain; },
      contains(...args) { calls.push([table, 'contains', ...args]); return chain; },
      ilike(...args) { calls.push([table, 'ilike', ...args]); return chain; },
      order(...args) { calls.push([table, 'order', ...args]); return chain; },
      range(...args) { calls.push([table, 'range', ...args]); return chain; },
      limit(...args) { calls.push([table, 'limit', ...args]); return chain; },
      or(...args) { calls.push([table, 'or', ...args]); return chain; },
      async maybeSingle() {
        calls.push([table, 'maybeSingle']);
        return results[table] ?? { data: null, error: null };
      },
      then(resolve, reject) {
        return Promise.resolve(results[table] ?? { data: [], error: null, count: 0 }).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    calls,
    client: {
      from(table) { calls.push(['from', table]); return query(table); },
      async rpc(name, args) {
        calls.push(['rpc', name, args]);
        if (['mcp_get_personal_workbench_page', 'mcp_get_visible_tasks_page'].includes(name)
          && !Object.prototype.hasOwnProperty.call(results, `rpc:${name}`)) {
          return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        }
        if (name === 'mcp_get_task_people' && !Object.prototype.hasOwnProperty.call(results, `rpc:${name}`)) {
          return {
            data: {
              tasks: (args?.p_task_ids ?? []).map((taskId) => ({
                task_id: taskId, owner: null, participants: [], approvers: [],
              })),
            },
            error: null,
          };
        }
        const configured = results[`rpc:${name}`];
        if (typeof configured === 'function') return configured(args, calls);
        return configured ?? { data: [], error: null };
      },
    },
  };
}

function repository(fake, context = { userId: 'user-1', accessToken: 'jwt-1' }, now = Date.now) {
  const tokens = [];
  const logs = [];
  return {
    tokens,
    logs,
    value: createReadRepository({
      createUserClient(token) {
        tokens.push(token);
        return fake.client;
      },
      getContext: () => context,
      requestTimeoutMs: 1000,
      logger: { error(event) { logs.push(event); } },
      now,
    }),
  };
}

function identityRepository(overrides = {}) {
  return {
    async resolveUser(input) {
      return {
        userId: 'user-1', name: input.name, role: 'Employee',
        departmentId: 'dept-1', departmentName: input.departmentName ?? '市场部',
      };
    },
    ...overrides,
  };
}

test('reads organization information with a user JWT and omits sensitive department fields', async () => {
  const fake = fakeSupabase({
    strategy: { data: { id: 'default', mission: '使命', vision: '愿景', company_okrs: {} }, error: null },
    departments: {
      data: [{
        id: 'd1', name: '市场部', manager_name: '张三', responsibilities: '增长', attributes: '业务', okrs: {},
        role_members: { secret: ['u1'] }, reviews: { secret: [] },
        sub_departments: [{
          id: 'd1-1', name: '运营部', reviews: { secret: [] }, roleMembers: { secret: ['u2'] },
          sub_departments: [{ id: 'd1-1-1', name: '用户运营组', reviews: { secret: [] } }],
        }],
      }],
      error: null,
    },
    businesses: { data: [{ id: 'b1', name: '零售' }], error: null },
  });
  const repo = repository(fake);

  const result = await repo.value.getOrganizationInfo();

  assert.deepEqual(repo.tokens, ['jwt-1']);
  assert.equal(result.departments[0].name, '市场部');
  assert.equal('roleMembers' in result.departments[0], false);
  assert.equal('reviews' in result.departments[0], false);
  assert.equal(result.departments[0].subDepartments[0].name, '运营部');
  assert.equal(result.departments[0].subDepartments[0].subDepartments[0].name, '用户运营组');
  assert.equal('reviews' in result.departments[0].subDepartments[0], false);
  assert.equal('roleMembers' in result.departments[0].subDepartments[0], false);
});

test('preserves the public read repository method contract', () => {
  const fake = fakeSupabase();
  assert.deepEqual(Object.keys(repository(fake).value).sort(), [
    'getCompanyOkrs',
    'getDepartmentOkrs',
    'getDepartmentPeople',
    'getDepartmentWeeklyPad',
    'getOrganizationInfo',
    'getPersonalWorkbench',
    'getProcessSipoc',
    'getWeeklyReviewGaps',
    'searchPadTasks',
  ]);
});

test('filters weekly PAD from the existing visible-task RPC and caps the result limit', async () => {
  const fake = fakeSupabase({
    'rpc:get_visible_tasks_full': {
      data: [
        {
          id: 't1', title: '匹配任务', department_id: 'd1', target_weeks: ['2026-W34'],
          owner_id: 'u1', participant_ids: ['u2'], approver_ids: ['missing-user'],
        },
        { id: 't2', title: '其他部门', department_id: 'd2', target_weeks: ['2026-W34'] },
        { id: 't3', title: '其他周次', department_id: 'd1', target_weeks: ['2026-W35'] },
      ],
      error: null,
    },
    'rpc:mcp_get_task_people': {
      data: {
        tasks: [{
          task_id: 't1',
          owner: { id: 'u1', name: '张三', department_id: 'd1', department_name: '市场部' },
          participants: [{ id: 'u2', name: '李四', department_id: 'd2', department_name: '研发部' }],
          approvers: [{ id: 'missing-user', name: null, department_id: null, department_name: null }],
        }],
      },
      error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.getDepartmentWeeklyPad({ departmentId: 'd1', scope: 'exact', weekId: '2026-W34', limit: 999 });

  assert.deepEqual(result.tasks.map((task) => task.id), ['t1']);
  assert.equal(result.tasks[0].targetWeeks[0], '2026-W34');
  assert.equal(result.tasks[0].ownerId, 'u1');
  assert.equal(result.tasks[0].ownerName, '张三');
  assert.equal(result.tasks[0].ownerDepartmentName, '市场部');
  assert.deepEqual(result.tasks[0].participants, [{ id: 'u2', name: '李四', departmentId: 'd2', departmentName: '研发部' }]);
  assert.deepEqual(result.tasks[0].approvers, [{ id: 'missing-user', name: null, departmentId: null, departmentName: null }]);
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_task_people'), [
    'rpc', 'mcp_get_task_people', { p_task_ids: ['t1'] },
  ]);
  assert.equal(fake.calls.filter((call) => call[1] === 'mcp_get_task_people').length, 1);
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_visible_tasks_page'), ['rpc', 'mcp_get_visible_tasks_page', {
    p_limit: 50,
    p_cursor_updated_at: null,
    p_cursor_id: null,
    p_department_id: 'd1',
    p_status: null,
    p_week_id: '2026-W34',
    p_query: null,
  }]);
  assert.equal(fake.calls.some((call) => call[0] === 'from' && call[1] === 'tasks'), false);
});

test('filters task search from the existing visible-task RPC without raw PostgREST filters', async () => {
  const fake = fakeSupabase({
    'rpc:get_visible_tasks_full': {
      data: [
        { id: 't1', title: '季度复盘', department_id: 'd1', status: 'in-progress' },
        { id: 't2', title: '季度复盘', department_id: 'd2', status: 'in-progress' },
        { id: 't3', title: '月度复盘', department_id: 'd1', status: 'done' },
      ],
      error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.searchPadTasks({
    query: ' 季度复盘 ', departmentId: 'd1', scope: 'exact', status: 'in-progress', limit: 20, offset: 5,
  });

  assert.deepEqual(result, {
    tasks: [], offset: 5, limit: 20, total: 1, hasMore: false, nextCursor: null, truncated: false,
  });
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_visible_tasks_page'), ['rpc', 'mcp_get_visible_tasks_page', {
    p_limit: 50,
    p_cursor_updated_at: null,
    p_cursor_id: null,
    p_department_id: 'd1',
    p_status: 'in-progress',
    p_week_id: null,
    p_query: '季度复盘',
  }]);
  assert.equal(fake.calls.some((call) => call[0] === 'from' && call[1] === 'tasks'), false);
});

test('falls back to the bounded direct weekly query only when the visible-task RPC is missing', async () => {
  const fake = fakeSupabase({
    'rpc:get_visible_tasks_full': { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
    tasks: { data: [{ id: 't1', title: '任务', target_weeks: ['2026-W34'] }], error: null },
  });
  const repo = repository(fake);

  const result = await repo.value.getDepartmentWeeklyPad({ departmentId: 'd1', scope: 'exact', weekId: '2026-W34', limit: 10 });

  assert.equal(result.tasks.length, 1);
  assert.ok(fake.calls.some((call) => call[0] === 'tasks' && call[1] === 'eq' && call[2] === 'department_id' && call[3] === 'd1'));
  assert.ok(fake.calls.some((call) => call[0] === 'tasks' && call[1] === 'contains' && call[2] === 'target_weeks'));
});

test('always gets the personal workbench for the authenticated business user', async () => {
  const now = Date.UTC(2026, 7, 26, 4);
  const weekId = getCurrentIsoWeekPeriod(now).weekId;
  const fake = fakeSupabase({
    'rpc:get_my_workbench_tasks': { data: [{ id: 't1', owner_id: 'user-1', title: '我的任务', target_weeks: [weekId] }], error: null },
  });
  const repo = repository(fake, { userId: 'user-1', accessToken: 'jwt-1' }, () => now);

  const result = await repo.value.getPersonalWorkbench({ userId: 'attacker-user', limit: 10 });

  assert.equal(result.userId, 'user-1');
  assert.equal(result.tasks[0].ownerId, 'user-1');
  assert.equal(result.thisWeekTasks.length, 1);
  assert.deepEqual(fake.calls.find((call) => call[0] === 'rpc'), ['rpc', 'mcp_get_personal_workbench_page', {
    p_limit: 10,
    p_today_cursor_updated_at: null,
    p_today_cursor_id: null,
    p_this_week_id: weekId,
    p_this_week_cursor_updated_at: null,
    p_this_week_cursor_id: null,
    p_next_week_id: getCurrentIsoWeekPeriod(now + (7 * 24 * 60 * 60 * 1000)).weekId,
    p_next_week_cursor_updated_at: null,
    p_next_week_cursor_id: null,
  }]);
});

test('groups only today, current-week and next-week tasks and allows overlap', async () => {
  const now = Date.UTC(2026, 11, 31, 4);
  const currentWeekId = getCurrentIsoWeekPeriod(now).weekId;
  const nextWeekId = getCurrentIsoWeekPeriod(now + (7 * 24 * 60 * 60 * 1000)).weekId;
  const fake = fakeSupabase({
    'rpc:get_my_workbench_tasks': {
      data: [
        { id: 'today-week', owner_id: 'user-1', start_date: now - 1000, due_date: now + 1000, target_weeks: [currentWeekId] },
        { id: 'next-week', owner_id: 'user-1', target_weeks: [nextWeekId] },
        { id: 'history', owner_id: 'user-1', target_weeks: ['2025-W01'] },
      ],
      error: null,
    },
  });
  const repo = repository(fake, { userId: 'user-1', accessToken: 'jwt-1' }, () => now);

  const result = await repo.value.getPersonalWorkbench({ limit: 10 });

  assert.equal(result.currentWeekId, currentWeekId);
  assert.equal(result.nextWeekId, nextWeekId);
  assert.deepEqual(result.todayTasks.map((task) => task.id), ['today-week']);
  assert.deepEqual(result.thisWeekTasks.map((task) => task.id), ['today-week']);
  assert.deepEqual(result.nextWeekTasks.map((task) => task.id), ['next-week']);
  assert.deepEqual(result.tasks.map((task) => task.id).sort(), ['next-week', 'today-week']);
});

test('enriches 150 workbench candidates in bounded people batches', async () => {
  const sourceRows = Array.from({ length: 150 }, (_, index) => ({
    id: `task-${index}`, title: `任务${index}`, department_id: 'd1', target_weeks: ['2026-W34'],
  }));
  const fake = fakeSupabase();
  const peopleCalls = [];
  fake.client.rpc = async (name, args) => {
    fake.calls.push(['rpc', name, args]);
    if (name === 'mcp_get_personal_workbench_page') {
      const page = (items) => ({ items, hasMore: false, nextCursor: null, truncated: false });
      return { data: {
        today: page(sourceRows.slice(0, 50)),
        thisWeek: page(sourceRows.slice(50, 100)),
        nextWeek: page(sourceRows.slice(100, 150)),
      }, error: null };
    }
    if (name === 'mcp_get_task_people') {
      peopleCalls.push(args.p_task_ids);
      return { data: { tasks: args.p_task_ids.map((id) => ({ task_id: id, owner: null, participants: [], approvers: [] })) }, error: null };
    }
    return { data: [], error: null };
  };
  const repo = repository(fake);

  const result = await repo.value.getPersonalWorkbench({ limit: 50 });

  assert.equal(result.tasks.length, 150);
  assert.equal(peopleCalls.length, 3);
  assert.deepEqual(peopleCalls.map((batch) => batch.length), [50, 50, 50]);
});

test('splits 51 workbench candidates into 50 and 1 people batches', async () => {
  const sourceRows = Array.from({ length: 51 }, (_, index) => ({
    id: `task-${index}`, title: `任务${index}`, department_id: 'd1', target_weeks: ['2026-W34'],
  }));
  const fake = fakeSupabase();
  const peopleCalls = [];
  fake.client.rpc = async (name, args) => {
    fake.calls.push(['rpc', name, args]);
    if (name === 'mcp_get_personal_workbench_page') {
      const page = (items) => ({ items, hasMore: false, nextCursor: null, truncated: false });
      return { data: {
        today: page(sourceRows.slice(0, 50)),
        thisWeek: page(sourceRows.slice(50)),
        nextWeek: page([]),
      }, error: null };
    }
    if (name === 'mcp_get_task_people') {
      peopleCalls.push(args.p_task_ids);
      return { data: { tasks: args.p_task_ids.map((id) => ({ task_id: id, owner: null, participants: [], approvers: [] })) }, error: null };
    }
    return { data: [], error: null };
  };
  const repo = repository(fake);

  const result = await repo.value.getPersonalWorkbench({ limit: 50 });

  assert.equal(result.tasks.length, 51);
  assert.deepEqual(peopleCalls.map((batch) => batch.length), [50, 1]);
});

test('keeps one task repeated in today, this-week and next-week groups', async () => {
  const now = Date.UTC(2026, 7, 26, 4);
  const currentWeekId = getCurrentIsoWeekPeriod(now).weekId;
  const nextWeekId = getCurrentIsoWeekPeriod(now + (7 * 24 * 60 * 60 * 1000)).weekId;
  const taskRow = {
    id: 'overlap', owner_id: 'user-1', title: '跨栏任务', start_date: now - 1000, due_date: now + 1000,
    target_weeks: [currentWeekId, nextWeekId],
  };
  const fake = fakeSupabase({
    'rpc:mcp_get_personal_workbench_page': {
      data: {
        today: { items: [taskRow], hasMore: false, nextCursor: null, truncated: false },
        thisWeek: { items: [taskRow], hasMore: false, nextCursor: null, truncated: false },
        nextWeek: { items: [taskRow], hasMore: false, nextCursor: null, truncated: false },
      }, error: null,
    },
  });
  const repo = repository(fake, { userId: 'user-1', accessToken: 'jwt-1' }, () => now);

  const result = await repo.value.getPersonalWorkbench({ limit: 10 });

  assert.deepEqual(result.todayTasks.map((task) => task.id), ['overlap']);
  assert.deepEqual(result.thisWeekTasks.map((task) => task.id), ['overlap']);
  assert.deepEqual(result.nextWeekTasks.map((task) => task.id), ['overlap']);
  assert.deepEqual(result.tasks.map((task) => task.id), ['overlap']);
});

test('marks an unusable workbench cursor as truncated instead of claiming it can continue', async () => {
  const page = { items: [{ id: 't1', title: '任务' }], hasMore: true, nextCursor: null, truncated: false };
  const fake = fakeSupabase({
    'rpc:mcp_get_personal_workbench_page': {
      data: {
        today: page,
        thisWeek: { items: [], hasMore: false, nextCursor: null, truncated: false },
        nextWeek: { items: [], hasMore: false, nextCursor: null, truncated: false },
      },
      error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.getPersonalWorkbench({ limit: 10 });

  assert.equal(result.pageInfo.today.hasMore, false);
  assert.equal(result.pageInfo.today.nextCursor, null);
  assert.equal(result.pageInfo.today.truncated, true);
});

test('rejects malformed workbench paging data without falling back to the legacy RPC', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_personal_workbench_page': {
      data: {
        today: { items: null, hasMore: false },
        thisWeek: { items: [], hasMore: false },
        nextWeek: { items: [], hasMore: false },
      },
      error: null,
    },
    'rpc:get_my_workbench_tasks': { data: [{ id: 'legacy' }], error: null },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.getPersonalWorkbench({ limit: 10 }),
    (error) => error.code === 'DATA_ACCESS_FAILED' && error.message.includes('分页结果格式错误'),
  );
  assert.equal(fake.calls.some((call) => call[1] === 'get_my_workbench_tasks'), false);
});

test('stops a malformed visible-task page with an explicit truncated result', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_visible_tasks_page': {
      data: {
        items: [{ id: 't1', title: '任务' }], hasMore: true, nextCursor: null, truncated: false,
      }, error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.searchPadTasks({ limit: 10, offset: 0 });

  assert.equal(result.truncated, true);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.tasks.map((task) => task.id), ['t1']);
});

test('rejects an invalid visible-task page shape without using the legacy full query', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_visible_tasks_page': { data: { items: null, hasMore: false }, error: null },
    'rpc:get_visible_tasks_full': { data: [{ id: 'legacy' }], error: null },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.searchPadTasks({ limit: 10 }),
    (error) => error.code === 'DATA_ACCESS_FAILED' && error.message.includes('分页结果格式错误'),
  );
  assert.equal(fake.calls.some((call) => call[1] === 'get_visible_tasks_full'), false);
});

test('reads 5000 visible tasks through stable cursors without duplicates or omissions', async () => {
  const sourceRows = Array.from({ length: 5000 }, (_, index) => ({
    id: `task-${String(5000 - index).padStart(5, '0')}`,
    title: `任务${index}`,
    updated_at: 100_000 - index,
  }));
  const fake = fakeSupabase();
  fake.client.rpc = async (name, args) => {
    fake.calls.push(['rpc', name, args]);
    if (name === 'mcp_get_visible_tasks_page') {
      let start = 0;
      if (args.p_cursor_updated_at !== null) {
        start = sourceRows.findIndex((row) => (
          row.updated_at === args.p_cursor_updated_at && row.id === args.p_cursor_id
        )) + 1;
      }
      const items = sourceRows.slice(start, start + args.p_limit);
      const hasMore = start + items.length < sourceRows.length;
      const last = items.at(-1);
      return {
        data: {
          items,
          hasMore,
          nextCursor: hasMore ? { updatedAt: last.updated_at, id: last.id } : null,
          truncated: false,
        },
        error: null,
      };
    }
    if (name === 'mcp_get_task_people') {
      return {
        data: { tasks: args.p_task_ids.map((id) => ({ task_id: id, owner: null, participants: [], approvers: [] })) },
        error: null,
      };
    }
    return { data: [], error: null };
  };
  const repo = repository(fake);
  const taskIds = [];
  let cursor;

  do {
    const page = await repo.value.searchPadTasks({ limit: 50, cursor });
    taskIds.push(...page.tasks.map((task) => task.id));
    cursor = page.nextCursor ?? undefined;
    if (!page.hasMore) break;
  } while (cursor);

  assert.equal(taskIds.length, 5000);
  assert.equal(new Set(taskIds).size, 5000);
  assert.deepEqual(taskIds, sourceRows.map((row) => row.id));
});

test('filters processes and caps their result limit at 20', async () => {
  const fake = fakeSupabase({ processes: { data: [{ id: 'p1', name: '销售流程', nodes: [], links: [] }], error: null } });
  const repo = repository(fake);

  const result = await repo.value.getProcessSipoc({ processId: 'p1', departmentId: 'd1', limit: 100 });

  assert.equal(result.processes[0].name, '销售流程');
  assert.ok(fake.calls.some((call) => call[0] === 'processes' && call[1] === 'eq' && call[2] === 'id' && call[3] === 'p1'));
  assert.ok(fake.calls.some((call) => call[0] === 'processes' && call[1] === 'limit' && call[2] === 20));
});

test('converts Supabase errors to a stable DATA_ACCESS_FAILED error', async () => {
  const fake = fakeSupabase({
    'rpc:get_visible_tasks_full': {
      data: null,
      error: { code: '57014', message: 'JWT secret internal detail' },
    },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.searchPadTasks({ limit: 20, offset: 0 }),
    (error) => error.code === 'DATA_ACCESS_FAILED' && !error.message.includes('JWT secret'),
  );
  assert.deepEqual(repo.logs, [{
    event: 'supabase_query_failed',
    operation: 'search_pad_tasks',
    code: '57014',
  }]);
});

test('searches a named user through the scoped RPC with Shanghai month bounds and relation', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_query_user_tasks': {
      data: {
        user: { user_id: 'user-1', name: '张三', department_name: '市场部' },
      tasks: [{ id: 't1', title: '八月任务', owner_id: 'user-1', department_name: '市场部', updated_at: 20 }],
        total: 1, limit: 20, offset: 0, hasMore: false,
      },
      error: null,
    },
    'rpc:mcp_get_task_people': {
      data: { tasks: [{ task_id: 't1', owner: { id: 'user-1', name: '张三', department_id: 'd1', department_name: '市场部' }, participants: [], approvers: [] }] },
      error: null,
    },
  });
  const repo = createReadRepository({
    createUserClient: () => fake.client,
    getContext: () => ({ userId: 'manager-1', accessToken: 'jwt-1' }),
    requestTimeoutMs: 1000,
    identityRepository: identityRepository(),
  });

  const result = await repo.searchPadTasks({
    userName: '张三', departmentName: '市场部', month: '2026-08', relation: 'participant',
  });

  const rpc = fake.calls.find((call) => call[0] === 'rpc' && call[1] === 'mcp_query_user_tasks');
  assert.equal(result.tasks[0].id, 't1');
  assert.equal(result.tasks[0].ownerId, 'user-1');
  assert.equal(result.tasks[0].ownerName, '张三');
  assert.equal(result.tasks[0].departmentName, '市场部');
  assert.equal(rpc[2].p_user_id, 'user-1');
  assert.equal(rpc[2].p_relation, 'participant');
  assert.equal(rpc[2].p_month_start, Date.UTC(2026, 6, 31, 16));
  assert.equal(rpc[2].p_month_end, Date.UTC(2026, 7, 31, 16));
  assert.equal(fake.calls.some((call) => call[0] === 'rpc' && call[1] === 'get_visible_tasks_full'), false);
});

test('searches a parent department id through the scoped task RPC with its canonical scope', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_resolve_department': {
      data: {
        department: {
          id: 'market-root', name: '市场运营部', rootId: 'market-root', rootName: '市场运营部',
          path: ['market-root'], depth: 0, hasChildren: true,
        },
        scope: 'subtree',
        ids: ['market-root', 'operations-child'],
      },
      error: null,
    },
    'rpc:mcp_get_department_tasks_page': {
      data: { items: [], total: 0, hasMore: false, nextCursor: null, truncated: false },
      error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.searchPadTasks({ departmentId: 'market-root', scope: 'auto' });

  assert.equal(result.departmentId, 'market-root');
  assert.equal(result.scope, 'subtree');
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_department_tasks_page')[2], {
    p_department_id: 'market-root',
    p_scope: 'subtree',
    p_week_id: null,
    p_query: null,
    p_status: null,
    p_limit: 20,
    p_cursor_updated_at: null,
    p_cursor_id: null,
  });
  assert.equal(fake.calls.some((call) => call[1] === 'mcp_get_visible_tasks_page'), false);
});

test('converts scoped task offsets to cursors without resolving the department again', async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    id: `task-${index}`,
    title: `任务 ${index}`,
    department_id: 'operations-child',
    updated_at: 1000 - index,
  }));
  const secondPage = Array.from({ length: 20 }, (_, index) => ({
    id: `task-${index + 50}`,
    title: `任务 ${index + 50}`,
    department_id: 'operations-child',
    updated_at: 950 - index,
  }));
  let pageCall = 0;
  const fake = fakeSupabase({
    'rpc:mcp_resolve_department': {
      data: {
        department: {
          id: 'operations-child', name: '运营部', rootId: 'market-root', rootName: '市场运营部',
          path: ['market-root', 'operations-child'], depth: 1, hasChildren: false,
        },
        scope: 'exact',
        ids: ['operations-child'],
      },
      error: null,
    },
    'rpc:mcp_get_department_tasks_page': (args) => {
      pageCall += 1;
      return pageCall === 1
        ? {
          data: {
            items: firstPage,
            total: 70,
            hasMore: true,
            nextCursor: { updatedAt: 951, id: 'task-49' },
            truncated: false,
          },
          error: null,
        }
        : {
          data: {
            items: secondPage.slice(0, args.p_limit),
            total: 20,
            hasMore: true,
            nextCursor: { updatedAt: 936, id: 'task-64' },
            truncated: false,
          },
          error: null,
        };
    },
  });
  const repo = repository(fake);

  const result = await repo.value.searchPadTasks({
    departmentId: 'operations-child', offset: 55, limit: 10,
  });

  assert.deepEqual(result.tasks.map((task) => task.id), Array.from({ length: 10 }, (_, index) => `task-${index + 55}`));
  assert.equal(result.offset, 55);
  assert.equal(result.total, 70);
  assert.equal(result.hasMore, true);
  assert.ok(result.nextCursor);
  assert.equal(fake.calls.filter((call) => call[1] === 'mcp_resolve_department').length, 1);
  const pageCalls = fake.calls.filter((call) => call[1] === 'mcp_get_department_tasks_page');
  assert.equal(pageCalls.length, 2);
  assert.deepEqual(pageCalls[1][2], {
    p_department_id: 'operations-child',
    p_scope: 'exact',
    p_week_id: null,
    p_query: null,
    p_status: null,
    p_limit: 15,
    p_cursor_updated_at: 951,
    p_cursor_id: 'task-49',
  });
});

test('does not silently downgrade a subtree task search when the scoped RPC is missing', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_resolve_department': {
      data: {
        department: {
          id: 'market-root', name: '市场运营部', rootId: 'market-root', rootName: '市场运营部',
          path: ['market-root'], depth: 0, hasChildren: true,
        },
        scope: 'subtree',
        ids: ['market-root', 'operations-child'],
      },
      error: null,
    },
    'rpc:mcp_get_department_tasks_page': {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.searchPadTasks({ departmentId: 'market-root' }),
    (error) => error.code === 'RPC_NOT_CONFIGURED',
  );
  assert.equal(fake.calls.some((call) => call[1] === 'mcp_get_visible_tasks_page'), false);
});

test('does not downgrade auto task scope even when the resolved department is a leaf', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_resolve_department': {
      data: {
        department: { id: 'leaf', name: '叶子部门', hasChildren: false },
        scope: 'exact',
        ids: ['leaf'],
      },
      error: null,
    },
    'rpc:mcp_get_department_tasks_page': {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    },
    'rpc:get_visible_tasks_full': { data: [{ id: 'legacy-task' }], error: null },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.searchPadTasks({ departmentId: 'leaf', scope: 'auto' }),
    (error) => error.code === 'RPC_NOT_CONFIGURED',
  );
  assert.equal(fake.calls.some((call) => call[1] === 'get_visible_tasks_full'), false);
});

test('does not allow exact compatibility when the resolver reports a subtree', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_resolve_department': {
      data: {
        department: { id: 'root', name: '根部门', hasChildren: true },
        scope: 'subtree',
        ids: ['root', 'child'],
      },
      error: null,
    },
    'rpc:mcp_get_department_tasks_page': {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.searchPadTasks({ departmentId: 'root', scope: 'exact' }),
    (error) => error.code === 'RPC_NOT_CONFIGURED',
  );
});

test('uses the resolved exact scope when reading people from a leaf department', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_resolve_department': {
      data: {
        department: {
          id: 'operations-child', name: '运营部', rootId: 'market-root', rootName: '市场运营部',
          path: ['market-root', 'operations-child'], depth: 1, hasChildren: false,
        },
        scope: 'exact',
        ids: ['operations-child'],
      },
      error: null,
    },
    'rpc:mcp_get_department_people': {
      data: { department: { id: 'operations-child', name: '运营部' }, scope: 'exact', people: [], hasMore: false },
      error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.getDepartmentPeople({ departmentName: '运营部', scope: 'auto' });

  assert.equal(result.scope, 'exact');
  assert.equal(fake.calls.find((call) => call[1] === 'mcp_get_department_people')[2].p_scope, 'exact');
});

for (const relation of ['owner', 'participant', 'approver', 'any']) {
  test(`passes the ${relation} relation to the name-scoped task RPC`, async () => {
    const fake = fakeSupabase({
      'rpc:mcp_query_user_tasks': { data: { user: { user_id: 'u1', name: '张三' }, tasks: [], total: 0, limit: 20, offset: 0, hasMore: false }, error: null },
    });
    const repo = createReadRepository({
      createUserClient: () => fake.client,
      getContext: () => ({ userId: 'caller', accessToken: 'jwt-1' }),
      requestTimeoutMs: 1000,
      identityRepository: identityRepository(),
    });
    await repo.searchPadTasks({ userName: '张三', relation });
    assert.equal(fake.calls.find((call) => call[1] === 'mcp_query_user_tasks')[2].p_relation, relation);
  });
}

test('reads weekly review gaps from the card state and preserves inconsistency diagnostics', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_weekly_review_gaps': {
      data: {
        weekId: '2026-W33',
        groups: [{
          user: { user_id: 'user-1', name: '张三', department_name: '市场部' },
          tasks: [{
            id: 't1', title: '任务一', reviewState: 'missing',
            department_name: '市场部', taskReview: '任务表已有值', cardEvaluation: '', inconsistent: true,
          }],
        }],
        total: 1, limit: 50, offset: 0, hasMore: false,
      },
      error: null,
    },
  });
  const repo = createReadRepository({
    createUserClient: () => fake.client,
    getContext: () => ({ userId: 'manager-1', accessToken: 'jwt-1' }),
    requestTimeoutMs: 1000,
    identityRepository: identityRepository(),
  });

  const result = await repo.getWeeklyReviewGaps({ weekId: '2026-W33', limit: 50 });

  assert.equal(result.groups[0].user.name, '张三');
  assert.equal(result.groups[0].tasks[0].inconsistent, true);
  assert.equal(result.groups[0].tasks[0].departmentName, '市场部');
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_weekly_review_gaps')[2], {
    p_week_id: '2026-W33', p_department_id: null, p_limit: 50, p_offset: 0,
  });
});

test('requires the scoped weekly review RPC for department queries', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_weekly_review_gaps_scope_v2': {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    },
    'rpc:mcp_get_weekly_review_gaps': { data: { groups: [] }, error: null },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.getWeeklyReviewGaps({ weekId: '2026-W33', departmentId: 'd1' }),
    (error) => error.code === 'RPC_NOT_CONFIGURED',
  );
  assert.equal(fake.calls.some((call) => call[1] === 'mcp_get_weekly_review_gaps'), false);
});

test('fails explicitly when the task people RPC is not installed', async () => {
  const weekId = getCurrentIsoWeekPeriod(Date.now()).weekId;
  const fake = fakeSupabase({
    'rpc:get_my_workbench_tasks': { data: [{ id: 't1', owner_id: 'u1', title: '任务', target_weeks: [weekId] }], error: null },
    'rpc:mcp_get_task_people': { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.getPersonalWorkbench({ limit: 10 }),
    (error) => error.code === 'RPC_NOT_CONFIGURED' && error.message.includes('任务人员信息'),
  );
});

test('drops a task when the people RPC no longer considers it visible', async () => {
  const fake = fakeSupabase({
    'rpc:get_my_workbench_tasks': { data: [{ id: 't1', owner_id: 'u1', title: '刚失去权限的任务' }], error: null },
    'rpc:mcp_get_task_people': { data: { tasks: [] }, error: null },
  });
  const repo = repository(fake);

  const result = await repo.value.getPersonalWorkbench({ limit: 10 });

  assert.deepEqual(result.tasks, []);
});

test('reads company OKRs through the dedicated RPC with task attachment options', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_company_okrs': {
      data: {
        year: 2026,
        okrCount: 1,
        okrs: [{
          id: 'c-okr-1', objective: '公司目标', keyResults: ['KR一', 'KR二'], krCount: 2, truncated: false,
          krTasks: [{
            krIndex: 0, krText: 'KR一', taskCount: 1, tasksTruncated: false,
            tasks: [{
              id: 't1', title: '任务一', status: 'in-progress', owner_id: 'u1', ownerName: '张三',
              department_id: 'd1', departmentName: '市场部', target_weeks: ['2026-W35'],
              start_date: 100, due_date: 200,
            }],
          }],
        }],
      },
      error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.getCompanyOkrs({ year: 2026 });

  assert.equal(result.year, 2026);
  assert.equal(result.okrCount, 1);
  assert.equal(result.okrs[0].objective, '公司目标');
  assert.equal(result.okrs[0].krTasks[0].tasks[0].ownerName, '张三');
  assert.equal(result.okrs[0].krTasks[0].tasks[0].departmentName, '市场部');
  assert.deepEqual(result.okrs[0].krTasks[0].tasks[0].targetWeeks, ['2026-W35']);
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_company_okrs')[2], {
    p_year: 2026,
    p_include_tasks: true,
  });
});

test('passes includeTasks=false through to the company OKR RPC', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_company_okrs': { data: { year: 2026, okrCount: 0, okrs: [] }, error: null },
  });
  const repo = repository(fake);

  await repo.value.getCompanyOkrs({ year: 2026, includeTasks: false });

  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_company_okrs')[2], {
    p_year: 2026,
    p_include_tasks: false,
  });
});

test('reads department OKRs by id and maps nested period structures', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_department_okrs_scope_v2': {
      data: {
        year: 2026,
        period: null,
        departmentCount: 1,
        hasMore: false,
        departments: [{
          id: 'd1', name: '市场部', managerName: '张三', parentName: null,
          periods: {
            Annual: [{ id: 'okr-1', objective: '年度目标', keyResults: ['KR一'], krCount: 1, truncated: false, krTasks: [] }],
            Q3: [{ id: 'okr-2', objective: '季度目标', keyResults: [], krCount: 0, truncated: false, krTasks: [] }],
          },
        }],
      },
      error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.getDepartmentOkrs({ departmentId: 'd1', year: 2026, limit: 999 });

  assert.equal(result.year, 2026);
  assert.equal(result.departments[0].name, '市场部');
  assert.equal(result.departments[0].periods.Annual[0].objective, '年度目标');
  assert.equal(result.departments[0].periods.Q3[0].id, 'okr-2');
  assert.equal(result.limit, 50);
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_department_okrs_scope_v2')[2], {
    p_department_id: 'd1',
    p_scope: 'auto',
    p_year: 2026,
    p_period: null,
    p_include_tasks: true,
    p_limit: 50,
  });
});

test('resolves departmentName before calling the department OKR RPC', async () => {
  const fake = fakeSupabase({
    departments: { data: [{ id: 'd1', name: '市场部' }], error: null },
    'rpc:mcp_get_department_okrs_scope_v2': { data: { year: 2026, period: 'Q3', departmentCount: 0, hasMore: false, departments: [] }, error: null },
  });
  const repo = repository(fake);

  const result = await repo.value.getDepartmentOkrs({ departmentName: '市场部', period: 'Q3', includeTasks: false });

  assert.equal(result.period, 'Q3');
  assert.ok(fake.calls.some((call) => call[0] === 'departments' && call[1] === 'eq' && call[2] === 'name' && call[3] === '市场部'));
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_get_department_okrs_scope_v2')[2], {
    p_department_id: 'd1',
    p_scope: 'auto',
    p_year: null,
    p_period: 'Q3',
    p_include_tasks: false,
    p_limit: 20,
  });
});

test('rejects ambiguous or missing department names for department OKR queries', async () => {
  const missingFake = fakeSupabase({ departments: { data: [], error: null } });
  const missingRepo = repository(missingFake);
  await assert.rejects(
    missingRepo.value.getDepartmentOkrs({ departmentName: '不存在部门' }),
    (error) => error.code === 'DEPARTMENT_NOT_FOUND',
  );

  const ambiguousFake = fakeSupabase({ departments: { data: [{ id: 'd1' }, { id: 'd2' }], error: null } });
  const ambiguousRepo = repository(ambiguousFake);
  await assert.rejects(
    ambiguousRepo.value.getDepartmentOkrs({ departmentName: '重名部门' }),
    (error) => error.code === 'DEPARTMENT_NAME_AMBIGUOUS',
  );
});

test('maps department OKR RPC permission errors to stable public codes', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_department_okrs_scope_v2': { data: null, error: { code: 'P0001', message: 'MCP_PERMISSION_DENIED: department is not visible' } },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.getDepartmentOkrs({ departmentId: 'hidden' }),
    (error) => error.code === 'PERMISSION_DENIED' && !error.message.includes('department is not visible'),
  );
});

test('fails explicitly when the OKR RPCs are not installed', async () => {
  const missingFake = fakeSupabase({
    'rpc:mcp_get_company_okrs': { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
    'rpc:mcp_get_department_okrs': { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
  });
  const missingRepo = repository(missingFake);

  await assert.rejects(
    missingRepo.value.getCompanyOkrs({}),
    (error) => error.code === 'RPC_NOT_CONFIGURED',
  );
  await assert.rejects(
    missingRepo.value.getDepartmentOkrs({}),
    (error) => error.code === 'RPC_NOT_CONFIGURED',
  );
});

test('does not fall back to the legacy department OKR RPC when scoped v2 is missing', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_get_department_okrs_scope_v2': {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    },
    'rpc:mcp_get_department_okrs': {
      data: { year: 2026, departmentCount: 0, departments: [] },
      error: null,
    },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.getDepartmentOkrs({ departmentId: 'd1', year: 2026 }),
    (error) => error.code === 'RPC_NOT_CONFIGURED',
  );
  assert.equal(fake.calls.some((call) => call[1] === 'mcp_get_department_okrs'), false);
});

test('maps scoped query permission and missing RPC errors to stable public codes', async () => {
  const deniedFake = fakeSupabase({
    'rpc:mcp_query_user_tasks': { data: null, error: { code: 'P0001', message: 'MCP_PERMISSION_DENIED: hidden department' } },
  });
  const deniedRepo = createReadRepository({
    createUserClient: () => deniedFake.client,
    getContext: () => ({ userId: 'manager-1', accessToken: 'jwt-1' }),
    requestTimeoutMs: 1000,
    identityRepository: identityRepository(),
  });
  await assert.rejects(
    deniedRepo.searchPadTasks({ userName: '张三' }),
    (error) => error.code === 'PERMISSION_DENIED' && !error.message.includes('hidden department'),
  );

  const missingFake = fakeSupabase({
    'rpc:mcp_query_user_tasks': { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
  });
  const missingRepo = createReadRepository({
    createUserClient: () => missingFake.client,
    getContext: () => ({ userId: 'manager-1', accessToken: 'jwt-1' }),
    requestTimeoutMs: 1000,
    identityRepository: identityRepository(),
  });
  await assert.rejects(missingRepo.searchPadTasks({ userName: '张三' }), (error) => error.code === 'RPC_NOT_CONFIGURED');
});
