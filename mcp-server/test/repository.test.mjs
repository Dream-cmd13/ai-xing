import test from 'node:test';
import assert from 'node:assert/strict';

import { createReadRepository } from '../src/repository.mjs';

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
        return results[`rpc:${name}`] ?? { data: [], error: null };
      },
    },
  };
}

function repository(fake, context = { userId: 'user-1', accessToken: 'jwt-1' }) {
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
    }),
  };
}

test('reads organization information with a user JWT and omits sensitive department fields', async () => {
  const fake = fakeSupabase({
    strategy: { data: { id: 'default', mission: '使命', vision: '愿景', company_okrs: {} }, error: null },
    departments: {
      data: [{ id: 'd1', name: '市场部', manager_name: '张三', responsibilities: '增长', attributes: '业务', sub_departments: [], okrs: {}, role_members: { secret: ['u1'] }, reviews: { secret: [] } }],
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
});

test('filters weekly PAD from the existing visible-task RPC and caps the result limit', async () => {
  const fake = fakeSupabase({
    'rpc:get_visible_tasks_full': {
      data: [
        { id: 't1', title: '匹配任务', department_id: 'd1', target_weeks: ['2026-W34'] },
        { id: 't2', title: '其他部门', department_id: 'd2', target_weeks: ['2026-W34'] },
        { id: 't3', title: '其他周次', department_id: 'd1', target_weeks: ['2026-W35'] },
      ],
      error: null,
    },
  });
  const repo = repository(fake);

  const result = await repo.value.getDepartmentWeeklyPad({ departmentId: 'd1', weekId: '2026-W34', limit: 999 });

  assert.deepEqual(result.tasks.map((task) => task.id), ['t1']);
  assert.equal(result.tasks[0].targetWeeks[0], '2026-W34');
  assert.deepEqual(fake.calls.find((call) => call[0] === 'rpc'), ['rpc', 'get_visible_tasks_full', undefined]);
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
    query: ' 季度复盘 ', departmentId: 'd1', status: 'in-progress', limit: 20, offset: 5,
  });

  assert.deepEqual(result, { tasks: [], offset: 5, limit: 20, total: 1, hasMore: false });
  assert.deepEqual(fake.calls.find((call) => call[0] === 'rpc'), ['rpc', 'get_visible_tasks_full', undefined]);
  assert.equal(fake.calls.some((call) => call[0] === 'from' && call[1] === 'tasks'), false);
});

test('falls back to the bounded direct weekly query only when the visible-task RPC is missing', async () => {
  const fake = fakeSupabase({
    'rpc:get_visible_tasks_full': { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
    tasks: { data: [{ id: 't1', title: '任务', target_weeks: ['2026-W34'] }], error: null },
  });
  const repo = repository(fake);

  const result = await repo.value.getDepartmentWeeklyPad({ departmentId: 'd1', weekId: '2026-W34', limit: 10 });

  assert.equal(result.tasks.length, 1);
  assert.ok(fake.calls.some((call) => call[0] === 'tasks' && call[1] === 'eq' && call[2] === 'department_id' && call[3] === 'd1'));
  assert.ok(fake.calls.some((call) => call[0] === 'tasks' && call[1] === 'contains' && call[2] === 'target_weeks'));
});

test('always gets the personal workbench for the authenticated business user', async () => {
  const fake = fakeSupabase({
    'rpc:get_my_workbench_tasks': { data: [{ id: 't1', owner_id: 'user-1', title: '我的任务' }], error: null },
  });
  const repo = repository(fake, { userId: 'user-1', accessToken: 'jwt-1' });

  const result = await repo.value.getPersonalWorkbench({ userId: 'attacker-user', limit: 10 });

  assert.equal(result.userId, 'user-1');
  assert.equal(result.tasks[0].ownerId, 'user-1');
  assert.deepEqual(fake.calls.find((call) => call[0] === 'rpc'), ['rpc', 'get_my_workbench_tasks', undefined]);
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
