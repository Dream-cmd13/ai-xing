import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveTaskWeeksFromDateRange,
  getTaskPeriodConsistency,
  getTaskWeekDisplay,
  normalizeTaskPeriodFromDates,
} from '../../utils/reviewPeriodConsistency.js';
import { taskPeriodVectors } from './fixtures/task-period-vectors.mjs';

for (const vector of taskPeriodVectors) {
  test(`browser derives ${vector.name}`, () => {
    assert.deepEqual(deriveTaskWeeksFromDateRange(vector.startDate, vector.dueDate), {
      startDay: vector.startDay,
      dueDay: vector.dueDay,
      targetWeeks: [...vector.targetWeeks],
    });
  });
}

test('single-week June task belongs only to W27 and never W39', () => {
  const task = normalizeTaskPeriodFromDates({
    id: 'task-1',
    startDate: Date.parse('2026-06-29T04:00:00.000Z'),
    dueDate: Date.parse('2026-07-05T04:00:00.000Z'),
    targetWeeks: ['2026-W39'],
  });
  assert.deepEqual(task.targetWeeks, ['2026-W27']);
  assert.equal(task.targetWeeks.includes('2026-W39'), false);
});

test('browser rejects incomplete, reversed, invalid and overlong date ranges', () => {
  assert.throws(() => deriveTaskWeeksFromDateRange(null, Date.now()), /必须完整/);
  assert.throws(() => deriveTaskWeeksFromDateRange(Date.now(), null), /必须完整/);
  assert.throws(() => deriveTaskWeeksFromDateRange(Number.NaN, Date.now()), /有效时间戳/);
  assert.throws(() => deriveTaskWeeksFromDateRange(Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 1)), /不得晚于/);
  assert.throws(() => deriveTaskWeeksFromDateRange(Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 15)), /53/);
});

test('consistency requires stored weeks to exactly equal date-derived weeks', () => {
  const base = {
    startDate: Date.parse('2026-06-29T04:00:00.000Z'),
    dueDate: Date.parse('2026-07-05T04:00:00.000Z'),
  };
  assert.equal(getTaskPeriodConsistency({ ...base, targetWeeks: ['2026-W27'] }).status, 'valid');
  const mismatch = getTaskPeriodConsistency({ ...base, targetWeeks: ['2026-W27', '2026-W39'] });
  assert.equal(mismatch.status, 'week-mismatch');
  assert.deepEqual(mismatch.expectedWeeks, ['2026-W27']);
  assert.equal(getTaskPeriodConsistency({ ...base, targetWeeks: [] }).status, 'missing-week');
  assert.equal(getTaskPeriodConsistency({ ...base, targetWeeks: ['2025-W53'] }).status, 'invalid-week');
  assert.equal(getTaskPeriodConsistency({ targetWeeks: ['2026-W27'] }).status, 'missing-date');
});

test('week display validates W53 and sorts unique weeks', () => {
  assert.deepEqual(getTaskWeekDisplay(['2021-W01', '2020-W53', '2020-W53']), {
    label: '2020-W53 至 2021-W01',
    normalizedWeeks: ['2020-W53', '2021-W01'],
    startDate: Date.UTC(2020, 11, 28, 12),
    dueDate: Date.UTC(2021, 0, 10, 12),
  });
  assert.equal(getTaskWeekDisplay(['2025-W53']), null);
});
