import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDefaultTaskPeriod,
  deriveTaskPeriodFromWeeks,
  fillTaskPeriodFromTargetWeeks,
  getCurrentIsoWeekPeriod,
  getIsoWeekRange,
} from '../src/task-period-defaults.mjs';
import { AppError } from '../src/errors.mjs';

function calendarParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: values.weekday,
    date: `${values.year}-${values.month}-${values.day}`,
  };
}

test('derives the current ISO week from the Asia/Shanghai calendar date', () => {
  const period = getCurrentIsoWeekPeriod(Date.parse('2026-08-25T03:00:00.000Z'));

  assert.deepEqual(period, {
    weekId: '2026-W35',
    startDate: Date.UTC(2026, 7, 24, 12),
    dueDate: Date.UTC(2026, 7, 30, 12),
  });
});

test('handles an ISO week-year boundary using the Shanghai date', () => {
  const period = getCurrentIsoWeekPeriod(Date.parse('2025-12-31T16:30:00.000Z'));

  assert.deepEqual(period, {
    weekId: '2026-W01',
    startDate: Date.UTC(2025, 11, 29, 12),
    dueDate: Date.UTC(2026, 0, 4, 12),
  });
});

test('fills the whole task period only when all three fields are absent', () => {
  const now = Date.parse('2026-08-25T03:00:00.000Z');

  assert.deepEqual(applyDefaultTaskPeriod({ title: '任务' }, now), {
    title: '任务',
    targetWeeks: ['2026-W35'],
    startDate: Date.UTC(2026, 7, 24, 12),
    dueDate: Date.UTC(2026, 7, 30, 12),
  });

  for (const explicit of [
    { targetWeeks: ['2026-W36'] },
    { startDate: 123 },
    { dueDate: 456 },
  ]) {
    assert.deepEqual(applyDefaultTaskPeriod({ title: '任务', ...explicit }, now), { title: '任务', ...explicit });
  }
});

test('getIsoWeekRange matches the calibrated production timestamps for 2026-W35', () => {
  assert.deepEqual(getIsoWeekRange('2026-W35'), {
    startDate: 1787572800000, // 2026-08-24T12:00:00Z，目标周周一
    dueDate: 1788091200000,   // 2026-08-30T12:00:00Z，目标周周日
  });
});

test('getIsoWeekRange handles the cross-year first week 2027-W01', () => {
  assert.deepEqual(getIsoWeekRange('2027-W01'), {
    startDate: Date.UTC(2027, 0, 4, 12),
    dueDate: Date.UTC(2027, 0, 10, 12),
  });
  assert.equal(Date.UTC(2027, 0, 4, 12), 1799064000000);
});

test('getIsoWeekRange supports W53 only in 53-week ISO years', () => {
  // 2026（1月1日为周四）与 2020（闰年、1月1日为周三）均有 53 周。
  assert.deepEqual(getIsoWeekRange('2026-W53'), {
    startDate: Date.UTC(2026, 11, 28, 12),
    dueDate: Date.UTC(2027, 0, 3, 12),
  });
  assert.deepEqual(getIsoWeekRange('2020-W53'), {
    startDate: Date.UTC(2020, 11, 28, 12),
    dueDate: Date.UTC(2021, 0, 3, 12),
  });
  // 2025 与 2027 只有 52 周，W53 不存在。
  assert.equal(getIsoWeekRange('2025-W53'), null);
  assert.equal(getIsoWeekRange('2027-W53'), null);
});

test('getIsoWeekRange handles leap-year weeks', () => {
  // 2028 为闰年，1月4日为周二，W01 周一为 1 月 3 日。
  assert.deepEqual(getIsoWeekRange('2028-W01'), {
    startDate: Date.UTC(2028, 0, 3, 12),
    dueDate: Date.UTC(2028, 0, 9, 12),
  });
  assert.deepEqual(getIsoWeekRange('2024-W09'), {
    startDate: Date.UTC(2024, 1, 26, 12),
    dueDate: Date.UTC(2024, 2, 3, 12),
  });
});

test('getIsoWeekRange rejects invalid week ids', () => {
  for (const weekId of ['2026-W00', '2026-W54', '2026-w35', '26-W35', '', null, undefined, 35, {}]) {
    assert.equal(getIsoWeekRange(weekId), null);
  }
});

test('derived timestamps land on the target Monday/Sunday in both UTC and Asia/Shanghai', () => {
  const expectations = {
    '2026-W35': { start: '2026-08-24', due: '2026-08-30' },
    '2027-W01': { start: '2027-01-04', due: '2027-01-10' },
    '2026-W53': { start: '2026-12-28', due: '2027-01-03' },
    '2020-W53': { start: '2020-12-28', due: '2021-01-03' },
    '2028-W01': { start: '2028-01-03', due: '2028-01-09' },
  };
  for (const [weekId, expected] of Object.entries(expectations)) {
    const range = getIsoWeekRange(weekId);
    for (const timeZone of ['UTC', 'Asia/Shanghai']) {
      const start = calendarParts(range.startDate, timeZone);
      const due = calendarParts(range.dueDate, timeZone);
      assert.equal(start.weekday, 'Monday', `${weekId} ${timeZone} start weekday`);
      assert.equal(due.weekday, 'Sunday', `${weekId} ${timeZone} due weekday`);
      assert.equal(start.date, expected.start, `${weekId} ${timeZone} start date`);
      assert.equal(due.date, expected.due, `${weekId} ${timeZone} due date`);
    }
  }
});

test('deriveTaskPeriodFromWeeks spans from the earliest to the latest week', () => {
  assert.deepEqual(deriveTaskPeriodFromWeeks(['2026-W35']), {
    startDate: 1787572800000,
    dueDate: 1788091200000,
  });
  // 未排序的列表也按最早/最晚周取值：W35 周一到 W37 周日。
  assert.deepEqual(deriveTaskPeriodFromWeeks(['2026-W37', '2026-W35', '2026-W36']), {
    startDate: Date.UTC(2026, 7, 24, 12),
    dueDate: Date.UTC(2026, 8, 13, 12),
  });
  assert.equal(deriveTaskPeriodFromWeeks([]), null);
  assert.equal(deriveTaskPeriodFromWeeks(null), null);
  assert.equal(deriveTaskPeriodFromWeeks(undefined), null);
});

test('deriveTaskPeriodFromWeeks rejects nonexistent ISO weeks', () => {
  assert.throws(() => deriveTaskPeriodFromWeeks(['2025-W53']), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'INVALID_ARGUMENT');
    return true;
  });
  assert.throws(() => deriveTaskPeriodFromWeeks(['2026-W35', '2027-W53']), (error) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    return true;
  });
});

test('fillTaskPeriodFromTargetWeeks fills empty dates without overriding explicit values', () => {
  const week35 = { startDate: 1787572800000, dueDate: 1788091200000 };

  assert.deepEqual(fillTaskPeriodFromTargetWeeks({ title: '任务', targetWeeks: ['2026-W35'] }), {
    title: '任务', targetWeeks: ['2026-W35'], ...week35,
  });

  // 只缺截止时间时仅填充 dueDate。
  assert.deepEqual(fillTaskPeriodFromTargetWeeks({ targetWeeks: ['2026-W35'], startDate: 123 }), {
    targetWeeks: ['2026-W35'], startDate: 123, dueDate: week35.dueDate,
  });

  // 显式传入的值一律不覆盖。
  assert.deepEqual(fillTaskPeriodFromTargetWeeks({ targetWeeks: ['2026-W35'], startDate: 123, dueDate: 456 }), {
    targetWeeks: ['2026-W35'], startDate: 123, dueDate: 456,
  });

  // 没有 targetWeeks 或为空数组时不填充。
  assert.deepEqual(fillTaskPeriodFromTargetWeeks({ title: '任务' }), { title: '任务' });
  assert.deepEqual(fillTaskPeriodFromTargetWeeks({ targetWeeks: [] }), { targetWeeks: [] });

  // 两日期均已显式提供时即使周次无效也不报错。
  assert.deepEqual(fillTaskPeriodFromTargetWeeks({ targetWeeks: ['2025-W53'], startDate: 1, dueDate: 2 }), {
    targetWeeks: ['2025-W53'], startDate: 1, dueDate: 2,
  });

  // 需要推导但周次不存在时拒绝。
  assert.throws(() => fillTaskPeriodFromTargetWeeks({ targetWeeks: ['2025-W53'] }), (error) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    return true;
  });
});

