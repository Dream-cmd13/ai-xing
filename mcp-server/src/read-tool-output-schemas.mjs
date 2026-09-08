import * as z from 'zod/v4';

const recordSchema = z.record(z.string(), z.unknown());
const taskListOutput = { tasks: z.array(recordSchema) };
const scopeSchema = z.enum(['auto', 'exact', 'subtree']);
const pageInfoSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
});

export const readToolOutputSchemas = Object.freeze({
  getOrganizationInfo: {
    strategy: recordSchema.nullable(),
    departments: z.array(recordSchema),
    businesses: z.array(recordSchema),
  },
  getDepartmentPeople: {
    departmentId: z.string(),
    departmentName: z.string().nullable(),
    scope: z.enum(['exact', 'subtree']),
    people: z.array(recordSchema),
    hasMore: z.boolean(),
  },
  getDepartmentWeeklyPad: {
    departmentId: z.string(),
    departmentName: z.string().optional(),
    scope: scopeSchema.optional(),
    weekId: z.string(),
    limit: z.number(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    truncated: z.boolean(),
    ...taskListOutput,
  },
  searchPadTasks: {
    ...taskListOutput,
    offset: z.number(),
    limit: z.number(),
    total: z.number().nullable(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    truncated: z.boolean(),
    departmentId: z.string().optional(),
    departmentName: z.string().nullable().optional(),
    scope: scopeSchema.optional(),
    user: z.object({
      name: z.string(),
      role: z.string(),
      departmentId: z.string().nullable(),
      departmentName: z.string().nullable(),
    }).optional(),
  },
  getWeeklyReviewGaps: {
    weekId: z.string(),
    groups: z.array(recordSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  },
  getCompanyOkrs: {
    year: z.number().nullable(),
    okrCount: z.number(),
    okrs: z.array(recordSchema),
  },
  getDepartmentOkrs: {
    year: z.number().nullable(),
    period: z.string().nullable(),
    departmentCount: z.number(),
    hasMore: z.boolean(),
    limit: z.number().int().min(1).max(50),
    departments: z.array(recordSchema),
  },
  getPersonalWorkbench: {
    userId: z.string(),
    limit: z.number(),
    currentWeekId: z.string().optional(),
    nextWeekId: z.string().optional(),
    todayTasks: z.array(recordSchema),
    thisWeekTasks: z.array(recordSchema),
    nextWeekTasks: z.array(recordSchema),
    pageInfo: z.object({
      today: pageInfoSchema,
      thisWeek: pageInfoSchema,
      nextWeek: pageInfoSchema,
    }),
    ...taskListOutput,
  },
  getProcessSipoc: {
    limit: z.number(),
    processes: z.array(recordSchema),
  },
});
