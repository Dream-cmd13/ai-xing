import { AppError } from './errors.mjs';

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TASK_WEEKS = 53;
const WEEK_ID_PATTERN = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;

const invalidPeriod = (message) => new AppError('INVALID_ARGUMENT', message);
const periodMismatch = () => new AppError('TASK_PERIOD_MISMATCH', 'targetWeeks 与任务日期派生周不一致。');

function shanghaiDateParts(nowMs) {
  const timestamp = Number(nowMs);
  if (!Number.isFinite(timestamp) || timestamp < 0 || Number.isNaN(new Date(timestamp).getTime())) {
    throw invalidPeriod('任务日期必须是有效时间戳。');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return {
    year, month, day,
    isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    epochDay: Math.floor(Date.UTC(year, month - 1, day) / DAY_MS),
  };
}

function isoWeekForDate({ year, month, day }) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDay);
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil((((date.getTime() - yearStart) / DAY_MS) + 1) / 7);
  return { isoYear, week };
}

function isoWeekRange(isoYear, week) {
  const januaryFourth = new Date(Date.UTC(isoYear, 0, 4));
  const daysSinceMonday = (januaryFourth.getUTCDay() + 6) % 7;
  const startDate = Date.UTC(isoYear, 0, 4 - daysSinceMonday + ((week - 1) * 7), 12);
  return { startDate, dueDate: startDate + (6 * DAY_MS) };
}

function weekIdForEpochDay(epochDay) {
  const date = new Date(epochDay * DAY_MS);
  const { isoYear, week } = isoWeekForDate({
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
  });
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function startOfIsoWeek(epochDay) {
  const isoDay = new Date(epochDay * DAY_MS).getUTCDay() || 7;
  return epochDay - (isoDay - 1);
}

function sameWeeks(left, right) {
  return Array.isArray(left) && left.length === right.length
    && left.every((week, index) => week === right[index]);
}

export function deriveTaskWeeksFromDateRange(startDate, dueDate) {
  if (startDate === null || startDate === undefined || dueDate === null || dueDate === undefined) {
    throw invalidPeriod('任务开始和截止日期必须完整。');
  }
  const start = shanghaiDateParts(startDate);
  const due = shanghaiDateParts(dueDate);
  if (start.epochDay > due.epochDay) throw invalidPeriod('任务开始日期不得晚于截止日期。');
  const targetWeeks = [];
  for (let weekDay = startOfIsoWeek(start.epochDay); weekDay <= due.epochDay; weekDay += 7) {
    targetWeeks.push(weekIdForEpochDay(weekDay));
    if (targetWeeks.length > MAX_TASK_WEEKS) throw invalidPeriod('任务日期跨度最多覆盖 53 个 ISO 周。');
  }
  return { startDay: start.isoDate, dueDay: due.isoDate, targetWeeks };
}

export function getIsoWeekRange(weekId) {
  const match = WEEK_ID_PATTERN.exec(typeof weekId === 'string' ? weekId : '');
  if (!match) return null;
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  const range = isoWeekRange(isoYear, week);
  const roundTrip = weekIdForEpochDay(Math.floor(range.startDate / DAY_MS));
  return roundTrip === weekId ? range : null;
}

export function deriveTaskPeriodFromWeeks(weekIds) {
  if (!Array.isArray(weekIds) || weekIds.length === 0) return null;
  const ranges = [...new Set(weekIds)].map((weekId) => ({ weekId, range: getIsoWeekRange(weekId) }));
  if (ranges.some(({ range }) => !range)) throw invalidPeriod('targetWeeks 含无效或不存在的 ISO 周次。');
  ranges.sort((left, right) => left.range.startDate - right.range.startDate);
  return { startDate: ranges[0].range.startDate, dueDate: ranges[ranges.length - 1].range.dueDate };
}

export function normalizeTaskPeriodInput(payload, { defaultPeriod = false, nowMs = Date.now() } = {}) {
  const next = structuredClone(payload ?? {});
  const hasStart = next.startDate !== undefined && next.startDate !== null;
  const hasDue = next.dueDate !== undefined && next.dueDate !== null;
  const hasWeeks = next.targetWeeks !== undefined;
  if (!hasStart && !hasDue && !hasWeeks) {
    if (!defaultPeriod) return next;
    const period = getCurrentIsoWeekPeriod(nowMs);
    return { ...next, targetWeeks: [period.weekId], startDate: period.startDate, dueDate: period.dueDate };
  }
  if (hasStart !== hasDue) throw invalidPeriod('任务开始和截止日期必须同时提供。');
  if (!hasStart && !hasDue) {
    const range = deriveTaskPeriodFromWeeks(next.targetWeeks);
    if (!range) throw invalidPeriod('targetWeeks 不能为空。');
    const derived = deriveTaskWeeksFromDateRange(range.startDate, range.dueDate);
    return { ...next, ...range, targetWeeks: derived.targetWeeks };
  }
  const derived = deriveTaskWeeksFromDateRange(next.startDate, next.dueDate);
  if (hasWeeks && !sameWeeks(next.targetWeeks, derived.targetWeeks)) throw periodMismatch();
  next.targetWeeks = derived.targetWeeks;
  return next;
}

export function fillTaskPeriodFromTargetWeeks(payload) {
  return normalizeTaskPeriodInput(payload);
}

export function getCurrentIsoWeekPeriod(nowMs = Date.now()) {
  const { isoYear, week } = isoWeekForDate(shanghaiDateParts(nowMs));
  return { weekId: `${isoYear}-W${String(week).padStart(2, '0')}`, ...isoWeekRange(isoYear, week) };
}

export function applyDefaultTaskPeriod(payload, nowMs = Date.now()) {
  return normalizeTaskPeriodInput(payload, { defaultPeriod: true, nowMs });
}
