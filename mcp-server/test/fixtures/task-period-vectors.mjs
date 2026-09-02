export const taskPeriodVectors = Object.freeze([
  Object.freeze({
    name: 'single ISO week',
    startDate: Date.parse('2026-06-29T04:00:00.000Z'),
    dueDate: Date.parse('2026-07-05T04:00:00.000Z'),
    startDay: '2026-06-29',
    dueDay: '2026-07-05',
    targetWeeks: Object.freeze(['2026-W27']),
  }),
  Object.freeze({
    name: 'two ISO weeks',
    startDate: Date.parse('2026-06-29T04:00:00.000Z'),
    dueDate: Date.parse('2026-07-12T04:00:00.000Z'),
    startDay: '2026-06-29',
    dueDay: '2026-07-12',
    targetWeeks: Object.freeze(['2026-W27', '2026-W28']),
  }),
  Object.freeze({
    name: 'Shanghai midnight boundary',
    startDate: Date.parse('2026-06-28T16:30:00.000Z'),
    dueDate: Date.parse('2026-06-28T16:30:00.000Z'),
    startDay: '2026-06-29',
    dueDay: '2026-06-29',
    targetWeeks: Object.freeze(['2026-W27']),
  }),
  Object.freeze({
    name: 'valid ISO week 53 and year boundary',
    startDate: Date.parse('2020-12-28T04:00:00.000Z'),
    dueDate: Date.parse('2021-01-10T04:00:00.000Z'),
    startDay: '2020-12-28',
    dueDay: '2021-01-10',
    targetWeeks: Object.freeze(['2020-W53', '2021-W01']),
  }),
]);
