import * as z from 'zod/v4';

import { toPublicError } from './errors.mjs';

const readOnlyAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const limit50 = z.number().int().min(1).max(50).default(20);
const limit20 = z.number().int().min(1).max(20).default(20);
const cursorSchema = z.string().trim().min(1).max(512).optional();
const recordSchema = z.record(z.string(), z.unknown());
const taskListOutput = {
  tasks: z.array(recordSchema),
};

const TEXT_MAX_BYTES = 48 * 1024;
const MAX_TEXT_STRING_LENGTH = 320;
const MAX_SIPOC_STRING_LENGTH = 160;
const MAX_SIPOC_ARRAY_LENGTH = 12;
const MAX_PROCESS_SUMMARY_COUNT = 10;
const MAX_NODE_SUMMARY_COUNT = 20;
const MAX_LINK_SUMMARY_COUNT = 30;

function clip(value, maxLength = MAX_TEXT_STRING_LENGTH) {
  if (typeof value !== 'string') return value;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function boundedArray(value, maxLength = MAX_SIPOC_ARRAY_LENGTH) {
  return Array.isArray(value) ? value.slice(0, maxLength).map((item) => clip(item, MAX_SIPOC_STRING_LENGTH)) : [];
}

function boundedPeople(value) {
  return Array.isArray(value) ? value.slice(0, MAX_SIPOC_ARRAY_LENGTH).map((person) => ({
    id: person?.id ?? null,
    name: person?.name ? clip(person.name) : (person?.id ? '人员不存在' : null),
    departmentId: person?.departmentId ?? null,
    departmentName: person?.departmentName === null ? null : clip(person?.departmentName),
  })) : [];
}

function setIfPresent(target, key, value, transform = (item) => item) {
  if (value !== undefined && value !== null && value !== '') target[key] = transform(value);
}

function compactTask(task) {
  const summary = {};
  setIfPresent(summary, 'id', task?.id);
  setIfPresent(summary, 'title', task?.title, clip);
  setIfPresent(summary, 'status', task?.status, clip);
  setIfPresent(summary, 'priority', task?.priority, clip);
  setIfPresent(summary, 'ownerId', task?.ownerId);
  setIfPresent(summary, 'ownerName', task?.ownerName ?? (task?.ownerId ? '人员不存在' : null), clip);
  setIfPresent(summary, 'ownerDepartmentName', task?.ownerDepartmentName, clip);
  setIfPresent(summary, 'departmentId', task?.departmentId);
  setIfPresent(summary, 'departmentName', task?.departmentName, clip);
  setIfPresent(summary, 'alignedKrId', task?.alignedKrId);
  setIfPresent(summary, 'targetWeeks', task?.targetWeeks, boundedArray);
  setIfPresent(summary, 'startDate', task?.startDate);
  setIfPresent(summary, 'dueDate', task?.dueDate);
  setIfPresent(summary, 'participantIds', task?.participantIds, boundedArray);
  setIfPresent(summary, 'participants', task?.participants, boundedPeople);
  setIfPresent(summary, 'approverIds', task?.approverIds, boundedArray);
  setIfPresent(summary, 'approvers', task?.approvers, boundedPeople);
  setIfPresent(summary, 'relationMatches', task?.relationMatches, boundedArray);
  return summary;
}

function compactOrganization(data) {
  const strategy = data?.strategy
    ? {
      ...(data.strategy.mission ? { mission: clip(data.strategy.mission) } : {}),
      ...(data.strategy.vision ? { vision: clip(data.strategy.vision) } : {}),
    }
    : null;
  const departments = Array.isArray(data?.departments) ? data.departments : [];
  const businesses = Array.isArray(data?.businesses) ? data.businesses : [];
  const compactDepartment = (department, depth = 0, seen = new Set()) => {
    if (!department || typeof department !== 'object' || depth > 100 || seen.has(department.id)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(department.id);
    const children = Array.isArray(department.subDepartments) ? department.subDepartments : [];
    return {
      ...(department?.id !== undefined ? { id: department.id } : {}),
      ...(department?.name !== undefined ? { name: clip(department.name) } : {}),
      ...(department?.managerName ? { managerName: clip(department.managerName) } : {}),
      ...(children.length > 0 ? {
        subDepartments: children.map((child) => compactDepartment(child, depth + 1, nextSeen)).filter(Boolean),
      } : {}),
    };
  };
  return {
    strategy,
    departmentCount: departments.length,
    departments: departments.slice(0, 100).map((department) => compactDepartment(department)).filter(Boolean),
    businessCount: businesses.length,
    businesses: businesses.slice(0, 100).map((business) => ({
      ...(business?.id !== undefined ? { id: business.id } : {}),
      ...(business?.name !== undefined ? { name: clip(business.name) } : {}),
    })),
  };
}

function compactTaskList(data, extra = {}) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  return {
    ...extra,
    taskCount: tasks.length,
    tasks: tasks.map(compactTask),
  };
}

function compactDepartmentPeople(data) {
  const people = Array.isArray(data?.people) ? data.people : [];
  return {
    departmentId: data?.departmentId,
    departmentName: data?.departmentName,
    scope: data?.scope,
    peopleCount: people.length,
    hasMore: data?.hasMore === true,
    people: people.slice(0, 50).map((person) => ({
      id: person?.id ?? null,
      name: person?.name ? clip(person.name) : null,
      username: person?.username ? clip(person.username) : null,
      role: person?.role ?? null,
      departmentId: person?.departmentId ?? null,
      departmentName: person?.departmentName ? clip(person.departmentName) : null,
    })),
  };
}

function compactWorkbench(data) {
  const compactGroup = (value) => (Array.isArray(value) ? value.map(compactTask) : []);
  return {
    userId: data?.userId,
    limit: data?.limit,
    currentWeekId: data?.currentWeekId,
    nextWeekId: data?.nextWeekId,
    todayTaskCount: Array.isArray(data?.todayTasks) ? data.todayTasks.length : 0,
    thisWeekTaskCount: Array.isArray(data?.thisWeekTasks) ? data.thisWeekTasks.length : 0,
    nextWeekTaskCount: Array.isArray(data?.nextWeekTasks) ? data.nextWeekTasks.length : 0,
    todayTasks: compactGroup(data?.todayTasks),
    thisWeekTasks: compactGroup(data?.thisWeekTasks),
    nextWeekTasks: compactGroup(data?.nextWeekTasks),
    taskCount: Array.isArray(data?.tasks) ? data.tasks.length : 0,
    tasks: compactGroup(data?.tasks),
    pageInfo: {
      today: data?.pageInfo?.today ?? { hasMore: false, nextCursor: null, truncated: false },
      thisWeek: data?.pageInfo?.thisWeek ?? { hasMore: false, nextCursor: null, truncated: false },
      nextWeek: data?.pageInfo?.nextWeek ?? { hasMore: false, nextCursor: null, truncated: false },
    },
  };
}

function compactReviewGaps(data) {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  return {
    weekId: data?.weekId,
    total: data?.total ?? 0,
    limit: data?.limit,
    offset: data?.offset,
    hasMore: data?.hasMore ?? false,
    groups: groups.map((group) => ({
      user: {
        ...(group?.user?.name ? { name: clip(group.user.name) } : {}),
        ...(group?.user?.departmentName ? { departmentName: clip(group.user.departmentName) } : {}),
      },
      tasks: (Array.isArray(group?.tasks) ? group.tasks : []).map((task) => ({
        ...(task?.id !== undefined ? { id: task.id } : {}),
        ...(task?.title !== undefined ? { title: clip(task.title) } : {}),
        ...(task?.departmentName ? { departmentName: clip(task.departmentName) } : {}),
        ...(task?.reviewState !== undefined ? { reviewState: task.reviewState } : {}),
        ...(task?.reviewReason ? { reviewReason: task.reviewReason } : {}),
        ...(task?.taskReview !== undefined ? { taskReview: clip(task.taskReview) } : {}),
        ...(task?.cardEvaluation !== undefined ? { cardEvaluation: clip(task.cardEvaluation) } : {}),
        ...(task?.inconsistent !== undefined ? { inconsistent: task.inconsistent } : {}),
      })),
    })),
  };
}

function compactOkrTask(task) {
  const summary = {};
  setIfPresent(summary, 'id', task?.id);
  setIfPresent(summary, 'title', task?.title, clip);
  setIfPresent(summary, 'status', task?.status, clip);
  setIfPresent(summary, 'ownerName', task?.ownerName, clip);
  setIfPresent(summary, 'departmentName', task?.departmentName, clip);
  setIfPresent(summary, 'targetWeeks', task?.targetWeeks, boundedArray);
  setIfPresent(summary, 'startDate', task?.startDate);
  setIfPresent(summary, 'dueDate', task?.dueDate);
  return summary;
}

function compactOkr(okr) {
  const dataQuality = okr?.dataQuality && typeof okr.dataQuality === 'object'
    ? {
      valid: okr.dataQuality.valid !== false,
      issues: Array.isArray(okr.dataQuality.issues)
        ? okr.dataQuality.issues.slice(0, 20)
        : [],
    }
    : undefined;
  return {
    ...(okr?.id !== undefined ? { id: okr.id } : {}),
    ...(okr?.objective !== undefined ? { objective: clip(okr.objective) } : {}),
    keyResults: (Array.isArray(okr?.keyResults) ? okr.keyResults : []).slice(0, MAX_SIPOC_ARRAY_LENGTH).map((kr) => clip(kr)),
    ...(Number.isFinite(okr?.krCount) ? { krCount: okr.krCount } : {}),
    ...(okr?.truncated ? { truncated: true } : {}),
    ...(dataQuality ? { dataQuality } : {}),
    krTasks: (Array.isArray(okr?.krTasks) ? okr.krTasks : []).map((entry) => ({
      krIndex: entry?.krIndex,
      krText: clip(entry?.krText),
      taskCount: entry?.taskCount ?? 0,
      tasks: (Array.isArray(entry?.tasks) ? entry.tasks : []).map(compactOkrTask),
      ...(entry?.tasksTruncated ? { tasksTruncated: true } : {}),
    })),
  };
}

function compactCompanyOkrs(data) {
  const okrs = Array.isArray(data?.okrs) ? data.okrs : [];
  return {
    year: data?.year,
    okrCount: data?.okrCount ?? okrs.length,
    okrs: okrs.map(compactOkr),
  };
}

function compactDepartmentOkrs(data) {
  const departments = Array.isArray(data?.departments) ? data.departments : [];
  return {
    year: data?.year,
    period: data?.period ?? null,
    departmentCount: data?.departmentCount ?? departments.length,
    hasMore: data?.hasMore === true,
    departments: departments.map((department) => ({
      ...(department?.id !== undefined ? { id: department.id } : {}),
      ...(department?.name !== undefined ? { name: clip(department.name) } : {}),
      ...(department?.managerName ? { managerName: clip(department.managerName) } : {}),
      ...(department?.parentName ? { parentName: clip(department.parentName) } : {}),
      periods: Object.fromEntries(Object.entries(department?.periods ?? {}).map(([period, okrs]) => (
        [period, (Array.isArray(okrs) ? okrs : []).map(compactOkr)]
      ))),
    })),
  };
}

function compactSipoc(sipoc) {
  if (!sipoc || typeof sipoc !== 'object') return undefined;
  const result = {};
  setIfPresent(result, 'source', sipoc.source, boundedArray);
  setIfPresent(result, 'target', sipoc.target, boundedArray);
  setIfPresent(result, 'inputs', sipoc.inputs, boundedArray);
  setIfPresent(result, 'standard', sipoc.standard, (value) => clip(value, MAX_SIPOC_STRING_LENGTH));
  setIfPresent(result, 'outputs', sipoc.outputs, boundedArray);
  setIfPresent(result, 'customers', sipoc.customers, boundedArray);
  setIfPresent(result, 'ownerRole', sipoc.ownerRole, (value) => clip(value, MAX_SIPOC_STRING_LENGTH));
  setIfPresent(result, 'assistantRoles', sipoc.assistantRoles, boundedArray);
  return result;
}

function compactProcessNode(node) {
  const result = {};
  setIfPresent(result, 'id', node?.id);
  setIfPresent(result, 'label', node?.label, (value) => clip(value, MAX_SIPOC_STRING_LENGTH));
  setIfPresent(result, 'description', node?.description, (value) => clip(value, MAX_SIPOC_STRING_LENGTH));
  setIfPresent(result, 'type', node?.type);
  setIfPresent(result, 'sipoc', compactSipoc(node?.sipoc));
  setIfPresent(result, 'decisionDescription', node?.decisionDescription, (value) => clip(value, MAX_SIPOC_STRING_LENGTH));
  return result;
}

function compactProcess(process) {
  const nodes = Array.isArray(process?.nodes) ? process.nodes : [];
  const links = Array.isArray(process?.links) ? process.links : [];
  return {
    ...(process?.id !== undefined ? { id: process.id } : {}),
    ...(process?.departmentId !== undefined ? { departmentId: process.departmentId } : {}),
    ...(process?.name !== undefined ? { name: clip(process.name) } : {}),
    ...(process?.category !== undefined ? { category: process.category } : {}),
    ...(process?.level !== undefined ? { level: process.level } : {}),
    ...(process?.version !== undefined ? { version: process.version } : {}),
    ...(process?.isActive !== undefined ? { isActive: process.isActive } : {}),
    ...(process?.owner !== undefined ? { owner: clip(process.owner) } : {}),
    ...(process?.coOwner !== undefined ? { coOwner: clip(process.coOwner) } : {}),
    ...(process?.objective !== undefined ? { objective: clip(process.objective) } : {}),
    nodeCount: nodes.length,
    linkCount: links.length,
    nodes: nodes.slice(0, MAX_NODE_SUMMARY_COUNT).map(compactProcessNode),
    links: links.slice(0, MAX_LINK_SUMMARY_COUNT).map((link) => ({
      ...(link?.id !== undefined ? { id: link.id } : {}),
      ...(link?.from !== undefined ? { from: link.from } : {}),
      ...(link?.to !== undefined ? { to: link.to } : {}),
      ...(link?.label !== undefined ? { label: clip(link.label, MAX_SIPOC_STRING_LENGTH) } : {}),
    })),
    ...(nodes.length > MAX_NODE_SUMMARY_COUNT ? { nodesTruncated: true } : {}),
    ...(links.length > MAX_LINK_SUMMARY_COUNT ? { linksTruncated: true } : {}),
  };
}

function compactProcessList(data) {
  const processes = Array.isArray(data?.processes) ? data.processes : [];
  return {
    limit: data?.limit,
    processCount: processes.length,
    processes: processes.slice(0, MAX_PROCESS_SUMMARY_COUNT).map(compactProcess),
    ...(processes.length > MAX_PROCESS_SUMMARY_COUNT ? { processesTruncated: true } : {}),
  };
}

function serializeSummary(summary) {
  const serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, 'utf8') <= TEXT_MAX_BYTES) return serialized;
  return JSON.stringify({
    summaryTruncated: true,
    message: '文本摘要超过大小限制，请读取 structuredContent 获取完整结果。',
  });
}

function success(label, data, summarize) {
  return {
    content: [{ type: 'text', text: `${label}\n${serializeSummary(summarize(data))}` }],
    structuredContent: data,
    isError: false,
  };
}

function safeHandler(label, operation, summarize) {
  return async (args) => {
    try {
      return success(label, await operation(args ?? {}), summarize);
    } catch (error) {
      const publicError = toPublicError(error);
      return {
        content: [{ type: 'text', text: JSON.stringify(publicError) }],
        isError: true,
      };
    }
  };
}

export function registerReadTools(server, repository) {
  server.registerTool(
    'get_organization_info',
    {
      title: '读取组织信息',
      description: '读取当前账号有权限查看的组织、战略和业务定义。',
      inputSchema: {},
      outputSchema: {
        strategy: recordSchema.nullable(),
        departments: z.array(recordSchema),
        businesses: z.array(recordSchema),
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('组织信息读取完成。', () => repository.getOrganizationInfo(), compactOrganization),
  );

  server.registerTool(
    'get_department_people',
    {
      title: '读取部门人员',
      description: '按部门名称或 ID 读取人员。父部门默认包含全部层级子部门，叶子子部门默认精确查询；每批最多 50 人。',
      inputSchema: {
        departmentId: z.string().trim().min(1).max(128).optional(),
        departmentName: z.string().trim().min(1).max(128).optional(),
        scope: z.enum(['auto', 'exact', 'subtree']).default('auto'),
        limit: limit50,
        cursorName: z.string().max(128).optional(),
        cursorId: z.string().max(128).optional(),
      },
      outputSchema: {
        departmentId: z.string(),
        departmentName: z.string().nullable(),
        scope: z.enum(['exact', 'subtree']),
        people: z.array(recordSchema),
        hasMore: z.boolean(),
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('部门人员读取完成。', (args) => repository.getDepartmentPeople(args), compactDepartmentPeople),
  );

  server.registerTool(
    'get_department_weekly_pad',
    {
      title: '读取部门周 PAD',
      description: '读取指定部门和周次中当前账号有权限查看的 PAD 任务。父部门默认读取全部层级子部门，叶子子部门默认精确读取；可用 scope 覆盖。',
      inputSchema: {
        departmentId: z.string().trim().min(1).max(128).optional().describe('部门 ID，与 departmentName 二选一'),
        departmentName: z.string().trim().min(1).max(128).optional().describe('部门名称，可直接查询子部门'),
        scope: z.enum(['auto', 'exact', 'subtree']).default('auto'),
        weekId: z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/).describe('ISO 周次，例如 2026-W34'),
        limit: limit50,
        cursor: cursorSchema,
      },
      outputSchema: {
        departmentId: z.string(),
        departmentName: z.string().optional(),
        scope: z.enum(['auto', 'exact', 'subtree']).optional(),
        weekId: z.string(),
        limit: z.number(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
        truncated: z.boolean(),
        ...taskListOutput,
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler(
      '部门周 PAD 读取完成。',
      (args) => repository.getDepartmentWeeklyPad(args),
      (data) => compactTaskList(data, {
        departmentId: data?.departmentId,
        departmentName: data?.departmentName,
        scope: data?.scope,
        weekId: data?.weekId,
        hasMore: data?.hasMore ?? false,
        nextCursor: data?.nextCursor ?? null,
        truncated: data?.truncated ?? false,
      }),
    ),
  );

  server.registerTool(
    'search_pad_tasks',
    {
      title: '搜索 PAD 任务',
      description: '按标题、部门或状态搜索当前账号有权限查看的 PAD 任务。',
      inputSchema: {
        query: z.string().trim().max(100).optional(),
        departmentId: z.string().trim().min(1).max(128).optional(),
        userName: z.string().trim().min(1).max(128).optional(),
        departmentName: z.string().trim().min(1).max(128).optional(),
        scope: z.enum(['auto', 'exact', 'subtree']).default('auto'),
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
        relation: z.enum(['owner', 'participant', 'approver', 'any']).default('owner'),
        weekId: z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/).optional(),
        status: z.string().trim().min(1).max(64).optional(),
        limit: limit50,
        offset: z.number().int().min(0).max(1000).default(0),
        cursor: cursorSchema,
      },
      outputSchema: {
        ...taskListOutput,
        offset: z.number(),
        limit: z.number(),
        total: z.number().nullable(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
        truncated: z.boolean(),
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('PAD 任务搜索完成。', (args) => repository.searchPadTasks(args), (data) => compactTaskList(data, {
      offset: data?.offset,
      limit: data?.limit,
      total: data?.total ?? null,
      hasMore: data?.hasMore ?? false,
      nextCursor: data?.nextCursor ?? null,
      truncated: data?.truncated ?? false,
    })),
  );

  server.registerTool(
    'get_weekly_review_gaps',
    {
      title: '读取周复盘缺口',
      description: '按复盘中心任务卡片字段读取当前账号可见的未复盘任务。',
      inputSchema: {
        weekId: z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/),
        departmentId: z.string().trim().min(1).max(128).optional(),
        departmentName: z.string().trim().min(1).max(128).optional(),
        scope: z.enum(['auto', 'exact', 'subtree']).default('auto'),
        limit: limit50,
        offset: z.number().int().min(0).max(1000).default(0),
      },
      outputSchema: {
        weekId: z.string(),
        groups: z.array(recordSchema),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
        hasMore: z.boolean(),
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('周复盘缺口读取完成。', (args) => repository.getWeeklyReviewGaps(args), compactReviewGaps),
  );

  server.registerTool(
    'get_company_okrs',
    {
      title: '读取公司年度 OKR',
      description: '读取公司年度 OKR（目标与关键结果），可附带每个 KR 下绑定的任务。',
      inputSchema: {
        year: z.number().int().min(2000).max(3000).optional().describe('目标年份，默认当前年'),
        includeTasks: z.boolean().optional().describe('是否附带每个 KR 绑定的任务，默认 true'),
      },
      outputSchema: {
        year: z.number().nullable(),
        okrCount: z.number(),
        okrs: z.array(recordSchema),
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('公司 OKR 读取完成。', (args) => repository.getCompanyOkrs(args), compactCompanyOkrs),
  );

  server.registerTool(
    'get_department_okrs',
    {
      title: '读取部门年度/季度 OKR',
      description: '读取当前账号可见部门的年度（Annual）或季度（Q1-Q4）OKR，可附带每个 KR 下绑定的任务。',
      inputSchema: {
        departmentId: z.string().trim().min(1).max(128).optional().describe('部门 ID；不传则返回可见的全部部门'),
        departmentName: z.string().trim().min(1).max(128).optional().describe('部门名称，与 departmentId 二选一'),
        scope: z.enum(['auto', 'exact', 'subtree']).default('auto'),
        year: z.number().int().min(2000).max(3000).optional().describe('目标年份，默认当前年'),
        period: z.enum(['Annual', 'Q1', 'Q2', 'Q3', 'Q4']).optional().describe('周期；不传则返回该年全部周期'),
        includeTasks: z.boolean().optional().describe('是否附带每个 KR 绑定的任务，默认 true'),
        limit: limit50,
      },
      outputSchema: {
        year: z.number().nullable(),
        period: z.string().nullable(),
        departmentCount: z.number(),
        hasMore: z.boolean(),
        departments: z.array(recordSchema),
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler(
      '部门 OKR 读取完成。',
      (args) => repository.getDepartmentOkrs(args),
      compactDepartmentOkrs,
    ),
  );

  server.registerTool(
    'get_personal_workbench',
    {
      title: '读取个人工作台',
      description: '读取当前登录用户自己的工作台，按今日、本周和下周分组；不能指定其他用户。',
      inputSchema: {
        limit: limit50,
        todayCursor: cursorSchema,
        thisWeekCursor: cursorSchema,
        nextWeekCursor: cursorSchema,
      },
      outputSchema: {
        userId: z.string(),
        limit: z.number(),
        currentWeekId: z.string().optional(),
        nextWeekId: z.string().optional(),
        todayTasks: z.array(recordSchema),
        thisWeekTasks: z.array(recordSchema),
        nextWeekTasks: z.array(recordSchema),
        pageInfo: z.object({
          today: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
          thisWeek: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
          nextWeek: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
        }),
        ...taskListOutput,
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('个人工作台读取完成。', (args) => {
      const workbenchArgs = { limit: args.limit };
      if (args.todayCursor !== undefined) workbenchArgs.todayCursor = args.todayCursor;
      if (args.thisWeekCursor !== undefined) workbenchArgs.thisWeekCursor = args.thisWeekCursor;
      if (args.nextWeekCursor !== undefined) workbenchArgs.nextWeekCursor = args.nextWeekCursor;
      return repository.getPersonalWorkbench(workbenchArgs);
    }, compactWorkbench),
  );

  server.registerTool(
    'get_process_sipoc',
    {
      title: '读取流程 SIPOC',
      description: '读取当前账号可见的流程、SIPOC 节点和连线定义。',
      inputSchema: {
        processId: z.string().trim().min(1).max(128).optional(),
        departmentId: z.string().trim().min(1).max(128).optional(),
        limit: limit20,
      },
      outputSchema: {
        limit: z.number(),
        processes: z.array(recordSchema),
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('流程 SIPOC 读取完成。', (args) => repository.getProcessSipoc(args), compactProcessList),
  );
}
