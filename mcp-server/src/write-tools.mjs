import * as z from 'zod/v4';

import { computeArgsDigest } from './confirmation-store.mjs';
import { AppError, toPublicError } from './errors.mjs';
import { parseReviewSlot } from './review-slot.mjs';
import { normalizeTaskPeriodInput } from './task-period-defaults.mjs';

const writeAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const requestIdSchema = z.string().trim().min(8).max(128);
const taskIdSchema = z.string().trim().min(1).max(128);
const recordSchema = z.record(z.string(), z.unknown());
const weekSchema = z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/);
const taskPayloadShape = {
  title: z.string().trim().min(1).optional(),
  departmentId: z.string().trim().min(1).max(128).optional(),
  departmentName: z.string().trim().min(1).max(128).optional(),
  ownerId: z.string().trim().min(1).max(128).optional(),
  ownerName: z.object({ name: z.string().trim().min(1).max(128), departmentName: z.string().trim().min(1).max(128).optional() }).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  alignedKrId: z.string().trim().max(128).optional(),
  targetWeeks: z.array(weekSchema).max(53).optional(),
  startDate: z.number().int().optional(),
  dueDate: z.number().int().optional(),
  tags: z.array(z.string().max(32)).max(12).optional(),
  participantIds: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
  participantNames: z.array(z.object({ name: z.string().trim().min(1).max(128), departmentName: z.string().trim().min(1).max(128).optional() })).max(50).optional(),
  approverIds: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  approverNames: z.array(z.object({ name: z.string().trim().min(1).max(128), departmentName: z.string().trim().min(1).max(128).optional() })).max(20).optional(),
  plan: z.string().max(2000).optional(),
  action: z.string().max(2000).optional(),
  deliverable: z.string().optional(),
};
const taskReviewSchema = z.string().describe(
  '具体任务的实际成果、实际结果、完成情况或任务复盘。只写入该任务，不得用于部门周复盘总结。',
);
const taskReviewScoreSchema = z.number().int().min(0).max(100).describe(
  '具体任务的复盘评分，范围为 0 到 100。',
);
const taskChangesSchema = z.object({
  title: z.string().trim().min(1).optional(),
  status: z.enum(['draft', 'in-progress', 'paused', 'approved', 'completed', 'terminated']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  alignedKrId: z.string().max(128).optional(),
  aligned_kr_id: z.string().max(128).optional(),
  targetWeeks: z.array(weekSchema).max(53).optional(),
  target_weeks: z.array(weekSchema).max(53).optional(),
  startDate: z.number().int().nonnegative().nullable().optional(),
  start_date: z.number().int().nonnegative().nullable().optional(),
  dueDate: z.number().int().nonnegative().nullable().optional(),
  due_date: z.number().int().nonnegative().nullable().optional(),
  tags: z.array(z.string().max(32)).max(12).optional(),
  participantIds: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
  participant_ids: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
  participantNames: z.array(z.object({ name: z.string().trim().min(1).max(128), departmentName: z.string().trim().min(1).max(128).optional() })).max(50).optional(),
  approverIds: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  approver_ids: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  approverNames: z.array(z.object({ name: z.string().trim().min(1).max(128), departmentName: z.string().trim().min(1).max(128).optional() })).max(20).optional(),
  plan: z.string().max(2000).optional(),
  action: z.string().max(2000).optional(),
  deliverable: z.string().optional(),
  taskReview: taskReviewSchema.optional(),
  task_review: taskReviewSchema.describe('taskReview 的兼容字段；含义相同。').optional(),
  taskReviewScore: taskReviewScoreSchema.optional(),
  task_review_score: taskReviewScoreSchema.describe('taskReviewScore 的兼容字段；含义相同。').optional(),
  ownerId: z.string().trim().min(1).max(128).optional(),
  owner_id: z.string().trim().min(1).max(128).optional(),
  ownerName: z.object({ name: z.string().trim().min(1).max(128), departmentName: z.string().trim().min(1).max(128).optional() }).optional(),
}).strict().describe('PAD 任务字段变更；具体任务的成果或复盘必须使用 taskReview。');
const departmentReviewScopeSchema = z.literal('department_period_summary').describe(
  '仅当用户明确要求填写部门周复盘总结或其他部门周期复盘总结时使用；具体任务的实际成果或结果不得使用此 scope。',
);
const taskPayloadKeys = new Set(Object.keys(taskPayloadShape));
const updateKeys = new Set([
  'title', 'status', 'priority', 'alignedKrId', 'aligned_kr_id', 'targetWeeks', 'target_weeks',
  'startDate', 'start_date', 'dueDate', 'due_date', 'tags', 'participantIds', 'participant_ids',
  'approverIds', 'approver_ids', 'plan', 'action', 'deliverable', 'taskReview', 'task_review',
  'taskReviewScore', 'task_review_score', 'ownerId', 'owner_id', 'ownerName', 'participantNames', 'approverNames',
]);

function response(label, data) {
  return {
    content: [{ type: 'text', text: `${label}\n${JSON.stringify(data)}` }],
    structuredContent: data,
    isError: false,
  };
}

function errorResponse(error) {
  const publicError = toPublicError(error);
  return {
    content: [{ type: 'text', text: JSON.stringify(publicError) }],
    isError: true,
  };
}

function rejectInvalid() {
  return new AppError('INVALID_ARGUMENT');
}

function hasCreatePayloadInput(args = {}) {
  if (Object.prototype.hasOwnProperty.call(args, 'payload')) return true;
  return [...taskPayloadKeys].some((key) => Object.prototype.hasOwnProperty.call(args, key));
}

function createPayload(args = {}, context = {}, { defaultPeriod = false, nowMs = Date.now() } = {}) {
  if (args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)) {
    args = args.payload;
  } else {
    const { confirmationToken: _token, requestId: _requestId, ...payload } = args;
    args = payload;
  }
  let payload = structuredClone(args);
  if (payload.status !== undefined && payload.status !== 'draft') throw rejectInvalid();
  payload.status = 'draft';
  if (payload.ownerId === undefined && payload.ownerName === undefined && context.userId) payload.ownerId = context.userId;
  if (payload.departmentId === undefined && payload.departmentName === undefined && context.departmentId) {
    payload.departmentId = context.departmentId;
  }
  payload = normalizeTaskPeriodInput(payload, { defaultPeriod, nowMs });
  validateTaskPayload(payload);
  return payload;
}

function validateTaskPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw rejectInvalid();
  for (const key of Object.keys(payload)) if (!taskPayloadKeys.has(key) && key !== 'status') throw rejectInvalid();
  if (typeof payload.title !== 'string' || payload.title.trim().length === 0) throw rejectInvalid();
  if (payload.status !== 'draft') throw rejectInvalid();
  if (payload.priority !== undefined && !['high', 'medium', 'low'].includes(payload.priority)) throw rejectInvalid();
  if (payload.alignedKrId !== undefined && !parseReviewSlot(payload.alignedKrId, payload.id).ok) throw rejectInvalid();
  if (payload.targetWeeks !== undefined && (!Array.isArray(payload.targetWeeks) || payload.targetWeeks.length > 53
    || payload.targetWeeks.some((value) => typeof value !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(value)))) throw rejectInvalid();
  if (payload.tags !== undefined && (!Array.isArray(payload.tags) || payload.tags.length > 12
    || payload.tags.some((value) => typeof value !== 'string' || value.length > 32))) throw rejectInvalid();
  for (const key of ['participantIds', 'approverIds']) {
    if (payload[key] !== undefined && (!Array.isArray(payload[key]) || payload[key].some((value) => typeof value !== 'string' || !value.trim()))) throw rejectInvalid();
  }
  if (payload.ownerName !== undefined && !isUserReference(payload.ownerName)) throw rejectInvalid();
  for (const key of ['participantNames', 'approverNames']) {
    const maximum = key === 'participantNames' ? 50 : 20;
    if (payload[key] !== undefined && (!Array.isArray(payload[key]) || payload[key].length > maximum || payload[key].some((value) => !isUserReference(value)))) throw rejectInvalid();
  }
  for (const key of ['plan', 'action']) {
    if (payload[key] !== undefined && (typeof payload[key] !== 'string' || payload[key].length > 2000)) throw rejectInvalid();
  }
  if (payload.deliverable !== undefined && typeof payload.deliverable !== 'string') throw rejectInvalid();
  if (payload.startDate !== undefined && (!Number.isSafeInteger(payload.startDate) || payload.startDate < 0)) throw rejectInvalid();
  if (payload.dueDate !== undefined && (!Number.isSafeInteger(payload.dueDate) || payload.dueDate < 0)) throw rejectInvalid();
  if (payload.startDate !== undefined && payload.dueDate !== undefined && payload.dueDate < payload.startDate) throw rejectInvalid();
}

function isUserReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 128) return false;
  return value.departmentName === undefined
    || (typeof value.departmentName === 'string' && value.departmentName.trim().length > 0 && value.departmentName.trim().length <= 128);
}

const taskReviewInputKeys = new Set([
  'taskId', 'task_id', 'taskReview', 'task_review', 'taskReviewScore', 'task_review_score',
  'actualResult', 'actual_result', 'completionResult', 'completion_result',
  'taskEvaluations', 'taskScores',
]);

function containsTaskReviewFields(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsTaskReviewFields);
  return Object.entries(value).some(([key, child]) => taskReviewInputKeys.has(key) || containsTaskReviewFields(child));
}

function validateDepartmentReviewInput(args) {
  if (args.reviewScope !== 'department_period_summary') {
    throw new AppError(
      'INVALID_ARGUMENT',
      '仅当用户明确要求填写部门周期复盘总结时，才可调用 save_review_record，并传入 reviewScope="department_period_summary"。',
    );
  }
  if (containsTaskReviewFields(args)) {
    throw new AppError('INVALID_ARGUMENT', '任务复盘请通过 prepare_update_pad_task 和 commit_update_pad_task 提交。');
  }
}

function hasTaskReviewChanges(changes) {
  return ['taskReview', 'task_review', 'taskReviewScore', 'task_review_score'].some((key) => hasKey(changes, key));
}

function reviewWriteOf(previewOrMetadata = {}) {
  if (previewOrMetadata.reviewWrite) return previewOrMetadata.reviewWrite;
  return previewOrMetadata.reviewSync
    ? { mode: 'task_and_department', ...previewOrMetadata.reviewSync }
    : undefined;
}

function hasKey(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateAliasPair(changes, camelKey, snakeKey) {
  if (hasKey(changes, camelKey) && hasKey(changes, snakeKey)
    && JSON.stringify(changes[camelKey]) !== JSON.stringify(changes[snakeKey])) {
    throw rejectInvalid();
  }
}

function validateTaskChanges(changes, { allowOwnerChange = false } = {}) {
  for (const [camelKey, snakeKey] of [
    ['alignedKrId', 'aligned_kr_id'], ['targetWeeks', 'target_weeks'],
    ['startDate', 'start_date'], ['dueDate', 'due_date'], ['participantIds', 'participant_ids'],
    ['approverIds', 'approver_ids'], ['taskReview', 'task_review'],
    ['taskReviewScore', 'task_review_score'], ['ownerId', 'owner_id'],
  ]) validateAliasPair(changes, camelKey, snakeKey);

  if (hasKey(changes, 'title')
    && (typeof changes.title !== 'string' || changes.title.trim().length === 0)) {
    throw rejectInvalid();
  }
  if (hasKey(changes, 'priority') && !['high', 'medium', 'low'].includes(changes.priority)) throw rejectInvalid();
  if (hasKey(changes, 'alignedKrId') && (typeof changes.alignedKrId !== 'string' || changes.alignedKrId.length > 128)) throw rejectInvalid();
  if (hasKey(changes, 'aligned_kr_id') && (typeof changes.aligned_kr_id !== 'string' || changes.aligned_kr_id.length > 128)) throw rejectInvalid();
  if (hasKey(changes, 'alignedKrId') && !parseReviewSlot(changes.alignedKrId, 'unknown').ok) throw rejectInvalid();
  if (hasKey(changes, 'aligned_kr_id') && !parseReviewSlot(changes.aligned_kr_id, 'unknown').ok) throw rejectInvalid();

  for (const key of ['targetWeeks', 'target_weeks']) {
    if (hasKey(changes, key) && (!Array.isArray(changes[key]) || changes[key].length > 53
      || changes[key].some((value) => typeof value !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(value)))) throw rejectInvalid();
  }
  for (const key of ['tags']) {
    if (hasKey(changes, key) && (!Array.isArray(changes[key]) || changes[key].length > 12
      || changes[key].some((value) => typeof value !== 'string' || value.length > 32))) throw rejectInvalid();
  }
  for (const [camelKey, snakeKey, maximum] of [
    ['participantIds', 'participant_ids', 50], ['approverIds', 'approver_ids', 20],
  ]) {
    for (const key of [camelKey, snakeKey]) {
      if (hasKey(changes, key) && (!Array.isArray(changes[key]) || changes[key].length > maximum
        || changes[key].some((value) => typeof value !== 'string' || !value.trim() || value.length > 128))) throw rejectInvalid();
    }
  }
  for (const key of ['plan', 'action']) {
    if (hasKey(changes, key) && (typeof changes[key] !== 'string' || changes[key].length > 2000)) throw rejectInvalid();
  }
  for (const key of ['deliverable', 'taskReview', 'task_review']) {
    if (hasKey(changes, key) && typeof changes[key] !== 'string') throw rejectInvalid();
  }
  for (const key of ['taskReviewScore', 'task_review_score']) {
    if (hasKey(changes, key) && (!Number.isSafeInteger(changes[key]) || changes[key] < 0 || changes[key] > 100)) throw rejectInvalid();
  }
  for (const key of ['startDate', 'start_date', 'dueDate', 'due_date']) {
    if (hasKey(changes, key) && changes[key] !== null
      && (!Number.isSafeInteger(changes[key]) || changes[key] < 0)) throw rejectInvalid();
  }
  const start = changes.startDate ?? changes.start_date;
  const due = changes.dueDate ?? changes.due_date;
  if (start !== undefined && due !== undefined && start !== null && due !== null && due < start) throw rejectInvalid();
  for (const key of ['ownerId', 'owner_id']) {
    if (hasKey(changes, key) && (!allowOwnerChange || typeof changes[key] !== 'string' || !changes[key].trim() || changes[key].length > 128)) throw rejectInvalid();
  }
}

function updateInput(args = {}, { allowOwnerChange = false } = {}) {
  if (args.changes === undefined || !args.taskId) throw rejectInvalid();
  if (!args.changes || typeof args.changes !== 'object' || Array.isArray(args.changes)) throw rejectInvalid();
  if (Object.keys(args.changes).length < 1 || Object.keys(args.changes).length > 20) throw rejectInvalid();
  if (Object.prototype.hasOwnProperty.call(args.changes, 'departmentId')
    || Object.prototype.hasOwnProperty.call(args.changes, 'department_id')
    || (!allowOwnerChange && (Object.prototype.hasOwnProperty.call(args.changes, 'ownerId')
      || Object.prototype.hasOwnProperty.call(args.changes, 'owner_id')
      || Object.prototype.hasOwnProperty.call(args.changes, 'ownerName')))
    ) {
    throw rejectInvalid();
  }
  for (const key of Object.keys(args.changes)) {
    if (!updateKeys.has(key)) throw rejectInvalid();
    if (key === 'status' && !['draft', 'in-progress', 'paused', 'approved', 'completed', 'terminated'].includes(args.changes[key])) throw rejectInvalid();
    if (!allowOwnerChange && (key === 'ownerId' || key === 'owner_id')) throw rejectInvalid();
  }
  if (args.changes.ownerName !== undefined && !isUserReference(args.changes.ownerName)) throw rejectInvalid();
  for (const key of ['participantNames', 'approverNames']) {
    const maximum = key === 'participantNames' ? 50 : 20;
    if (args.changes[key] !== undefined && (!Array.isArray(args.changes[key]) || args.changes[key].length > maximum || args.changes[key].some((value) => !isUserReference(value)))) throw rejectInvalid();
  }
  const mapped = { ...args.changes };
  const start = mapped.startDate ?? mapped.start_date;
  const due = mapped.dueDate ?? mapped.due_date;
  if (start !== undefined && start !== null && (!Number.isSafeInteger(start) || start < 0)) throw rejectInvalid();
  if (due !== undefined && due !== null && (!Number.isSafeInteger(due) || due < 0)) throw rejectInvalid();
  if (start !== undefined && due !== undefined && start !== null && due !== null && due < start) throw rejectInvalid();
  validateTaskChanges(args.changes, { allowOwnerChange });
  return {
    taskId: args.taskId,
    changes: structuredClone(args.changes),
    ...(args.reviewPeriodKey !== undefined ? { reviewPeriodKey: args.reviewPeriodKey } : {}),
  };
}

function digest(toolName, args) {
  return computeArgsDigest(toolName, args);
}

function confirmationMismatch() {
  return new AppError('CONFIRMATION_INVALID');
}

function sameText(left, right) {
  const normalized = (value) => typeof value === 'string' ? value.trim() : null;
  return normalized(left) === normalized(right);
}

function canonicalizeNamedReference(reference, expected) {
  if (!expected || !reference || !sameText(reference.name, expected.name)
    || !sameText(reference.departmentName ?? null, expected.departmentName ?? null)) {
    throw confirmationMismatch();
  }
  return expected.userId;
}

function canonicalizeUsers(next, metadata, nameKey, idKey, identityKey) {
  const expected = metadata?.identity?.[identityKey];
  if (next[nameKey] !== undefined) {
    if (!Array.isArray(expected) || next[nameKey].length !== expected.length) throw confirmationMismatch();
    next[idKey] = next[nameKey].map((reference, index) => canonicalizeNamedReference(reference, expected[index]));
    delete next[nameKey];
  }
  if (metadata?.payload?.[idKey] !== undefined
    && JSON.stringify(next[idKey] ?? []) !== JSON.stringify(metadata.payload[idKey])) throw confirmationMismatch();
}

function canonicalizeTaskPayload(payload, metadata) {
  const next = structuredClone(payload ?? {});
  const expectedDepartment = metadata?.identity?.department;
  const expectedDepartmentId = metadata?.payload?.departmentId;
  if (next.departmentName !== undefined) {
    if (!expectedDepartment || !sameText(next.departmentName, expectedDepartment.name)) {
      throw confirmationMismatch();
    }
    if (next.departmentId !== undefined && next.departmentId !== expectedDepartment.id) {
      throw confirmationMismatch();
    }
    next.departmentId = expectedDepartment.id;
    delete next.departmentName;
  }
  if (next.departmentId === undefined && expectedDepartmentId !== undefined) {
    next.departmentId = expectedDepartmentId;
  }
  if (expectedDepartmentId !== undefined && next.departmentId !== expectedDepartmentId) {
    throw confirmationMismatch();
  }
  const expectedOwner = metadata?.identity?.owner;
  if (next.ownerName !== undefined) {
    next.ownerId = canonicalizeNamedReference(next.ownerName, expectedOwner);
    delete next.ownerName;
  }
  if (metadata?.payload?.ownerId !== undefined && next.ownerId !== metadata.payload.ownerId) throw confirmationMismatch();
  canonicalizeUsers(next, metadata, 'participantNames', 'participantIds', 'participant');
  canonicalizeUsers(next, metadata, 'approverNames', 'approverIds', 'approver');
  const periodKeys = ['targetWeeks', 'startDate', 'dueDate'];
  if (periodKeys.every((key) => next[key] === undefined)
    && periodKeys.every((key) => metadata?.payload?.[key] !== undefined)) {
    for (const key of periodKeys) next[key] = structuredClone(metadata.payload[key]);
  }
  return next;
}

function periodValue(value, camelKey, snakeKey) {
  if (hasKey(value ?? {}, camelKey)) return value[camelKey];
  if (hasKey(value ?? {}, snakeKey)) return value[snakeKey];
  return undefined;
}

function normalizeTaskPeriodChanges(changes, current) {
  const next = structuredClone(changes ?? {});
  const changesPeriod = ['targetWeeks', 'target_weeks', 'startDate', 'start_date', 'dueDate', 'due_date']
    .some((key) => hasKey(next, key));
  if (!changesPeriod) return next;

  const suppliedWeeks = hasKey(next, 'targetWeeks') || hasKey(next, 'target_weeks');
  const suppliedStart = hasKey(next, 'startDate') || hasKey(next, 'start_date');
  const suppliedDue = hasKey(next, 'dueDate') || hasKey(next, 'due_date');
  const finalStart = suppliedStart
    ? periodValue(next, 'startDate', 'start_date')
    : periodValue(current, 'startDate', 'start_date');
  const finalDue = suppliedDue
    ? periodValue(next, 'dueDate', 'due_date')
    : periodValue(current, 'dueDate', 'due_date');
  const periodPayload = { startDate: finalStart, dueDate: finalDue };
  if (suppliedWeeks) periodPayload.targetWeeks = periodValue(next, 'targetWeeks', 'target_weeks');
  if ((finalStart === null || finalStart === undefined) && (finalDue === null || finalDue === undefined)) {
    delete periodPayload.startDate;
    delete periodPayload.dueDate;
  }

  const normalized = normalizeTaskPeriodInput(periodPayload);
  for (const key of ['target_weeks', 'start_date', 'due_date']) delete next[key];
  next.targetWeeks = normalized.targetWeeks;
  next.startDate = normalized.startDate;
  next.dueDate = normalized.dueDate;
  return next;
}

function canonicalizeTaskChanges(changes, metadata) {
  return canonicalizeTaskPayload(changes, {
    ...metadata,
    payload: metadata?.changes ?? metadata?.payload,
  });
}

function confirmationError(reason) {
  return new AppError(reason === 'IN_FLIGHT' ? 'REQUEST_IN_FLIGHT' : 'CONFIRMATION_INVALID');
}

function isRetryable(error) {
  return ['DATA_ACCESS_FAILED', 'INTERNAL_ERROR', 'REQUEST_IN_FLIGHT'].includes(error?.code);
}

function requireCommitResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AppError('DATA_ACCESS_FAILED', '写入未返回有效结果，请稍后重试。', 502);
  }
  return result;
}

function withoutControls(args = {}) {
  const { confirmationToken: _token, requestId: _requestId, ...rest } = args;
  return rest;
}

function issuePreview(store, repository, {
  userId, sessionId, toolName, argsDigest, metadata, parameterSummary, data,
}) {
  const issued = store.issue({ userId, sessionId, toolName, argsDigest, metadata });
  return {
    ...data,
    confirmation: {
      userId,
      toolName,
      parameterSummary: structuredClone(parameterSummary ?? {}),
      argsDigest,
      expiresAt: issued.expiresAt,
    },
    confirmationToken: issued.token,
    expiresAt: issued.expiresAt,
  };
}

function contextOf(repository) {
  const context = repository.getContext?.();
  if (!context?.userId || !context?.sessionId) throw new AppError('SESSION_EXPIRED');
  return context;
}

function register(server, name, title, description, inputSchema, handler) {
  server.registerTool(name, {
    title,
    description,
    inputSchema,
    annotations: writeAnnotations,
  }, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (error) {
      return errorResponse(error);
    }
  });
}

export function registerWriteTools(server, repository, confirmationStore, { now = Date.now } = {}) {
  const commit = async ({ toolName, token, requestId, commitArgs, buildCommitArgs, metadata, operation, audit }) => {
    const context = contextOf(repository);
    if (!requestId || typeof requestId !== 'string') throw rejectInvalid();

    const prior = await repository.lookupWriteResult({ toolName, requestId });
    if (prior?.status === 'success') {
      return response('写入已完成，返回首次结果。', {
        result: prior.resultSummary,
        ...(prior.resultSummary && typeof prior.resultSummary === 'object' ? prior.resultSummary : {}),
        replayed: true,
      });
    }
    if (!token || typeof token !== 'string') throw new AppError('CONFIRMATION_INVALID');

    const peekedMetadata = confirmationStore.peek?.({
      userId: context.userId,
      sessionId: context.sessionId,
      toolName,
      token,
    }) ?? metadata ?? {};
    const argsForDigest = buildCommitArgs ? buildCommitArgs(peekedMetadata) : commitArgs;
    const begun = confirmationStore.begin({
      userId: context.userId,
      sessionId: context.sessionId,
      toolName,
      argsDigest: digest(toolName, argsForDigest),
      requestId,
      token,
    });
    if (!begun?.valid) throw confirmationError(begun?.reason);

    try {
      const result = requireCommitResult(await operation(begun.metadata ?? metadata ?? {}));
      confirmationStore.finalize({ token });
      return response('写入成功。', result);
    } catch (error) {
      if (isRetryable(error)) confirmationStore.rollback({ token });
      else confirmationStore.finalize({ token });
      try {
        await repository.recordFailedWrite({
          toolName,
          requestId,
          action: audit.action,
          objectType: audit.objectType,
          objectId: audit.objectId ?? 'unknown',
          errorCode: error?.code ?? 'INTERNAL_ERROR',
          beforeSummary: audit.beforeSummary,
        });
      } catch {
        // 失败审计是 best-effort，不能覆盖原始业务错误。
      }
      throw error;
    }
  };

  register(server, 'prepare_create_pad_task', '预览创建 PAD 任务', '只生成创建预览并签发确认令牌，不会写入。当前账号没有默认部门时，必须提供 departmentId 或 departmentName。', {
    payload: z.object({ ...taskPayloadShape, title: taskPayloadShape.title.unwrap() }),
  }, async (args) => {
    const context = contextOf(repository);
    const payload = createPayload(args, context, { defaultPeriod: true, nowMs: now() });
    if (!payload.departmentId && !payload.departmentName) {
      throw new AppError('DEPARTMENT_REQUIRED', undefined, 400);
    }
    const preview = await repository.prepareCreatePadTask({ payload });
    const canonicalPayload = preview.payload ?? payload;
    const preparedArgs = { payload: canonicalPayload, ...(preview.identity ? { identity: preview.identity } : {}) };
    const data = issuePreview(confirmationStore, repository, {
      userId: context.userId,
      sessionId: context.sessionId,
      toolName: 'commit_create_pad_task',
      argsDigest: digest('commit_create_pad_task', preparedArgs),
      metadata: { payload: canonicalPayload, ...(preview.identity ? { identity: preview.identity } : {}) },
      parameterSummary: preparedArgs,
      data: { preview, executed: false, nextStep: '请确认后调用 commit_create_pad_task。' },
    });
    return response('创建预览已生成。', data);
  });

  register(server, 'commit_create_pad_task', '确认创建 PAD 任务', '携带确认令牌执行创建；可省略 payload 或任务字段以复用 prepare 阶段的规范化参数，若回传任务字段则必须与预览一致；重试同一逻辑写入必须复用相同 requestId。', {
    ...taskPayloadShape,
    payload: z.object(taskPayloadShape).optional(),
    confirmationToken: z.string().min(1),
    requestId: requestIdSchema,
  }, async (args) => {
    const context = contextOf(repository);
    const payload = hasCreatePayloadInput(args) ? createPayload(args, context) : undefined;
    const result = await commit({
      toolName: 'commit_create_pad_task',
      token: args.confirmationToken,
      requestId: args.requestId,
      commitArgs: payload === undefined ? {} : { payload },
      buildCommitArgs: (metadata) => ({
        payload: payload === undefined
          ? metadata.payload
          : canonicalizeTaskPayload(payload, metadata),
        ...(metadata.identity ? { identity: metadata.identity } : {}),
      }),
      operation: (metadata) => repository.commitCreatePadTask({
        payload: metadata.payload ?? payload,
        requestId: args.requestId,
      }),
      audit: { action: 'create', objectType: 'task' },
    });
    return result;
  });

  register(server, 'prepare_update_pad_task', '预览更新 PAD 任务或任务复盘', '读取旧值并生成更新预览和确认令牌，不会写入。填写具体任务的实际成果、实际结果、完成情况或任务复盘时，必须写入 changes.taskReview；即使该周尚未建立部门复盘，也可以仅写任务，不得要求用户先创建部门复盘或调用 save_review_record。', {
    taskId: taskIdSchema,
    changes: taskChangesSchema,
    reviewPeriodKey: weekSchema.optional(),
  }, async (args) => {
    const context = contextOf(repository);
    const input = updateInput(args, { allowOwnerChange: context.role === 'Admin' || context.role === 'Manager' });
    const preview = await repository.prepareUpdatePadTask(input);
    const canonicalChanges = normalizeTaskPeriodChanges(preview.changes ?? input.changes, preview.current);
    const reviewTarget = hasTaskReviewChanges(canonicalChanges) ? 'task_review' : undefined;
    const reviewWrite = reviewWriteOf(preview);
    const preparedArgs = {
      taskId: input.taskId,
      changes: canonicalChanges,
      expectedRowVersion: preview.expectedRowVersion,
      ...(reviewWrite ? {
        reviewWriteMode: reviewWrite.mode,
        reviewPeriodKey: reviewWrite.periodKey,
      } : {}),
      ...(reviewWrite?.mode === 'task_and_department' ? {
        expectedDepartmentRowVersion: reviewWrite.expectedRowVersion,
        reviewKey: reviewWrite.reviewKey,
        krIndex: reviewWrite.krIndex,
      } : {}),
      ...(preview.identity ? { identity: preview.identity } : {}),
    };
    const data = issuePreview(confirmationStore, repository, {
      userId: context.userId,
      sessionId: context.sessionId,
      toolName: 'commit_update_pad_task',
      argsDigest: digest('commit_update_pad_task', preparedArgs),
      metadata: {
        expectedRowVersion: preview.expectedRowVersion,
        current: preview.current,
        changes: canonicalChanges,
        ...(preview.identity ? { identity: preview.identity } : {}),
        ...(reviewWrite ? { reviewWrite } : {}),
        ...(preview.reviewSync ? { reviewSync: preview.reviewSync } : {}),
      },
      parameterSummary: {
        old: preview.current,
        new: canonicalChanges,
        expectedRowVersion: preview.expectedRowVersion,
        ...(reviewTarget ? { reviewTarget } : {}),
        ...(reviewWrite ? { reviewWriteMode: reviewWrite.mode, reviewPeriodKey: reviewWrite.periodKey } : {}),
        ...(preview.identity ? { identity: preview.identity } : {}),
        ...(preview.reviewSync ? { reviewSync: preview.reviewSync, reviewPeriodKey: preview.reviewSync.periodKey } : {}),
      },
      data: {
        taskId: input.taskId,
        ...preview,
        changes: canonicalChanges,
        ...(reviewTarget ? { reviewTarget } : {}),
        ...(reviewWrite ? { reviewWriteMode: reviewWrite.mode, reviewPeriodKey: reviewWrite.periodKey } : {}),
        executed: false,
      },
    });
    const reviewLabel = reviewWrite?.mode === 'task_only'
      ? '任务复盘更新预览已生成（仅写任务）。'
      : '任务复盘更新预览已生成（同步部门复盘卡片）。';
    return response(reviewTarget ? reviewLabel : '更新预览已生成。', data);
  });

  register(server, 'commit_update_pad_task', '确认更新 PAD 任务或任务复盘', '携带确认令牌执行更新；具体任务成果必须通过 taskReview 提交。重试同一逻辑写入必须复用相同 requestId。', {
    taskId: taskIdSchema,
    changes: taskChangesSchema,
    expectedRowVersion: z.number().int().nonnegative(),
    reviewPeriodKey: weekSchema.optional(),
    confirmationToken: z.string().min(1),
    requestId: requestIdSchema,
  }, async (args) => {
    const context = contextOf(repository);
    const input = updateInput(args, { allowOwnerChange: context.role === 'Admin' || context.role === 'Manager' });
    const expectedRowVersion = args.expectedRowVersion;
    const result = await commit({
      toolName: 'commit_update_pad_task',
      token: args.confirmationToken,
      requestId: args.requestId,
      commitArgs: { ...input, expectedRowVersion },
      buildCommitArgs: (metadata) => {
        const reviewWrite = reviewWriteOf(metadata);
        return {
          ...input,
          changes: normalizeTaskPeriodChanges(canonicalizeTaskChanges(input.changes, metadata), metadata.current),
          expectedRowVersion,
          ...(metadata.identity ? { identity: metadata.identity } : {}),
          ...(reviewWrite ? {
            reviewWriteMode: reviewWrite.mode,
            reviewPeriodKey: input.reviewPeriodKey ?? reviewWrite.periodKey,
          } : {}),
          ...(reviewWrite?.mode === 'task_and_department' ? {
            expectedDepartmentRowVersion: reviewWrite.expectedRowVersion,
            reviewKey: reviewWrite.reviewKey,
            krIndex: reviewWrite.krIndex,
            ...(reviewWrite.rootId ? { rootId: reviewWrite.rootId, nodePath: reviewWrite.nodePath } : {}),
          } : {}),
        };
      },
      operation: (metadata) => {
        const reviewWrite = reviewWriteOf(metadata);
        return repository.commitUpdatePadTask({
          ...input,
          changes: metadata.changes ?? input.changes,
          expectedRowVersion,
          ...(reviewWrite ? {
            reviewWriteMode: reviewWrite.mode,
            reviewPeriodKey: reviewWrite.periodKey,
          } : {}),
          ...(reviewWrite?.mode === 'task_and_department' ? {
            expectedDepartmentRowVersion: reviewWrite.expectedRowVersion,
            reviewKey: reviewWrite.reviewKey,
            krIndex: reviewWrite.krIndex,
            ...(reviewWrite.rootId ? { rootId: reviewWrite.rootId, nodePath: reviewWrite.nodePath } : {}),
          } : {}),
          requestId: args.requestId,
        });
      },
      audit: { action: 'update', objectType: 'task', objectId: input.taskId },
    });
    return result;
  });

  register(server, 'submit_pad_task', '提交 PAD 任务', '首次调用只预览；携带确认令牌执行提交。重试同一逻辑写入必须复用相同 requestId。', {
    taskId: taskIdSchema,
    confirmationToken: z.string().min(1).optional(),
    requestId: requestIdSchema.optional(),
  }, async (args) => {
    const context = contextOf(repository);
    if (!args.confirmationToken) {
      const preview = await repository.prepareSubmitPadTask({ taskId: args.taskId });
      const expectedRowVersion = preview.expectedRowVersion;
      const data = issuePreview(confirmationStore, repository, {
        userId: context.userId,
        sessionId: context.sessionId,
        toolName: 'submit_pad_task',
        argsDigest: digest('submit_pad_task', { taskId: args.taskId, expectedRowVersion }),
        metadata: { expectedRowVersion },
        parameterSummary: { old: preview.current, new: { status: 'submitted' }, expectedRowVersion },
        data: {
          taskId: args.taskId,
          currentStatus: preview.current?.status,
          nextStatus: 'submitted',
          approverIds: preview.current?.approverIds ?? preview.current?.approver_ids ?? [],
          expectedRowVersion,
          executed: false,
        },
      });
      return response('提交预览已生成。', data);
    }
    return commit({
      toolName: 'submit_pad_task',
      token: args.confirmationToken,
      requestId: args.requestId,
      buildCommitArgs: (metadata) => ({ taskId: args.taskId, expectedRowVersion: metadata.expectedRowVersion ?? args.expectedRowVersion }),
      operation: (metadata) => repository.commitSubmitPadTask({
        taskId: args.taskId,
        expectedRowVersion: metadata.expectedRowVersion ?? args.expectedRowVersion,
        requestId: args.requestId,
      }).then((result) => ({ ...result, executed: true })),
      audit: { action: 'submit', objectType: 'task', objectId: args.taskId },
    });
  });

  register(server, 'save_review_record', '保存部门周期复盘总结（非任务复盘）', '仅当用户明确要求填写部门周复盘总结或其他部门周期复盘总结时使用。具体任务的实际成果、实际结果、完成情况或任务复盘必须使用 prepare_update_pad_task 和 commit_update_pad_task。首次调用只预览；携带确认令牌执行保存。重试同一逻辑写入必须复用相同 requestId。', {
    reviewScope: departmentReviewScopeSchema,
    departmentId: z.string().trim().min(1).max(128),
    periodKey: z.string().trim().min(1).max(32),
    content: z.string().trim().min(1).describe('部门周期整体复盘总结；不得填写某一个具体任务的实际成果或结果。'),
    score: z.number().int().min(0).max(100).optional(),
    okrDetails: recordSchema.optional(),
    confirmationToken: z.string().min(1).optional(),
    requestId: requestIdSchema.optional(),
  }, async (args) => {
    validateDepartmentReviewInput(args);
    const entry = { content: args.content, ...(args.score !== undefined ? { score: args.score } : {}), ...(args.okrDetails !== undefined ? { okrDetails: args.okrDetails } : {}) };
    const context = contextOf(repository);
    if (!args.confirmationToken) {
      const preview = await repository.prepareSaveReviewRecord({ departmentId: args.departmentId, periodKey: args.periodKey, entry });
      const expectedRowVersion = preview.expectedRowVersion;
      const data = issuePreview(confirmationStore, repository, {
        userId: context.userId,
        sessionId: context.sessionId,
        toolName: 'save_review_record',
        argsDigest: digest('save_review_record', { reviewScope: args.reviewScope, departmentId: args.departmentId, periodKey: args.periodKey, entry, expectedRowVersion }),
        metadata: {
          expectedRowVersion,
          ...(preview.current?.rootId ? {
            rootId: preview.current.rootId,
            nodePath: preview.current.nodePath,
          } : {}),
        },
        parameterSummary: { reviewTarget: args.reviewScope, old: preview.current, new: entry, expectedRowVersion },
        data: { reviewScope: args.reviewScope, reviewTarget: args.reviewScope, departmentId: args.departmentId, periodKey: args.periodKey, preview, expectedRowVersion, executed: false },
      });
      return response('部门周期复盘总结保存预览已生成。', data);
    }
    return commit({
      toolName: 'save_review_record',
      token: args.confirmationToken,
      requestId: args.requestId,
      buildCommitArgs: (metadata) => ({
        reviewScope: args.reviewScope,
        departmentId: args.departmentId,
        periodKey: args.periodKey,
        entry,
        expectedRowVersion: metadata.expectedRowVersion ?? args.expectedRowVersion,
        ...(metadata.rootId ? { rootId: metadata.rootId, nodePath: metadata.nodePath } : {}),
      }),
      operation: (metadata) => repository.commitSaveReviewRecord({
        departmentId: args.departmentId,
        periodKey: args.periodKey,
        entry,
        expectedRowVersion: metadata.expectedRowVersion ?? args.expectedRowVersion,
        ...(metadata.rootId ? { rootId: metadata.rootId, nodePath: metadata.nodePath } : {}),
        requestId: args.requestId,
      }).then((result) => ({ ...result, executed: true })),
      audit: { action: 'save_review', objectType: 'department_review', objectId: args.departmentId },
    });
  });
}
