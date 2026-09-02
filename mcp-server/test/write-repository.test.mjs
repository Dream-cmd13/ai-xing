import test from 'node:test';
import assert from 'node:assert/strict';

import { createWriteRepository } from '../src/write-repository.mjs';

function fakeSupabase(results = {}) {
  const calls = [];

  function query(table) {
    const chain = {
      select(...args) { calls.push([table, 'select', ...args]); return chain; },
      eq(...args) { calls.push([table, 'eq', ...args]); return chain; },
      maybeSingle() {
        calls.push([table, 'maybeSingle']);
        return Promise.resolve(results[table] ?? { data: null, error: null });
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
        return results[`rpc:${name}`] ?? { data: {}, error: null };
      },
    },
  };
}

function repository(fake, context = { userId: 'user-1', accessToken: 'jwt-1' }, logger = {}) {
  const tokens = [];
  return {
    tokens,
    value: createWriteRepository({
      createUserClient(token) {
        tokens.push(token);
        return fake.client;
      },
      getContext: () => context,
      requestTimeoutMs: 1000,
      logger,
    }),
  };
}

function identityRepository() {
  return {
    async resolveUser({ name, departmentName }) {
      return { userId: `${name}-id`, name, role: 'Employee', departmentId: 'dept-x', departmentName: departmentName ?? '研发部' };
    },
    async resolveUsers({ users }) {
      return { users: users.map((user) => ({ userId: `${user.name}-id`, name: user.name, role: 'Employee', departmentId: 'dept-x', departmentName: user.departmentName ?? '研发部' })), requested: users };
    },
  };
}

const task = {
  id: 'task-1',
  created_by: 'user-1',
  title: '当前任务',
  status: 'draft',
  priority: 'medium',
  owner_id: 'user-1',
  department_id: 'dept-1',
  target_weeks: ['2026-W34'],
  participant_ids: [],
  approver_ids: ['user-2'],
  row_version: 3,
};

test('prepareCreatePadTask validates locally and never writes or calls an RPC', async () => {
  const fake = fakeSupabase();
  const repo = repository(fake);

  const result = await repo.value.prepareCreatePadTask({
    payload: { title: '新任务', priority: 'high', ownerId: 'user-1' },
  });

  assert.deepEqual(result, {
    payload: { title: '新任务', priority: 'high', ownerId: 'user-1' },
  });
  assert.deepEqual(repo.tokens, []);
  assert.equal(fake.calls.some((call) => call[0] === 'rpc'), false);
  assert.equal(fake.calls.some((call) => call[0] === 'from'), false);
});

test('rejects malformed and out-of-range review slots before any write', async () => {
  const updateRepo = repository(fakeSupabase({
    tasks: { data: { ...task, aligned_kr_id: 'okr-1-kr-1.5' }, error: null },
    departments: { data: { id: 'dept-1', reviews: { '2026-W34': [{}] }, row_version: 1 }, error: null },
  }));
  await assert.rejects(
    updateRepo.value.prepareUpdatePadTask({ taskId: 'task-1', changes: { taskReview: '不应写入' } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('prepareUpdatePadTask reads the current task through the authenticated client', async () => {
  const fake = fakeSupabase({ tasks: { data: task, error: null } });
  const repo = repository(fake);

  const result = await repo.value.prepareUpdatePadTask({
    taskId: 'task-1',
    changes: { title: '新标题' },
  });

  assert.equal(repo.tokens[0], 'jwt-1');
  assert.deepEqual(result.current, task);
  assert.equal(result.expectedRowVersion, 3);
  assert.deepEqual(result.changes, { title: '新标题' });
  assert.ok(fake.calls.some((call) => call[0] === 'tasks' && call[1] === 'eq' && call[2] === 'id' && call[3] === 'task-1'));
});

test('prepare resolves names once and returns canonical IDs without writing', async () => {
  const fake = fakeSupabase({ tasks: { data: task, error: null } });
  const repo = repository(fake);
  repo.value = createWriteRepository({
    createUserClient: () => fake.client,
    getContext: () => ({ userId: 'user-1', accessToken: 'jwt-1' }),
    requestTimeoutMs: 1000,
    identityRepository: identityRepository(),
  });

  const createPreview = await repo.value.prepareCreatePadTask({ payload: {
    title: '姓名任务', ownerName: { name: '张三', departmentName: '研发部' },
    participantNames: [{ name: '李四', departmentName: '市场部' }],
    approverNames: [{ name: '王五', departmentName: '财务部' }],
  } });
  assert.deepEqual(createPreview.payload, {
    title: '姓名任务', ownerId: '张三-id', participantIds: ['李四-id'], approverIds: ['王五-id'],
  });
  assert.equal(fake.calls.some((call) => call[0] === 'rpc'), false);

  const updatePreview = await repo.value.prepareUpdatePadTask({
    taskId: 'task-1', changes: { participantNames: [{ name: '李四' }] },
  });
  assert.deepEqual(updatePreview.changes, { participantIds: ['李四-id'] });
});

test('prepare rejects conflicting ID and name references before any write RPC', async () => {
  const fake = fakeSupabase();
  const value = createWriteRepository({
    createUserClient: () => fake.client,
    getContext: () => ({ userId: 'user-1', accessToken: 'jwt-1' }),
    requestTimeoutMs: 1000,
    identityRepository: identityRepository(),
  });
  await assert.rejects(
    value.prepareCreatePadTask({ payload: {
      title: '冲突任务', ownerId: 'different-id', ownerName: { name: '张三' },
    } }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  assert.equal(fake.calls.some((call) => call[0] === 'rpc'), false);
});

test('prepareUpdatePadTask rejects an invisible task with a stable data error', async () => {
  const fake = fakeSupabase({ tasks: { data: null, error: null } });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.prepareUpdatePadTask({ taskId: 'hidden-task', changes: { title: '不应可见' } }),
    (error) => error.code === 'DATA_ACCESS_FAILED' && error.message === '任务不存在或当前账号无权查看。',
  );
});

test('prepareSubmitPadTask and prepareSaveReviewRecord capture row versions', async () => {
  const fake = fakeSupabase({
    tasks: { data: task, error: null },
    departments: { data: { id: 'dept-1', reviews: { '2026-W34': [] }, row_version: 7 }, error: null },
  });
  const repo = repository(fake);

  const taskPreview = await repo.value.prepareSubmitPadTask({ taskId: 'task-1' });
  const reviewPreview = await repo.value.prepareSaveReviewRecord({
    departmentId: 'dept-1',
    periodKey: '2026-W34',
    entry: { content: '复盘内容', score: 80 },
  });

  assert.equal(taskPreview.current.status, 'draft');
  assert.equal(taskPreview.expectedRowVersion, 3);
  assert.deepEqual(reviewPreview.current.reviews, { '2026-W34': [] });
  assert.equal(reviewPreview.expectedRowVersion, 7);
});

test('commit methods call the matching RPC with the authenticated user context', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_create_pad_task': { data: { replayed: false, task: { id: 'task-1' }, rowVersion: 0 }, error: null },
    'rpc:mcp_update_pad_task': { data: { replayed: false, task: { id: 'task-1' }, rowVersion: 4 }, error: null },
    'rpc:mcp_submit_pad_task': { data: { replayed: false, task: { id: 'task-1' }, rowVersion: 5 }, error: null },
    'rpc:mcp_save_review_record': {
      data: { replayed: false, departmentId: 'dept-1', periodKey: '2026-W34', reviewId: 'review-1', rowVersion: 8 },
      error: null,
    },
  });
  const repo = repository(fake);

  await repo.value.commitCreatePadTask({ payload: { title: '新任务' }, requestId: 'request-1' });
  await repo.value.commitUpdatePadTask({ taskId: 'task-1', changes: { title: '新标题' }, expectedRowVersion: 3, requestId: 'request-2' });
  await repo.value.commitSubmitPadTask({ taskId: 'task-1', expectedRowVersion: 4, requestId: 'request-3' });
  await repo.value.commitSaveReviewRecord({
    departmentId: 'dept-1', periodKey: '2026-W34', entry: { content: '复盘' }, expectedRowVersion: 7, requestId: 'request-4',
  });

  assert.deepEqual(fake.calls.filter((call) => call[0] === 'rpc').map((call) => call[1]), [
    'mcp_create_pad_task', 'mcp_update_pad_task', 'mcp_submit_pad_task', 'mcp_save_review_record',
  ]);
  assert.deepEqual(fake.calls.find((call) => call[1] === 'mcp_update_pad_task')[2], {
    p_task_id: 'task-1',
    p_changes: { title: '新标题' },
    p_expected_row_version: 3,
    p_request_id: 'request-2',
  });
  assert.deepEqual(repo.tokens, ['jwt-1', 'jwt-1', 'jwt-1', 'jwt-1']);
});

test('participant-only and approver-only updates use the scoped permission RPC', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_update_pad_task_scoped': {
      data: { replayed: false, task: { id: 'task-1' }, rowVersion: 4 },
      error: null,
    },
  });
  const repo = repository(fake);

  await repo.value.commitUpdatePadTask({
    taskId: 'task-1',
    changes: { participantIds: ['user-2'] },
    expectedRowVersion: 3,
    requestId: 'request-participants',
  });
  await repo.value.commitUpdatePadTask({
    taskId: 'task-1',
    changes: { approverIds: ['user-3'] },
    expectedRowVersion: 3,
    requestId: 'request-approvers',
  });

  const calls = fake.calls.filter((call) => call[0] === 'rpc');
  assert.deepEqual(calls.map((call) => call[1]), [
    'mcp_update_pad_task_scoped',
    'mcp_update_pad_task_scoped',
  ]);
  assert.deepEqual(calls.map((call) => call[2].p_changes), [
    { participant_ids: ['user-2'] },
    { approver_ids: ['user-3'] },
  ]);
});

test('lookupWriteResult reads only the current user write record', async () => {
  const fake = fakeSupabase({
    mcp_write_log: { data: { status: 'success', result_summary: { taskId: 'task-1' } }, error: null },
  });
  const repo = repository(fake);

  const result = await repo.value.lookupWriteResult({ toolName: 'commit_create_pad_task', requestId: 'request-1' });

  assert.deepEqual(result, { status: 'success', resultSummary: { taskId: 'task-1' } });
  assert.ok(fake.calls.some((call) => call[0] === 'mcp_write_log' && call[1] === 'eq' && call[2] === 'user_id' && call[3] === 'user-1'));
  assert.ok(fake.calls.some((call) => call[0] === 'mcp_write_log' && call[1] === 'eq' && call[2] === 'tool_name'));
  assert.ok(fake.calls.some((call) => call[0] === 'mcp_write_log' && call[1] === 'eq' && call[2] === 'request_id'));
});

test('rejects an empty successful RPC response instead of reporting a write', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_submit_pad_task': { data: null, error: null },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.value.commitSubmitPadTask({ taskId: 'task-1', expectedRowVersion: 1, requestId: 'request-empty-1' }),
    (error) => error.code === 'DATA_ACCESS_FAILED' && error.diagnosticCode === 'EMPTY_RPC_RESULT',
  );
});

test('recordFailedWrite is best effort and does not mask the original error', async () => {
  const logs = [];
  const fake = fakeSupabase({
    'rpc:mcp_record_failed_write': { data: null, error: { code: '57014', message: 'audit unavailable' } },
  });
  const repo = repository(fake, undefined, { error(event) { logs.push(event); } });

  await assert.doesNotReject(repo.value.recordFailedWrite({
    toolName: 'commit_create_pad_task',
    requestId: 'request-1',
    action: 'create',
    objectType: 'task',
    objectId: 'task-1',
    errorCode: 'DATA_ACCESS_FAILED',
  }));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'failed_write_audit_failed');
});

test('maps stable MCP database error prefixes without leaking internal details', async () => {
  const prefixes = [
    ['MCP_VERSION_CONFLICT: row mismatch', 'VERSION_CONFLICT'],
    ['MCP_PERMISSION_DENIED: private department', 'PERMISSION_DENIED'],
    ['MCP_REQUEST_IN_FLIGHT: duplicate', 'REQUEST_IN_FLIGHT'],
    ['MCP_VALIDATION: invalid input', 'MCP_VALIDATION'],
  ];

  for (const [message, code] of prefixes) {
    const fake = fakeSupabase({
      'rpc:mcp_submit_pad_task': { data: null, error: { code: 'P0001', message } },
    });
    const repo = repository(fake);
    await assert.rejects(
      repo.value.commitSubmitPadTask({ taskId: 'task-1', expectedRowVersion: 1, requestId: 'request-1' }),
      (error) => error.code === code && !error.message.includes(message),
    );
  }
});

test('maps a missing review-sync RPC to a stable configuration error', async () => {
  const logs = [];
  const fake = fakeSupabase({
    'rpc:mcp_update_pad_task_with_review_sync': {
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.mcp_update_pad_task_with_review_sync with parameters',
      },
    },
  });
  const repo = repository(fake, undefined, { error(event) { logs.push(event); } });

  await assert.rejects(
    repo.value.commitUpdatePadTask({
      taskId: 'task-1',
      changes: { task_review: '新成果' },
      reviewPeriodKey: '2026-W34',
      reviewKey: 'objective-1',
      krIndex: 0,
      expectedRowVersion: 3,
      expectedDepartmentRowVersion: 7,
      requestId: 'request-review-rpc-missing',
    }),
    (error) => error.code === 'RPC_NOT_CONFIGURED'
      && error.message.includes('复盘同步功能尚未启用')
      && !error.message.includes('PGRST202')
      && !error.message.includes('mcp_update_pad_task_with_review_sync'),
  );
  assert.deepEqual(logs, [{
    event: 'supabase_rpc_not_configured',
    operation: 'commit_update_pad_task',
    code: 'RPC_NOT_FOUND',
  }]);
});
