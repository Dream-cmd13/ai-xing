import test from 'node:test';
import assert from 'node:assert/strict';

import { planTaskPeriodBackfill, runTaskPeriodBackfill } from '../scripts/backfill-task-period.mjs';

test('planTaskPeriodBackfill fills only empty dates from target weeks', () => {
  const plan = planTaskPeriodBackfill([
    { id: 't1', title: '只填周次', targetWeeks: ['2026-W35'], startDate: null, dueDate: null },
    { id: 't2', title: '已有开始', targetWeeks: ['2026-W35'], startDate: 111, dueDate: null },
    { id: 't3', title: '跨多周', targetWeeks: ['2026-W36', '2026-W35'], startDate: null, dueDate: null },
    { id: 't4', title: '已齐全', targetWeeks: ['2026-W35'], startDate: 1, dueDate: 2 },
    { id: 't5', title: '空周次', targetWeeks: [], startDate: null, dueDate: null },
    { id: 't6', title: '无效周次', targetWeeks: ['2025-W53'], startDate: null, dueDate: null },
  ]);

  assert.deepEqual(plan.updates, [
    { id: 't1', title: '只填周次', weeks: ['2026-W35'], startDate: 1787572800000, dueDate: 1788091200000 },
    { id: 't2', title: '已有开始', weeks: ['2026-W35'], startDate: 111, dueDate: 1788091200000 },
    { id: 't3', title: '跨多周', weeks: ['2026-W35', '2026-W36'], startDate: 1787572800000, dueDate: 1788696000000 },
  ]);
  assert.deepEqual(plan.skipped.map((skip) => [skip.id, skip.reason]), [
    ['t4', 'ALREADY_FILLED'],
    ['t5', 'NO_TARGET_WEEKS'],
    ['t6', 'INVALID_WEEK:2025-W53'],
  ]);
});

test('runTaskPeriodBackfill dry-run lists the plan without writing', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push([sql, params]);
      return {
        rows: [
          { id: 't1', title: '只填周次', target_weeks: ['2026-W35'], start_date: null, due_date: null },
        ],
      };
    },
  };
  const events = [];
  const logger = { info: (event) => events.push(event) };

  const summary = await runTaskPeriodBackfill({ client, execute: false, logger });

  assert.equal(summary.executed, false);
  assert.equal(summary.planned, 1);
  assert.deepEqual(summary.updates[0], {
    id: 't1', title: '只填周次', weeks: ['2026-W35'], startDate: 1787572800000, dueDate: 1788091200000,
  });
  assert.equal(queries.filter(([sql]) => /UPDATE/i.test(sql)).length, 0);
  assert.equal(events.some((event) => event.event === 'backfill_dry_run'), true);
});

test('runTaskPeriodBackfill executes guarded updates in a transaction', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push([sql, params]);
      if (/SELECT/i.test(sql)) {
        return {
          rows: [
            { id: 't1', title: '只填周次', target_weeks: ['2026-W35'], start_date: '1787000000000', due_date: null },
          ],
        };
      }
      if (/UPDATE/i.test(sql)) return { rowCount: 1 };
      return { rows: [] };
    },
  };

  const summary = await runTaskPeriodBackfill({ client, execute: true, logger: { info: () => {} } });

  assert.equal(summary.executed, true);
  assert.equal(summary.applied, 1);
  assert.equal(summary.updates[0].startDate, 1787000000000);
  assert.equal(summary.updates[0].dueDate, 1788091200000);
  const update = queries.find(([sql]) => /UPDATE/i.test(sql));
  assert.match(update[0], /WHERE id = \$1 AND \(start_date IS NULL OR due_date IS NULL\)/);
  assert.equal(update[1][0], 't1');
  assert.equal(queries.some(([sql]) => /^BEGIN/i.test(sql)), true);
  assert.equal(queries.some(([sql]) => /^COMMIT/i.test(sql)), true);
});
