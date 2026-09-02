const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const ISO_WEEK_PATTERN = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TASK_WEEKS = 53;

const formatBusinessDay = (year, month, day) => (
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
);

const taskPeriodError = (message, code = 'TASK_PERIOD_INVALID') => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const getShanghaiBusinessDay = (value) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw taskPeriodError('任务日期必须是有效时间戳。');
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw taskPeriodError('任务日期必须是有效时间戳。');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return {
    isoDate: formatBusinessDay(year, month, day),
    epochDay: Math.floor(Date.UTC(year, month - 1, day) / DAY_MS),
  };
};

const isoWeekFromEpochDay = (epochDay) => {
  const date = new Date(epochDay * DAY_MS);
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDay);
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil((((date.getTime() - yearStart) / DAY_MS) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
};

const startOfIsoWeek = (epochDay) => {
  const isoDay = new Date(epochDay * DAY_MS).getUTCDay() || 7;
  return epochDay - (isoDay - 1);
};

export const deriveTaskWeeksFromDateRange = (startDate, dueDate) => {
  if (startDate === null || startDate === undefined || dueDate === null || dueDate === undefined) {
    throw taskPeriodError('任务开始和截止日期必须完整。');
  }
  const start = getShanghaiBusinessDay(startDate);
  const due = getShanghaiBusinessDay(dueDate);
  if (start.epochDay > due.epochDay) {
    throw taskPeriodError('任务开始日期不得晚于截止日期。');
  }

  const targetWeeks = [];
  for (let weekDay = startOfIsoWeek(start.epochDay); weekDay <= due.epochDay; weekDay += 7) {
    targetWeeks.push(isoWeekFromEpochDay(weekDay));
    if (targetWeeks.length > MAX_TASK_WEEKS) {
      throw taskPeriodError('任务日期跨度最多覆盖 53 个 ISO 周。');
    }
  }
  return { startDay: start.isoDate, dueDay: due.isoDate, targetWeeks };
};

export const getIsoWeekRange = (weekId) => {
  const match = ISO_WEEK_PATTERN.exec(typeof weekId === 'string' ? weekId : '');
  if (!match) return null;
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(isoYear, 0, 4));
  const daysSinceMonday = (januaryFourth.getUTCDay() + 6) % 7;
  const startDate = Date.UTC(isoYear, 0, 4 - daysSinceMonday + ((week - 1) * 7), 12);
  if (isoWeekFromEpochDay(Math.floor(startDate / DAY_MS)) !== weekId) return null;
  return { weekId, startDate, dueDate: startDate + (6 * DAY_MS) };
};

const normalizeStoredWeeks = (targetWeeks) => {
  if (!Array.isArray(targetWeeks) || targetWeeks.length === 0) return null;
  const unique = [...new Set(targetWeeks)];
  const ranges = unique.map(getIsoWeekRange);
  if (ranges.some((range) => !range)) return null;
  return ranges.sort((left, right) => left.startDate - right.startDate).map((range) => range.weekId);
};

export const getTaskWeekDisplay = (targetWeeks) => {
  const normalizedWeeks = normalizeStoredWeeks(targetWeeks);
  if (!normalizedWeeks) return null;
  const first = getIsoWeekRange(normalizedWeeks[0]);
  const last = getIsoWeekRange(normalizedWeeks[normalizedWeeks.length - 1]);
  return {
    label: first.weekId === last.weekId ? first.weekId : `${first.weekId} 至 ${last.weekId}`,
    normalizedWeeks,
    startDate: first.startDate,
    dueDate: last.dueDate,
  };
};

export const getTaskPeriodConsistency = (task) => {
  let derived;
  try {
    derived = deriveTaskWeeksFromDateRange(task?.startDate, task?.dueDate);
  } catch (error) {
    const missingStart = task?.startDate === null || task?.startDate === undefined;
    const missingDue = task?.dueDate === null || task?.dueDate === undefined;
    return {
      status: missingStart || missingDue ? 'missing-date' : 'invalid-date',
      normalizedWeeks: [],
      expectedWeeks: [],
      range: null,
      conflictingFields: [
        ...(missingStart ? ['startDate'] : []),
        ...(missingDue ? ['dueDate'] : []),
        ...(!missingStart && !missingDue ? ['startDate', 'dueDate'] : []),
      ],
      message: error.message,
    };
  }

  const normalizedWeeks = normalizeStoredWeeks(task?.targetWeeks);
  if (!Array.isArray(task?.targetWeeks) || task.targetWeeks.length === 0) {
    return {
      status: 'missing-week', normalizedWeeks: [], expectedWeeks: derived.targetWeeks,
      range: { startDate: task.startDate, dueDate: task.dueDate }, conflictingFields: ['targetWeeks'],
    };
  }
  if (!normalizedWeeks) {
    return {
      status: 'invalid-week', normalizedWeeks: [], expectedWeeks: derived.targetWeeks,
      range: { startDate: task.startDate, dueDate: task.dueDate }, conflictingFields: ['targetWeeks'],
    };
  }

  const isMatch = normalizedWeeks.length === derived.targetWeeks.length
    && normalizedWeeks.every((week, index) => week === derived.targetWeeks[index]);
  return {
    status: isMatch ? 'valid' : 'week-mismatch',
    normalizedWeeks,
    expectedWeeks: derived.targetWeeks,
    range: { startDate: task.startDate, dueDate: task.dueDate },
    conflictingFields: isMatch ? [] : ['targetWeeks'],
  };
};

export const normalizeTaskPeriodFromDates = (task) => {
  const derived = deriveTaskWeeksFromDateRange(task?.startDate, task?.dueDate);
  return { ...task, targetWeeks: derived.targetWeeks };
};
