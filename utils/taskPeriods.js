const ISO_WEEK_PATTERN = /^(\d{4})-W(\d{2})$/;
const MONTH_PERIOD_PATTERN = /^(\d{4})-M(\d{2})$/;

const parseIsoWeekId = (weekId) => {
  if (typeof weekId !== 'string') return null;
  const match = ISO_WEEK_PATTERN.exec(weekId);
  if (!match) return null;

  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
    return null;
  }

  return { year, week };
};

const getIsoWeekAnchorDate = (weekId) => {
  const parsed = parseIsoWeekId(weekId);
  if (!parsed) return null;

  const { year, week } = parsed;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);

  // Use Thursday as the stable anchor for the ISO week/year.
  const anchor = new Date(week1Monday);
  anchor.setUTCDate(week1Monday.getUTCDate() + ((week - 1) * 7) + 3);
  return anchor;
};

export const isTaskInWeeklyPeriod = (targetWeeks, selectedWeek) =>
  Array.isArray(targetWeeks) && targetWeeks.includes(selectedWeek);

export const isTaskInMonthlyPeriod = (targetWeeks, selectedMonth) => {
  if (!Array.isArray(targetWeeks) || typeof selectedMonth !== 'string') return false;

  const match = MONTH_PERIOD_PATTERN.exec(selectedMonth);
  if (!match) return false;

  const selectedYear = Number(match[1]);
  const selectedMonthNumber = Number(match[2]);

  return targetWeeks.some((weekId) => {
    const anchor = getIsoWeekAnchorDate(weekId);
    if (!anchor) return false;

    return (
      anchor.getUTCFullYear() === selectedYear &&
      anchor.getUTCMonth() + 1 === selectedMonthNumber
    );
  });
};

export const ensureTaskTargetWeeks = (task, fallbackWeekId) => {
  if (Array.isArray(task?.targetWeeks) && task.targetWeeks.length > 0) {
    return task;
  }

  if (!fallbackWeekId) {
    return {
      ...task,
      targetWeeks: [],
    };
  }

  return {
    ...task,
    targetWeeks: [fallbackWeekId],
  };
};
