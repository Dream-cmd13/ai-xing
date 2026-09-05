import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../src/errors.mjs';
import { ConfirmationStore } from '../src/confirmation-store.mjs';
import { registerWriteTools } from '../src/write-tools.mjs';

function captureTools(repository, confirmationStore, options) {
  const tools = new Map();
  registerWriteTools({
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  }, repository, confirmationStore, options);
  return tools;
}

function fakeRepository(overrides = {}) {
  const calls = [];
  const repository = {
    calls,
    getContext: () => ({ userId: 'user-1', role: 'Employee', departmentId: 'dept-1', sessionId: 'session-1' }),
    async prepareCreatePadTask(input) { calls.push(['prepareCreate', input]); return { preview: input.payload }; },
    async commitCreatePadTask(input) { calls.push(['commitCreate', input]); return { replayed: false, task: { id: 'task-1', ...input.payload }, rowVersion: 0 }; },
    async prepareUpdatePadTask(input) { calls.push(['prepareUpdate', input]); return { current: { id: input.taskId, title: '旧标题', rowVersion: 3 }, expectedRowVersion: 3, changes: input.changes }; },
    async commitUpdatePadTask(input) { calls.push(['commitUpdate', input]); return { replayed: false, task: { id: input.taskId, ...input.changes }, rowVersion: input.expectedRowVersion + 1 }; },
    async prepareSubmitPadTask(input) { calls.push(['prepareSubmit', input]); return { current: { id: input.taskId, status: 'draft', approverIds: ['user-2'], rowVersion: 4 }, expectedRowVersion: 4 }; },
    async commitSubmitPadTask(input) { calls.push(['commitSubmit', input]); return { replayed: false, task: { id: input.taskId, status: 'submitted' }, rowVersion: input.expectedRowVersion + 1, approverIds: ['user-2'] }; },
    async prepareSaveReviewRecord(input) { calls.push(['prepareReview', input]); return { current: { id: input.departmentId, rowVersion: 7 }, expectedRowVersion: 7, preview: input.entry }; },
    async commitSaveReviewRecord(input) { calls.push(['commitReview', input]); return { replayed: false, departmentId: input.departmentId, periodKey: input.periodKey, reviewId: 'review-1', rowVersion: input.expectedRowVersion + 1 }; },
    async lookupWriteResult(input) { calls.push(['lookup', input]); return null; },
    async recordFailedWrite(input) { calls.push(['failedAudit', input]); },
    ...overrides,
  };
  return repository;
}

function fakeConfirmationStore(overrides = {}) {
  const calls = [];
  return {
    calls,
    issue(input) {
      calls.push(['issue', input]);
      return { token: `token-${input.toolName}`, expiresAt: 10_000 };
    },
    begin(input) {
      calls.push(['begin', input]);
      return { valid: true, metadata: {} };
    },
    rollback(input) { calls.push(['rollback', input]); return true; },
    finalize(input) { calls.push(['finalize', input]); return true; },
    ...overrides,
  };
}

function jsonContent(result) {
  return JSON.parse(result.content[0].text);
}

test('registers exactly six write tools with non-read-only annotations', () => {
  const tools = captureTools(fakeRepository(), fakeConfirmationStore());

  assert.deepEqual([...tools.keys()], [
    'prepare_create_pad_task',
    'commit_create_pad_task',
    'prepare_update_pad_task',
    'commit_update_pad_task',
    'submit_pad_task',
    'save_review_record',
  ]);
  for (const { definition } of tools.values()) {
    assert.equal(definition.annotations.readOnlyHint, false);
    assert.equal(definition.annotations.destructiveHint, false);
    assert.equal(definition.annotations.idempotentHint, true);
  }
});

test('prepare_create_pad_task only previews and issues a bound confirmation token', async () => {
  const repository = fakeRepository();
  const confirmationStore = fakeConfirmationStore();
  const tools = captureTools(repository, confirmationStore, { now: () => Date.parse('2026-08-25T03:00:00.000Z') });

  const result = await tools.get('prepare_create_pad_task').handler({
    payload: { title: '新任务', priority: 'high' },
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.confirmationToken, 'token-commit_create_pad_task');
  assert.equal(result.structuredContent.executed, false);
  assert.equal(result.structuredContent.confirmation.userId, 'user-1');
  assert.equal(result.structuredContent.confirmation.toolName, 'commit_create_pad_task');
  assert.deepEqual(result.structuredContent.confirmation.parameterSummary, {
    payload: {
      title: '新任务', priority: 'high', ownerId: 'user-1', departmentId: 'dept-1', status: 'draft',
      targetWeeks: ['2026-W35'],
      startDate: Date.UTC(2026, 7, 24, 12),
      dueDate: Date.UTC(2026, 7, 30, 12),
    },
  });
  assert.equal(repository.calls.some(([name]) => name.startsWith('commit')), false);
  assert.equal(confirmationStore.calls[0][0], 'issue');
  assert.equal(confirmationStore.calls[0][1].userId, 'user-1');
  assert.equal(confirmationStore.calls[0][1].sessionId, 'session-1');
  assert.equal(confirmationStore.calls[0][1].toolName, 'commit_create_pad_task');
});

test('prepare create rejects a partially explicit date range', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore(), { now: () => Date.parse('2026-08-25T03:00:00.000Z') });

  const result = await tools.get('prepare_create_pad_task').handler({
    payload: { title: '自定义日期任务', startDate: 123 },
  });

  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'INVALID_ARGUMENT');
  assert.equal(repository.calls.length, 0);
});

test('commit reuses the period fixed by prepare even after the current week changes', async () => {
  let now = Date.parse('2026-08-30T03:00:00.000Z');
  const repository = fakeRepository();
  const store = new ConfirmationStore({ ttlMs: 7 * 24 * 60 * 60 * 1000, now: () => now });
  const tools = captureTools(repository, store, { now: () => now });

  const preview = await tools.get('prepare_create_pad_task').handler({ payload: { title: '跨周确认任务' } });
  now = Date.parse('2026-08-31T03:00:00.000Z');
  const committed = await tools.get('commit_create_pad_task').handler({
    title: '跨周确认任务',
    confirmationToken: preview.structuredContent.confirmationToken,
    requestId: 'request-week-boundary-1',
  });

  assert.equal(committed.isError, false);
  const call = repository.calls.find(([name]) => name === 'commitCreate');
  assert.deepEqual(call[1].payload.targetWeeks, ['2026-W35']);
  assert.equal(call[1].payload.startDate, Date.UTC(2026, 7, 24, 12));
  assert.equal(call[1].payload.dueDate, Date.UTC(2026, 7, 30, 12));
});

test('commit_create_pad_task without a confirmation token is rejected', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore());

  const result = await tools.get('commit_create_pad_task').handler({
    title: '新任务',
    requestId: 'request-1',
  });

  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'CONFIRMATION_INVALID');
  assert.equal(repository.calls.some(([name]) => name === 'commitCreate'), false);
});

test('submit_pad_task and save_review_record without a token are preview-only', async () => {
  const repository = fakeRepository();
  const confirmationStore = fakeConfirmationStore();
  const tools = captureTools(repository, confirmationStore);

  const submit = await tools.get('submit_pad_task').handler({ taskId: 'task-1' });
  const review = await tools.get('save_review_record').handler({
    departmentId: 'dept-1', periodKey: '2026-W34', content: '复盘内容', score: 80,
  });

  assert.equal(submit.structuredContent.executed, false);
  assert.equal(submit.structuredContent.nextStatus, 'submitted');
  assert.equal(review.structuredContent.executed, false);
  assert.equal(repository.calls.some(([name]) => name === 'commitSubmit' || name === 'commitReview'), false);
  assert.equal(confirmationStore.calls.filter(([name]) => name === 'issue').length, 2);
});

test('save_review_record rejects task card fields and directs callers to task update sync', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore());

  const result = await tools.get('save_review_record').handler({
    departmentId: 'dept-1',
    periodKey: '2026-W34',
    content: '部门复盘',
    okrDetails: { objective: { krReviews: [{ taskEvaluations: { 'task-1': '已完成' } }] } },
  });

  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'INVALID_ARGUMENT');
  assert.equal(repository.calls.some(([name]) => name === 'prepareReview' || name === 'commitReview'), false);
});

test('a retryable failure keeps the confirmation bound to its original requestId', async () => {
  let calls = 0;
  const repository = fakeRepository({
    async commitCreatePadTask(input) {
      calls += 1;
      if (calls === 1) throw new AppError('DATA_ACCESS_FAILED');
      return { replayed: false, task: { id: 'task-1', rowVersion: 1 }, rowVersion: 1 };
    },
  });
  const store = new ConfirmationStore({ ttlMs: 60_000, now: () => 1_000 });
  const tools = captureTools(repository, store);
  const preview = await tools.get('prepare_create_pad_task').handler({ payload: { title: '可重试任务' } });
  const token = preview.structuredContent.confirmationToken;

  const first = await tools.get('commit_create_pad_task').handler({ title: '可重试任务', confirmationToken: token, requestId: 'request-original' });
  const second = await tools.get('commit_create_pad_task').handler({ title: '可重试任务', confirmationToken: token, requestId: 'request-other' });
  const third = await tools.get('commit_create_pad_task').handler({ title: '可重试任务', confirmationToken: token, requestId: 'request-original' });

  assert.equal(first.isError, true);
  assert.equal(second.isError, true);
  assert.equal(jsonContent(second).code, 'CONFIRMATION_INVALID');
  assert.equal(third.isError, false);
  assert.equal(calls, 2);
});

test('maps an in-flight token rejection to REQUEST_IN_FLIGHT', async () => {
  const repository = fakeRepository();
  const confirmationStore = fakeConfirmationStore({
    begin(input) {
      this.calls.push(['begin', input]);
      return { valid: false, reason: 'IN_FLIGHT' };
    },
  });
  const tools = captureTools(repository, confirmationStore);

  const result = await tools.get('commit_create_pad_task').handler({
    title: '新任务', confirmationToken: 'token', requestId: 'request-1',
  });

  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'REQUEST_IN_FLIGHT');
  assert.equal(repository.calls.some(([name]) => name === 'commitCreate'), false);
});

test('parameter changes are rejected before calling the write RPC', async () => {
  const repository = fakeRepository();
  const confirmationStore = fakeConfirmationStore({
    begin(input) {
      this.calls.push(['begin', input]);
      return { valid: false, reason: 'ARGS_MISMATCH' };
    },
  });
  const tools = captureTools(repository, confirmationStore);

  const result = await tools.get('commit_create_pad_task').handler({
    title: '被篡改的标题', priority: 'high', confirmationToken: 'token', requestId: 'request-1',
  });

  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'CONFIRMATION_INVALID');
  assert.equal(repository.calls.some(([name]) => name === 'commitCreate'), false);
});

test('prepare create rejects invalid local fields before repository access', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore());

  const result = await tools.get('prepare_create_pad_task').handler({
    payload: { title: '无效周次', targetWeeks: ['2026-W00'] },
  });
  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'INVALID_ARGUMENT');
  assert.equal(repository.calls.length, 0);
});

test('retryable RPC failures roll the token back and can be retried with the same requestId', async () => {
  let attempts = 0;
  const repository = fakeRepository({
    async commitCreatePadTask(input) {
      this.calls.push(['commitCreate', input]);
      attempts += 1;
      if (attempts === 1) throw new AppError('DATA_ACCESS_FAILED', '数据暂时不可用', 502);
      return { replayed: false, task: { id: 'task-1' }, rowVersion: 0 };
    },
  });
  const confirmationStore = fakeConfirmationStore();
  const tools = captureTools(repository, confirmationStore);
  const args = { title: '新任务', confirmationToken: 'token', requestId: 'request-1' };

  const first = await tools.get('commit_create_pad_task').handler(args);
  const second = await tools.get('commit_create_pad_task').handler(args);

  assert.equal(first.isError, true);
  assert.equal(jsonContent(first).code, 'DATA_ACCESS_FAILED');
  assert.equal(second.isError, false);
  assert.equal(confirmationStore.calls.some(([name]) => name === 'rollback'), true);
  assert.equal(confirmationStore.calls.some(([name]) => name === 'finalize'), true);
  assert.equal(attempts, 2);
});

test('business failures finalize the token and require a new prepare', async () => {
  const repository = fakeRepository({
    async commitUpdatePadTask(input) {
      this.calls.push(['commitUpdate', input]);
      throw new AppError('VERSION_CONFLICT', '版本冲突', 409);
    },
  });
  const confirmationStore = fakeConfirmationStore();
  const tools = captureTools(repository, confirmationStore);
  const args = {
    taskId: 'task-1', changes: { title: '新标题' }, expectedRowVersion: 3,
    confirmationToken: 'token', requestId: 'request-1',
  };

  const result = await tools.get('commit_update_pad_task').handler(args);

  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'VERSION_CONFLICT');
  assert.equal(confirmationStore.calls.some(([name]) => name === 'rollback'), false);
  assert.equal(confirmationStore.calls.some(([name]) => name === 'finalize'), true);
});

test('successful commit returns text and structured content and finalizes the token', async () => {
  const repository = fakeRepository();
  const confirmationStore = fakeConfirmationStore();
  const tools = captureTools(repository, confirmationStore);

  const result = await tools.get('commit_create_pad_task').handler({
    title: '新任务', confirmationToken: 'token', requestId: 'request-1',
  });

  assert.equal(result.isError, false);
  assert.equal(typeof result.content[0].text, 'string');
  assert.equal(result.structuredContent.task.id, 'task-1');
  assert.equal(confirmationStore.calls.some(([name]) => name === 'finalize'), true);
});

test('successful idempotent replay bypasses token consumption and RPC execution', async () => {
  const repository = fakeRepository({
    async lookupWriteResult(input) {
      this.calls.push(['lookup', input]);
      return { status: 'success', resultSummary: { taskId: 'task-1', rowVersion: 1 } };
    },
  });
  const confirmationStore = fakeConfirmationStore();
  const tools = captureTools(repository, confirmationStore);

  const result = await tools.get('commit_create_pad_task').handler({
    title: '重试任务', confirmationToken: 'must-not-be-consumed', requestId: 'request-1',
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.replayed, true);
  assert.equal(repository.calls.some(([name]) => name === 'commitCreate'), false);
  assert.equal(confirmationStore.calls.some(([name]) => name === 'begin'), false);
});

test('idempotent replay wins over a missing token and stored replayed false flag', async () => {
  const repository = fakeRepository({
    async lookupWriteResult(input) {
      this.calls.push(['lookup', input]);
      return {
        status: 'success',
        resultSummary: { replayed: false, task: { id: 'task-1' }, rowVersion: 1 },
      };
    },
  });
  const confirmationStore = fakeConfirmationStore();
  const tools = captureTools(repository, confirmationStore);

  const result = await tools.get('commit_create_pad_task').handler({
    title: '重试任务', requestId: 'request-1',
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.replayed, true);
  assert.equal(result.structuredContent.task.id, 'task-1');
  assert.equal(confirmationStore.calls.some(([name]) => name === 'begin'), false);
});

test('update tools reject department and owner changes before any RPC call', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore());

  const departmentResult = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-1', changes: { departmentId: 'other-dept' },
  });
  const ownerResult = await tools.get('commit_update_pad_task').handler({
    taskId: 'task-1', changes: { ownerId: 'user-2' }, expectedRowVersion: 3,
    confirmationToken: 'token', requestId: 'request-1',
  });

  assert.equal(departmentResult.isError, true);
  assert.equal(ownerResult.isError, true);
  assert.equal(jsonContent(departmentResult).code, 'INVALID_ARGUMENT');
  assert.equal(jsonContent(ownerResult).code, 'INVALID_ARGUMENT');
  assert.equal(repository.calls.some(([name]) => name === 'prepareUpdate' || name === 'commitUpdate'), false);
});

test('a manager can prepare an owner change for database-side subtree authorization', async () => {
  const repository = fakeRepository({
    getContext: () => ({ userId: 'manager-1', role: 'Manager', departmentId: 'market-root', sessionId: 'session-1' }),
  });
  const tools = captureTools(repository, fakeConfirmationStore());

  const result = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-child-1',
    changes: { ownerId: 'operations-user-1' },
  });

  assert.equal(result.isError, false);
  assert.deepEqual(repository.calls.find(([name]) => name === 'prepareUpdate')[1], {
    taskId: 'task-child-1',
    changes: { ownerId: 'operations-user-1' },
  });
  assert.equal(result.structuredContent.executed, false);
  assert.equal(result.structuredContent.confirmation.parameterSummary.new.ownerId, 'operations-user-1');
});

test('update tools reject invalid field values before the repository', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore());
  const invalidChanges = [
    { title: '' },
    { targetWeeks: ['2026-W00'] },
    { taskReviewScore: 101 },
    { startDate: 20, dueDate: 10 },
    { status: 'submitted' },
    { participantIds: [''] },
    { taskReview: 'a', task_review: 'b' },
  ];

  for (const changes of invalidChanges) {
    const result = await tools.get('prepare_update_pad_task').handler({ taskId: 'task-1', changes });
    assert.equal(result.isError, true);
    assert.equal(jsonContent(result).code, 'INVALID_ARGUMENT');
  }
  const callsBeforeLongTitle = repository.calls.length;
  const longTitle = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-1', changes: { title: '长'.repeat(201) },
  });
  assert.equal(longTitle.isError, false);
  assert.equal(repository.calls.length, callsBeforeLongTitle + 1);
  assert.equal(repository.calls.at(-1)[0], 'prepareUpdate');
});

test('tool descriptions require requestId reuse for logical retries', () => {
  const tools = captureTools(fakeRepository(), fakeConfirmationStore());

  for (const name of ['commit_create_pad_task', 'commit_update_pad_task', 'submit_pad_task', 'save_review_record']) {
    assert.match(tools.get(name).definition.description, /requestId/i);
    assert.match(tools.get(name).definition.description, /重试|reuse|复用/i);
  }
});

test('real confirmation store accepts submit and review commits using preview row versions', async () => {
  const repository = fakeRepository();
  const confirmationStore = new ConfirmationStore({ ttlMs: 60_000, now: () => 1_000 });
  const tools = captureTools(repository, confirmationStore);

  const submitPreview = await tools.get('submit_pad_task').handler({ taskId: 'task-1' });
  const submit = await tools.get('submit_pad_task').handler({
    taskId: 'task-1',
    confirmationToken: submitPreview.structuredContent.confirmationToken,
    requestId: 'request-submit-1',
  });
  assert.equal(submit.isError, false);
  assert.equal(submit.structuredContent.executed, true);

  const reviewPreview = await tools.get('save_review_record').handler({
    departmentId: 'dept-1', periodKey: '2026-W34', content: '复盘', score: 80,
  });
  const review = await tools.get('save_review_record').handler({
    departmentId: 'dept-1', periodKey: '2026-W34', content: '复盘', score: 80,
    confirmationToken: reviewPreview.structuredContent.confirmationToken,
    requestId: 'request-review-1',
  });
  assert.equal(review.isError, false);
  assert.equal(review.structuredContent.executed, true);
});

test('real confirmation store rejects changed task parameters before RPC execution', async () => {
  const repository = fakeRepository();
  const confirmationStore = new ConfirmationStore({ ttlMs: 60_000, now: () => 1_000 });
  const tools = captureTools(repository, confirmationStore);
  const preview = await tools.get('prepare_create_pad_task').handler({ payload: { title: '原始标题' } });
  const result = await tools.get('commit_create_pad_task').handler({
    title: '篡改标题', confirmationToken: preview.structuredContent.confirmationToken, requestId: 'request-tamper-1',
  });
  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'CONFIRMATION_INVALID');
  assert.equal(repository.calls.some(([name]) => name === 'commitCreate'), false);
});

test('prepare_create_pad_task derives dates from targetWeeks when dates are absent', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore(), { now: () => Date.parse('2026-08-25T03:00:00.000Z') });

  const result = await tools.get('prepare_create_pad_task').handler({
    payload: { title: '只填周次任务', targetWeeks: ['2026-W35'] },
  });

  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.confirmation.parameterSummary.payload, {
    title: '只填周次任务', targetWeeks: ['2026-W35'], ownerId: 'user-1', departmentId: 'dept-1', status: 'draft',
    startDate: 1787572800000,
    dueDate: 1788091200000,
  });
  assert.equal(repository.calls[0][1].payload.startDate, 1787572800000);
});

test('prepare create rejects weeks combined with only one explicit date', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore(), { now: () => Date.parse('2026-08-25T03:00:00.000Z') });

  const result = await tools.get('prepare_create_pad_task').handler({
    payload: { title: '自定义开始任务', targetWeeks: ['2026-W35'], startDate: 123 },
  });

  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'INVALID_ARGUMENT');
  assert.equal(repository.calls.length, 0);
});

test('prepare create rejects a nonexistent ISO week when dates must be derived', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore());

  const result = await tools.get('prepare_create_pad_task').handler({
    payload: { title: '无效周次', targetWeeks: ['2025-W53'] },
  });

  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'INVALID_ARGUMENT');
  assert.equal(repository.calls.length, 0);
});

test('commit_create_pad_task derives the same dates through the confirmation digest', async () => {
  const repository = fakeRepository();
  const confirmationStore = new ConfirmationStore({ ttlMs: 60_000, now: () => 1_000 });
  const tools = captureTools(repository, confirmationStore);
  const createPayload = { title: '只填周次提交', targetWeeks: ['2026-W35'] };

  const preview = await tools.get('prepare_create_pad_task').handler({ payload: createPayload });
  const committed = await tools.get('commit_create_pad_task').handler({
    ...createPayload,
    confirmationToken: preview.structuredContent.confirmationToken,
    requestId: 'request-week-fill-1',
  });

  assert.equal(committed.isError, false);
  const call = repository.calls.find(([name]) => name === 'commitCreate');
  assert.deepEqual(call[1].payload.targetWeeks, ['2026-W35']);
  assert.equal(call[1].payload.startDate, 1787572800000);
  assert.equal(call[1].payload.dueDate, 1788091200000);
});

test('prepare_update_pad_task fills empty dates when targetWeeks are added', async () => {
  const repository = fakeRepository({
    async prepareUpdatePadTask(input) {
      repository.calls.push(['prepareUpdate', input]);
      return {
        current: { id: input.taskId, title: '旧标题', start_date: null, due_date: null, row_version: 3 },
        expectedRowVersion: 3,
        changes: input.changes,
      };
    },
  });
  const tools = captureTools(repository, fakeConfirmationStore());

  const result = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-1',
    changes: { targetWeeks: ['2026-W35'] },
  });

  assert.equal(result.isError, false);
  const expected = { targetWeeks: ['2026-W35'], startDate: 1787572800000, dueDate: 1788091200000 };
  assert.deepEqual(result.structuredContent.changes, expected);
  assert.deepEqual(result.structuredContent.confirmation.parameterSummary.new, expected);
});

test('prepare update rejects partial historical dates and leaves unrelated changes untouched', async () => {
  const tools = captureTools(fakeRepository({
    async prepareUpdatePadTask(input) {
      return {
        current: { id: input.taskId, start_date: 111, due_date: null, row_version: 3 },
        expectedRowVersion: 3,
        changes: input.changes,
      };
    },
  }), fakeConfirmationStore());

  const partial = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-1', changes: { targetWeeks: ['2026-W35'] },
  });
  assert.equal(partial.isError, true);
  assert.equal(jsonContent(partial).code, 'INVALID_ARGUMENT');

  const explicit = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-1', changes: { targetWeeks: ['2026-W35'], startDate: 222 },
  });
  assert.equal(explicit.isError, true);
  assert.equal(jsonContent(explicit).code, 'INVALID_ARGUMENT');

  const untouched = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-1', changes: { title: '新标题' },
  });
  assert.deepEqual(untouched.structuredContent.changes, { title: '新标题' });
});

test('prepare create rejects conflicting dates and target weeks with a stable code', async () => {
  const repository = fakeRepository();
  const tools = captureTools(repository, fakeConfirmationStore());
  const result = await tools.get('prepare_create_pad_task').handler({
    payload: {
      title: '冲突周期任务',
      startDate: Date.UTC(2026, 5, 29, 12),
      dueDate: Date.UTC(2026, 6, 5, 12),
      targetWeeks: ['2026-W39'],
    },
  });
  assert.equal(result.isError, true);
  assert.equal(jsonContent(result).code, 'TASK_PERIOD_MISMATCH');
  assert.equal(repository.calls.length, 0);
});

test('prepare update derives weeks from the final merged dates', async () => {
  const repository = fakeRepository({
    async prepareUpdatePadTask(input) {
      repository.calls.push(['prepareUpdate', input]);
      return {
        current: {
          id: input.taskId,
          start_date: Date.UTC(2026, 5, 29, 12),
          due_date: Date.UTC(2026, 6, 5, 12),
          target_weeks: ['2026-W27'],
          row_version: 3,
        },
        expectedRowVersion: 3,
        changes: input.changes,
      };
    },
  });
  const tools = captureTools(repository, fakeConfirmationStore());
  const result = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-1',
    changes: { dueDate: Date.UTC(2026, 6, 12, 12) },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.changes, {
    dueDate: Date.UTC(2026, 6, 12, 12),
    targetWeeks: ['2026-W27', '2026-W28'],
    startDate: Date.UTC(2026, 5, 29, 12),
  });
});

test('commit_update_pad_task derives the same dates through the confirmation digest', async () => {
  const repository = fakeRepository({
    async prepareUpdatePadTask(input) {
      repository.calls.push(['prepareUpdate', input]);
      return {
        current: { id: input.taskId, title: '旧标题', start_date: null, due_date: null, row_version: 3 },
        expectedRowVersion: 3,
        changes: input.changes,
      };
    },
  });
  const confirmationStore = new ConfirmationStore({ ttlMs: 60_000, now: () => 1_000 });
  const tools = captureTools(repository, confirmationStore);
  const changes = { targetWeeks: ['2026-W35'] };

  const preview = await tools.get('prepare_update_pad_task').handler({ taskId: 'task-1', changes });
  const committed = await tools.get('commit_update_pad_task').handler({
    taskId: 'task-1',
    changes,
    expectedRowVersion: preview.structuredContent.expectedRowVersion,
    confirmationToken: preview.structuredContent.confirmationToken,
    requestId: 'request-update-fill-1',
  });

  assert.equal(committed.isError, false);
  const call = repository.calls.find(([name]) => name === 'commitUpdate');
  assert.deepEqual(call[1].changes, {
    targetWeeks: ['2026-W35'], startDate: 1787572800000, dueDate: 1788091200000,
  });
});

test('name references are bound in prepare and accepted only when unchanged at commit', async () => {
  const calls = [];
  const identity = {
    owner: { userId: 'user-2', name: '张三', role: 'Employee', departmentId: 'dept-1', departmentName: '市场部' },
  };
  const repository = fakeRepository({
    async prepareCreatePadTask({ payload }) {
      calls.push(['prepare', payload]);
      const { ownerName: _ownerName, ...canonical } = payload;
      return {
        payload: { ...canonical, ownerId: 'user-2', status: 'draft' },
        identity,
      };
    },
    async commitCreatePadTask(input) { calls.push(['commit', input]); return { replayed: false }; },
  });
  const confirmationStore = new ConfirmationStore({ ttlMs: 60_000, now: () => 1_000 });
  const tools = captureTools(repository, confirmationStore);
  const preview = await tools.get('prepare_create_pad_task').handler({
    payload: { title: '姓名绑定任务', ownerName: { name: '张三', departmentName: '市场部' } },
  });
  const token = preview.structuredContent.confirmationToken;
  const result = await tools.get('commit_create_pad_task').handler({
    title: '姓名绑定任务', ownerName: { name: '张三', departmentName: '市场部' },
    confirmationToken: token, requestId: 'request-name-1',
  });
  assert.equal(result.isError, false);
  assert.equal(calls.filter(([name]) => name === 'commit').length, 1);

  const preview2 = await tools.get('prepare_create_pad_task').handler({
    payload: { title: '姓名绑定任务二', ownerName: { name: '张三', departmentName: '市场部' } },
  });
  const changed = await tools.get('commit_create_pad_task').handler({
    title: '姓名绑定任务二', ownerName: { name: '张三', departmentName: '研发部' },
    confirmationToken: preview2.structuredContent.confirmationToken, requestId: 'request-name-2',
  });
  assert.equal(changed.isError, true);
  assert.equal(jsonContent(changed).code, 'CONFIRMATION_INVALID');
});
