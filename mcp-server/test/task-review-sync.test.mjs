import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../src/errors.mjs';
import { createWriteRepository } from '../src/write-repository.mjs';
import { ConfirmationStore } from '../src/confirmation-store.mjs';
import { registerWriteTools } from '../src/write-tools.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

function repository(fake, context = { userId: 'user-1', accessToken: 'jwt-1', role: 'Employee', sessionId: 'session-1' }) {
  return createWriteRepository({
    createUserClient: () => fake.client,
    getContext: () => context,
    requestTimeoutMs: 1000,
  });
}

function captureTools(repositoryValue, confirmationStore) {
  const tools = new Map();
  registerWriteTools({
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  }, repositoryValue, confirmationStore);
  return tools;
}

const reviewEntry = {
  id: 'review-1',
  content: '本周复盘',
  score: 80,
  okrDetails: {
    'objective-1': {
      progress: 10,
      krReviews: [{
        taskEvaluations: { 'task-1': '旧实际成果' },
        taskScores: { 'task-1': 60 },
      }],
    },
  },
};

const task = {
  id: 'task-1',
  title: '任务',
  status: 'draft',
  aligned_kr_id: 'objective-1-kr-0',
  department_id: 'dept-1',
  target_weeks: ['2026-W34'],
  task_review: '旧实际成果',
  task_review_score: 60,
  row_version: 3,
};

test('prepare review update derives the only target week and captures the department slot', async () => {
  const fake = fakeSupabase({
    tasks: { data: task, error: null },
    departments: { data: { id: 'dept-1', reviews: { '2026-W34': [reviewEntry] }, row_version: 7 }, error: null },
  });
  const repo = repository(fake);

  const result = await repo.prepareUpdatePadTask({
    taskId: 'task-1',
    changes: { taskReview: '新实际成果', taskReviewScore: 90 },
  });

  assert.equal(result.reviewSync.periodKey, '2026-W34');
  assert.equal(result.reviewSync.departmentId, 'dept-1');
  assert.equal(result.reviewSync.expectedRowVersion, 7);
  assert.equal(result.reviewSync.reviewKey, 'objective-1');
  assert.equal(result.reviewSync.krIndex, 0);
  assert.deepEqual(result.reviewSync.before, { evaluation: '旧实际成果', score: 60 });
  assert.deepEqual(result.reviewSync.after, { evaluation: '新实际成果', score: 90 });
});

test('review preview uses task fields as the final value when the existing card is stale', async () => {
  const fake = fakeSupabase({
    tasks: { data: { ...task, task_review: '任务表成果', task_review_score: 75 }, error: null },
    departments: {
      data: {
        id: 'dept-1',
        reviews: { '2026-W34': [{ ...reviewEntry, okrDetails: { 'objective-1': { krReviews: [{ taskEvaluations: { 'task-1': '旧卡片成果' }, taskScores: { 'task-1': 10 } }] } } }] },
        row_version: 7,
      },
      error: null,
    },
  });
  const result = await repository(fake).prepareUpdatePadTask({ taskId: 'task-1', changes: { taskReview: '新成果' } });

  assert.deepEqual(result.reviewSync.before, { evaluation: '旧卡片成果', score: 10 });
  assert.deepEqual(result.reviewSync.after, { evaluation: '新成果', score: 75 });
});

test('prepare review update requires an explicit period for multiple target weeks', async () => {
  const fake = fakeSupabase({
    tasks: { data: { ...task, target_weeks: ['2026-W34', '2026-W35'] }, error: null },
  });
  const repo = repository(fake);

  await assert.rejects(
    repo.prepareUpdatePadTask({ taskId: 'task-1', changes: { taskReview: '新结果' } }),
    (error) => error instanceof AppError && error.code === 'INVALID_ARGUMENT',
  );
});

test('review update commit uses the atomic task-review RPC and carries both versions', async () => {
  const fake = fakeSupabase({
    'rpc:mcp_update_pad_task_with_review_sync': {
      data: {
        replayed: false,
        task: { id: 'task-1', rowVersion: 4 },
        reviewSync: { departmentId: 'dept-1', rowVersion: 8 },
        rowVersion: 4,
        departmentRowVersion: 8,
      },
      error: null,
    },
  });
  const repo = repository(fake);

  await repo.commitUpdatePadTask({
    taskId: 'task-1',
    changes: { task_review: '新结果', task_review_score: 90 },
    reviewPeriodKey: '2026-W34',
    reviewKey: 'objective-1',
    krIndex: 0,
    expectedRowVersion: 3,
    expectedDepartmentRowVersion: 7,
    requestId: 'request-review-sync-1',
  });

  const rpc = fake.calls.find((call) => call[0] === 'rpc');
  assert.equal(rpc[1], 'mcp_update_pad_task_with_review_sync');
  assert.deepEqual(rpc[2], {
    p_task_id: 'task-1',
    p_changes: { task_review: '新结果', task_review_score: 90 },
    p_review_period_key: '2026-W34',
    p_review_key: 'objective-1',
    p_kr_index: 0,
    p_expected_row_version: 3,
    p_expected_department_row_version: 7,
    p_request_id: 'request-review-sync-1',
  });
});

test('prepare_update_pad_task exposes the derived review period and department version in its confirmation metadata', async () => {
  const fake = fakeSupabase({
    tasks: { data: task, error: null },
    departments: { data: { id: 'dept-1', reviews: { '2026-W34': [reviewEntry] }, row_version: 7 }, error: null },
  });
  const repo = repository(fake);
  const tools = captureTools(repo, new ConfirmationStore({ ttlMs: 60_000, now: () => 1000 }));

  const result = await tools.get('prepare_update_pad_task').handler({
    taskId: 'task-1',
    changes: { taskReview: '新结果' },
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.reviewSync.periodKey, '2026-W34');
  assert.equal(result.structuredContent.reviewSync.expectedRowVersion, 7);
  assert.equal(result.structuredContent.confirmation.parameterSummary.reviewPeriodKey, '2026-W34');
});

test('review confirmation carries department version to the atomic commit and rejects period tampering', async () => {
  const calls = [];
  const repositoryValue = {
    getContext: () => ({ userId: 'user-1', role: 'Employee', sessionId: 'session-1' }),
    async prepareUpdatePadTask(input) {
      calls.push(['prepare', input]);
      return {
        current: { id: input.taskId, rowVersion: 3 },
        expectedRowVersion: 3,
        reviewSync: {
          departmentId: 'dept-1', periodKey: '2026-W34', reviewKey: 'objective-1', krIndex: 0,
          expectedRowVersion: 7, before: { evaluation: '旧', score: 60 }, after: { evaluation: '新', score: 90 },
        },
      };
    },
    async lookupWriteResult() { return null; },
    async commitUpdatePadTask(input) { calls.push(['commit', input]); return { replayed: false, rowVersion: 4, departmentRowVersion: 8 }; },
    async recordFailedWrite() {},
  };
  const store = new ConfirmationStore({ ttlMs: 60_000, now: () => 1000 });
  const tools = captureTools(repositoryValue, store);
  const preview = await tools.get('prepare_update_pad_task').handler({ taskId: 'task-1', changes: { taskReview: '新' } });
  const token = preview.structuredContent.confirmationToken;

  const tampered = await tools.get('commit_update_pad_task').handler({
    taskId: 'task-1', changes: { taskReview: '新' }, reviewPeriodKey: '2026-W35', expectedRowVersion: 3,
    confirmationToken: token, requestId: 'request-review-sync-2',
  });
  assert.equal(tampered.isError, true);
  assert.equal(JSON.parse(tampered.content[0].text).code, 'CONFIRMATION_INVALID');
  assert.equal(calls.some(([name]) => name === 'commit'), false);

  const committed = await tools.get('commit_update_pad_task').handler({
    taskId: 'task-1', changes: { taskReview: '新' }, expectedRowVersion: 3,
    confirmationToken: token, requestId: 'request-review-sync-2',
  });
  assert.equal(committed.isError, false);
  assert.deepEqual(calls.find(([name]) => name === 'commit')[1], {
    taskId: 'task-1', changes: { taskReview: '新' }, expectedRowVersion: 3,
    reviewPeriodKey: '2026-W34', expectedDepartmentRowVersion: 7,
    reviewKey: 'objective-1', krIndex: 0, requestId: 'request-review-sync-2',
  });
});

test('review-sync migration is additive and defines the dual-row transaction contract', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sql = await readFile(path.join(root, 'sql', '2026-08-25_mcp_task_review_sync_rpc.sql'), 'utf8');

  assert.match(sql, /BEGIN\s*;/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_update_pad_task_with_review_sync\s*\(/i);
  assert.match(sql, /FOR UPDATE[\s\S]*FROM public\.departments/i);
  assert.match(sql, /current_user_can_edit_department_reviews\s*\(\s*old_task\.department_id\s*\)/i);
  assert.match(sql, /p_expected_row_version/);
  assert.match(sql, /p_expected_department_row_version/);
  assert.match(sql, /taskEvaluations/);
  assert.match(sql, /taskScores/);
  assert.match(sql, /mcp_write_log/);
  assert.match(sql, /mcp_audit_log/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mcp_update_pad_task_with_review_sync[\s\S]*TO authenticated/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE|DROP\s+POLICY|CREATE\s+POLICY/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
});

test('review-sync initializes missing task evaluation and score maps before task-level writes', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sql = await readFile(path.join(root, 'sql', '2026-08-25_mcp_task_review_sync_rpc.sql'), 'utf8');

  assert.match(sql, /task_evaluations\s+JSONB/i);
  assert.match(sql, /task_scores\s+JSONB/i);
  assert.match(sql, /task_evaluations\s*:=\s*CASE[\s\S]{0,220}jsonb_typeof\(old_kr_review->'taskEvaluations'\)[\s\S]{0,180}'\{\}'::jsonb/i);
  assert.match(sql, /task_scores\s*:=\s*CASE[\s\S]{0,220}jsonb_typeof\(old_kr_review->'taskScores'\)[\s\S]{0,180}'\{\}'::jsonb/i);
  assert.match(sql, /jsonb_set\(task_evaluations,\s*ARRAY\[old_task\.id\][\s\S]{0,120}to_jsonb\(next_evaluation\)/i);
  assert.match(sql, /jsonb_set\(task_scores,\s*ARRAY\[old_task\.id\][\s\S]{0,120}to_jsonb\(next_score\)/i);
});

test('review-sync authorization separates review-only changes from ordinary task edits', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sql = await readFile(
    path.join(root, 'sql', '2026-08-25_mcp_task_review_sync_rpc.sql'),
    'utf8',
  );

  assert.match(
    sql,
    /review_only\s*:=\s*\(\s*p_changes\s*-\s*'task_review'\s*-\s*'task_review_score'\s*\)\s*=\s*'\{\}'::jsonb/i,
  );
  assert.match(
    sql,
    /review_only[\s\S]{0,700}has_menu_permission\(\s*'okr-review'\s*,\s*'update'\s*\)[\s\S]{0,700}current_user_can_edit_department_reviews/i,
  );
  assert.match(
    sql,
    /NOT\s+review_only[\s\S]{0,700}current_user_can_manage_task/i,
  );
});
