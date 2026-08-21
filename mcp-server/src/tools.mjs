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
  setIfPresent(summary, 'departmentId', task?.departmentId);
  setIfPresent(summary, 'alignedKrId', task?.alignedKrId);
  setIfPresent(summary, 'targetWeeks', task?.targetWeeks, boundedArray);
  setIfPresent(summary, 'startDate', task?.startDate);
  setIfPresent(summary, 'dueDate', task?.dueDate);
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
  return {
    strategy,
    departmentCount: departments.length,
    departments: departments.slice(0, 100).map((department) => ({
      ...(department?.id !== undefined ? { id: department.id } : {}),
      ...(department?.name !== undefined ? { name: clip(department.name) } : {}),
    })),
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
    'get_department_weekly_pad',
    {
      title: '读取部门周 PAD',
      description: '读取指定部门和周次中当前账号有权限查看的 PAD 任务。',
      inputSchema: {
        departmentId: z.string().trim().min(1).max(128).describe('部门 ID'),
        weekId: z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/).describe('ISO 周次，例如 2026-W34'),
        limit: limit50,
      },
      outputSchema: {
        departmentId: z.string(),
        weekId: z.string(),
        limit: z.number(),
        ...taskListOutput,
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler(
      '部门周 PAD 读取完成。',
      (args) => repository.getDepartmentWeeklyPad(args),
      (data) => compactTaskList(data, {
        departmentId: data?.departmentId,
        weekId: data?.weekId,
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
        status: z.string().trim().min(1).max(64).optional(),
        limit: limit50,
        offset: z.number().int().min(0).max(1000).default(0),
      },
      outputSchema: {
        ...taskListOutput,
        offset: z.number(),
        limit: z.number(),
        total: z.number().nullable(),
        hasMore: z.boolean(),
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('PAD 任务搜索完成。', (args) => repository.searchPadTasks(args), (data) => compactTaskList(data, {
      offset: data?.offset,
      limit: data?.limit,
      total: data?.total ?? null,
      hasMore: data?.hasMore ?? false,
    })),
  );

  server.registerTool(
    'get_personal_workbench',
    {
      title: '读取个人工作台',
      description: '读取当前登录用户自己的工作台；不能指定其他用户。',
      inputSchema: { limit: limit50 },
      outputSchema: {
        userId: z.string(),
        limit: z.number(),
        ...taskListOutput,
      },
      annotations: readOnlyAnnotations,
    },
    safeHandler('个人工作台读取完成。', (args) => repository.getPersonalWorkbench({ limit: args.limit }), (data) => compactTaskList(data, {
      userId: data?.userId,
      limit: data?.limit,
    })),
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
