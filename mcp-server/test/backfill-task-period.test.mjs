import test from 'node:test';
import assert from 'node:assert/strict';

import { planTaskPeriodBackfill, runTaskPeriodBackfill } from '../scripts/backfill-task-period.mjs';

const w27Start = Date.UTC(2026, 5, 29, 12);
const w27Due = Date.UTC(2026, 6, 5, 12);

function fakeClient(initialRows, { mutateBeforeLockRead = null } = {}) {
  const rows = structuredClone(initialRows);
  const calls = [];
  let taskSelects = 0;
  return {
    calls,
    rows,
    async query(sql, params) {
      calls.push([sql, params]);
      if (/FROM public\.tasks/i.test(sql) && /^\s*SELECT/i.test(sql)) {
        taskSelects += 1;
        if (taskSelects === 2 && mutateBeforeLockRead) mutateBeforeLockRead(rows);
        return { rows: structuredClone(rows) };
      }
      if (/FROM pg_catalog\.pg_trigger/i.test(sql)) {
        return { rows: [
          { trigger_name: 'enforce_task_owner_scope_on_tasks', function_name: 'enforce_task_owner_scope' },
          { trigger_name: 'mcp_validate_task_row_contract_trigger', function_name: 'mcp_validate_task_row_contract' },
        ] };
      }
      if (/UPDATE public\.tasks/i.test(sql)) {
        const [id, expectedWeeksJson, rowVersion, oldWeeksJson, startDate, dueDate] = params;
        const row = rows.find((item) => item.id === id
          && Number(item.row_version) === rowVersion
          && JSON.stringify(item.target_weeks) === oldWeeksJson
          && Number(item.start_date) === startDate
          && Number(item.due_date) === dueDate);
        if (!row) return { rowCount: 0 };
        row.target_weeks = JSON.parse(expectedWeeksJson);
        row.row_version += 1;
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('planTaskPeriodBackfill derives exact weeks and never guesses missing dates', () => {
  const plan = planTaskPeriodBackfill([
    { id: 'task-1', target_weeks: ['2026-W39'], start_date: w27Start, due_date: w27Due, row_version: 7 },
    { id: 'task-2', target_weeks: ['2026-W27'], start_date: w27Start, due_date: w27Due, row_version: 2 },
    { id: 'task-3', target_weeks: ['2026-W27'], start_date: null, due_date: null, row_version: 4 },
  ]);
  assert.deepEqual(plan.updates, [{
    id: 'task-1', rowVersion: 7, oldWeeks: ['2026-W39'],
    startDate: w27Start, dueDate: w27Due, expectedWeeks: ['2026-W27'],
  }]);
  assert.deepEqual(plan.exceptions, [{ id: 'task-3', rowVersion: 4, reason: 'MISSING_DATE' }]);
  assert.match(plan.digest, /^[0-9a-f]{64}$/);
});

test('dry-run is read-only and logs identifier-only exceptions', async () => {
  const client = fakeClient([
    { id: 'task-1', target_weeks: ['2026-W39'], start_date: w27Start, due_date: w27Due, row_version: 7 },
    { id: 'task-2', target_weeks: [], start_date: null, due_date: null, row_version: 1 },
  ]);
  const events = [];
  const result = await runTaskPeriodBackfill({ client, logger: { info: (event) => events.push(event) } });
  assert.equal(result.executed, false);
  assert.equal(result.planned, 1);
  assert.equal(result.exceptions, 1);
  assert.equal(client.calls.some(([sql]) => /UPDATE public\.tasks/i.test(sql)), false);
  assert.deepEqual(events.find((event) => event.event === 'backfill_exception'), {
    event: 'backfill_exception', taskId: 'task-2', rowVersion: 1, reason: 'MISSING_DATE',
  });
});

test('execute requires the exact dry-run count and digest', async () => {
  const client = fakeClient([
    { id: 'task-1', target_weeks: ['2026-W39'], start_date: w27Start, due_date: w27Due, row_version: 7 },
  ]);
  await assert.rejects(
    () => runTaskPeriodBackfill({ client, execute: true, expectedCount: 1, expectedDigest: '0'.repeat(64) }),
    /摘要已变化/,
  );
  assert.equal(client.calls.some(([sql]) => /^BEGIN/i.test(sql)), false);
});

test('execute locks, applies row-version guards and changes only weeks plus row version', async () => {
  const initial = [
    { id: 'task-1', target_weeks: ['2026-W39'], start_date: w27Start, due_date: w27Due, row_version: 7 },
  ];
  const dry = planTaskPeriodBackfill(initial);
  const client = fakeClient(initial);
  const result = await runTaskPeriodBackfill({
    client,
    execute: true,
    expectedCount: dry.updates.length,
    expectedDigest: dry.digest,
    logger: { info: () => {} },
  });
  assert.equal(result.executed, true);
  assert.equal(result.applied, 1);
  assert.deepEqual(client.rows[0], {
    id: 'task-1', target_weeks: ['2026-W27'], start_date: w27Start, due_date: w27Due, row_version: 8,
  });
  const update = client.calls.find(([sql]) => /UPDATE public\.tasks/i.test(sql));
  assert.match(update[0], /target_weeks = \$2::JSONB/i);
  assert.match(update[0], /row_version = row_version \+ 1/i);
  assert.match(update[0], /AND row_version = \$3/i);
  assert.equal(client.calls.some(([sql]) => /pg_advisory_xact_lock/i.test(sql)), true);
  assert.equal(client.calls.some(([sql]) => /DISABLE TRIGGER enforce_task_owner_scope_on_tasks/i.test(sql)), true);
  assert.equal(client.calls.some(([sql]) => /DISABLE TRIGGER mcp_validate_task_row_contract_trigger/i.test(sql)), true);
  assert.equal(client.calls.some(([sql]) => /ENABLE TRIGGER mcp_validate_task_row_contract_trigger/i.test(sql)), true);
  assert.equal(client.calls.some(([sql]) => /ENABLE TRIGGER enforce_task_owner_scope_on_tasks/i.test(sql)), true);
  assert.equal(client.calls.some(([sql]) => /^COMMIT/i.test(sql)), true);
});

test('execute rolls back when the locked snapshot differs from dry-run', async () => {
  const initial = [
    { id: 'task-1', target_weeks: ['2026-W39'], start_date: w27Start, due_date: w27Due, row_version: 7 },
  ];
  const dry = planTaskPeriodBackfill(initial);
  const client = fakeClient(initial, {
    mutateBeforeLockRead(rows) { rows[0].row_version = 8; },
  });
  await assert.rejects(() => runTaskPeriodBackfill({
    client,
    execute: true,
    expectedCount: 1,
    expectedDigest: dry.digest,
    logger: { info: () => {} },
  }), /摘要已变化/);
  assert.equal(client.calls.some(([sql]) => /^ROLLBACK/i.test(sql)), true);
  assert.equal(client.calls.some(([sql]) => /UPDATE public\.tasks/i.test(sql)), false);
});
