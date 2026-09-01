import { AppError } from './errors.mjs';

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_ID_PATTERN = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;

function shanghaiDateParts(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
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
  // 每年 1 月 4 日恒定落在 ISO 第 1 周，周一为每周第一天；
  // week1 的周一 = 1月4日 - (该日的ISO星期数 - 1) 天。
  const januaryFourth = new Date(Date.UTC(isoYear, 0, 4));
  const daysSinceMonday = (januaryFourth.getUTCDay() + 6) % 7;
  const startDate = Date.UTC(isoYear, 0, 4 - daysSinceMonday + ((week - 1) * 7), 12);
  return { startDate, dueDate: startDate + (6 * DAY_MS) };
}

function isoWeekForUtcMs(ms) {
  const date = new Date(ms);
  return isoWeekForDate({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

/**
 * 解析 ISO 周次（如 2026-W35）并返回按线上约定的时间范围：
 * startDate = 目标周周一 12:00:00 UTC，dueDate = 该周周日 12:00:00 UTC。
 * 格式非法或该 ISO 年不存在该周（如 52 周年份的 W53）时返回 null。
 */
export function getIsoWeekRange(weekId) {
  const match = WEEK_ID_PATTERN.exec(typeof weekId === 'string' ? weekId : '');
  if (!match) return null;
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  const range = isoWeekRange(isoYear, week);
  // 回查校验：起点周一必须仍属于请求的 ISO 年/周，防止 52 周年份的 W53 溢出到下一年。
  const roundTrip = isoWeekForUtcMs(range.startDate);
  if (roundTrip.isoYear !== isoYear || roundTrip.week !== week) return null;
  return range;
}

/**
 * 根据目标周列表推导任务起止时间：最早一周的周一为开始，最晚一周的周日为截止。
 * 列表为空返回 null；含无效或不存在的 ISO 周次时抛 INVALID_ARGUMENT。
 */
export function deriveTaskPeriodFromWeeks(weekIds) {
  if (!Array.isArray(weekIds) || weekIds.length === 0) return null;
  const sorted = [...weekIds].sort();
  const first = getIsoWeekRange(sorted[0]);
  const last = getIsoWeekRange(sorted[sorted.length - 1]);
  if (!first || !last) {
    throw new AppError('INVALID_ARGUMENT', `targetWeeks 含无效或不存在的 ISO 周次（${sorted[0]}）。`);
  }
  return { startDate: first.startDate, dueDate: last.dueDate };
}

/**
 * 为只携带 targetWeeks 的任务负载自动填充起止时间：startDate 为空取最早一周的周一，
 * dueDate 为空取最晚一周的周日；显式传入的值一律不覆盖。
 */
export function fillTaskPeriodFromTargetWeeks(payload) {
  const next = structuredClone(payload ?? {});
  if (next.startDate !== undefined && next.dueDate !== undefined) return next;
  const derived = deriveTaskPeriodFromWeeks(next.targetWeeks);
  if (!derived) return next;
  if (next.startDate === undefined) next.startDate = derived.startDate;
  if (next.dueDate === undefined) next.dueDate = derived.dueDate;
  return next;
}

export function getCurrentIsoWeekPeriod(nowMs = Date.now()) {
  const { isoYear, week } = isoWeekForDate(shanghaiDateParts(nowMs));
  const range = isoWeekRange(isoYear, week);
  return {
    weekId: `${isoYear}-W${String(week).padStart(2, '0')}`,
    ...range,
  };
}

export function applyDefaultTaskPeriod(payload, nowMs = Date.now()) {
  const next = structuredClone(payload ?? {});
  if (['targetWeeks', 'startDate', 'dueDate'].some((key) => next[key] !== undefined)) return next;
  const period = getCurrentIsoWeekPeriod(nowMs);
  next.targetWeeks = [period.weekId];
  next.startDate = period.startDate;
  next.dueDate = period.dueDate;
  return next;
}
