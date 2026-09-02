import { AppError } from './errors.mjs';
import { parseReviewSlot } from './review-slot.mjs';

const TASK_FIELDS = [
  'id', 'created_by', 'title', 'status', 'priority', 'owner_id', 'department_id',
  'aligned_kr_id', 'target_weeks', 'start_date', 'due_date', 'tags',
  'participant_ids', 'approver_ids', 'logs', 'plan', 'action', 'deliverable',
  'task_review', 'task_review_score', 'updated_at', 'row_version',
].join(',');

const TASK_WRITE_FIELDS = Object.freeze({
  departmentId: 'department_id',
  title: 'title',
  status: 'status',
  priority: 'priority',
  ownerId: 'owner_id',
  alignedKrId: 'aligned_kr_id',
  targetWeeks: 'target_weeks',
  startDate: 'start_date',
  dueDate: 'due_date',
  tags: 'tags',
  participantIds: 'participant_ids',
  approverIds: 'approver_ids',
  plan: 'plan',
  action: 'action',
  deliverable: 'deliverable',
  taskReview: 'task_review',
  taskReviewScore: 'task_review_score',
});

function safeDiagnosticCode(error) {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : 'UNKNOWN';
}

function dataAccessError(error, message = '数据读取失败，请稍后重试。', status = 502) {
  const appError = new AppError('DATA_ACCESS_FAILED', message, status);
  appError.diagnosticCode = safeDiagnosticCode(error);
  return appError;
}

function isMissingRpc(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return error?.code === 'PGRST202'
    || error?.code === '42883'
    || /could not find the function|function .* does not exist|schema cache/i.test(message);
}

function mapRpcError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message.startsWith('MCP_VERSION_CONFLICT:')) return new AppError('VERSION_CONFLICT');
  if (message.startsWith('MCP_PERMISSION_DENIED:')) return new AppError('PERMISSION_DENIED');
  if (message.startsWith('MCP_REQUEST_IN_FLIGHT:')) return new AppError('REQUEST_IN_FLIGHT');
  if (message.startsWith('MCP_VALIDATION:')) return new AppError('MCP_VALIDATION', undefined, 400);
  if (message.startsWith('MCP_TASK_PERIOD_MISMATCH:')) return new AppError('TASK_PERIOD_MISMATCH', undefined, 400);
  if (isMissingRpc(error)) {
    const publicMessage = message.includes('mcp_update_pad_task_with_review_sync')
      ? '任务复盘同步功能尚未启用，请先完成当前版本迁移后重试。'
      : undefined;
    const appError = new AppError('RPC_NOT_CONFIGURED', publicMessage, 503);
    appError.diagnosticCode = 'RPC_NOT_FOUND';
    return appError;
  }
  return dataAccessError(error);
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(dataAccessError({ code: 'TIMEOUT' }, '写入操作超时，请稍后重试。', 504)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcResultPayload(data) {
  if (!isRecord(data)) {
    throw dataAccessError({ code: 'EMPTY_RPC_RESULT' }, '写入未返回有效结果，请稍后重试。');
  }
  if (data.replayed === true && isRecord(data.result)) return data.result;
  return data;
}

function requireRpcResult(name, data) {
  const payload = rpcResultPayload(data);
  const task = payload.task;
  if (name === 'mcp_create_pad_task' || name === 'mcp_update_pad_task' || name === 'mcp_submit_pad_task') {
    if (!isRecord(task) || typeof task.id !== 'string' || !task.id
      || !Number.isSafeInteger(Number(task.rowVersion ?? payload.rowVersion))) {
      throw dataAccessError({ code: 'INVALID_RPC_RESULT' }, '写入结果不完整，请稍后重试。');
    }
  } else if (name === 'mcp_update_pad_task_with_review_sync') {
    if (!isRecord(task) || typeof task.id !== 'string' || !task.id
      || !Number.isSafeInteger(Number(task.rowVersion ?? payload.rowVersion))
      || !isRecord(payload.reviewSync)
      || typeof payload.reviewSync.departmentId !== 'string'
      || !Number.isSafeInteger(Number(payload.departmentRowVersion ?? payload.reviewSync.rowVersion))) {
      throw dataAccessError({ code: 'INVALID_RPC_RESULT' }, '任务及复盘同步结果不完整，请稍后重试。');
    }
  } else if (name === 'mcp_save_review_record') {
    if (typeof payload.departmentId !== 'string' || !payload.departmentId
      || typeof payload.periodKey !== 'string' || !payload.periodKey
      || typeof payload.reviewId !== 'string' || !payload.reviewId
      || !Number.isSafeInteger(Number(payload.rowVersion))) {
      throw dataAccessError({ code: 'INVALID_RPC_RESULT' }, '复盘写入结果不完整，请稍后重试。');
    }
  }
  return data;
}

function requireContext(getContext) {
  const context = getContext();
  if (!context?.accessToken) throw new AppError('SESSION_EXPIRED', '登录会话已失效，请重新连接。', 401);
  return context;
}

function normalizeRowVersion(row) {
  const value = row?.row_version ?? row?.rowVersion;
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

const REVIEW_CHANGE_KEYS = new Set(['taskReview', 'task_review', 'taskReviewScore', 'task_review_score']);

function hasReviewChanges(changes = {}) {
  return Object.keys(changes).some((key) => REVIEW_CHANGE_KEYS.has(key));
}

function readTaskValue(task, camelKey, dbKey) {
  return task?.[camelKey] ?? task?.[dbKey];
}

function reviewSlot(task) {
  const alignedKrId = readTaskValue(task, 'alignedKrId', 'aligned_kr_id');
  const parsed = parseReviewSlot(alignedKrId, task?.id);
  if (!parsed.ok) throw new AppError('INVALID_ARGUMENT', '任务的 alignedKrId 格式或 KR 下标无效。');
  return { reviewKey: parsed.reviewKey, krIndex: parsed.krIndex };
}

function resolveReviewPeriod(task, requestedPeriod) {
  const targetWeeks = readTaskValue(task, 'targetWeeks', 'target_weeks');
  const weeks = Array.isArray(targetWeeks) ? targetWeeks.filter((value) => typeof value === 'string' && value.trim()) : [];
  const period = typeof requestedPeriod === 'string' ? requestedPeriod.trim() : '';
  if (period) {
    if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(period) || !weeks.includes(period)) {
      throw new AppError('INVALID_ARGUMENT', 'reviewPeriodKey 必须是该任务的目标周次。');
    }
    return period;
  }
  if (weeks.length !== 1) {
    throw new AppError('INVALID_ARGUMENT', '任务目标周次为空或不唯一，请明确提供 reviewPeriodKey。');
  }
  return weeks[0];
}

function readReviewSync(department, task, changes, requestedPeriod) {
  const departmentId = department?.id;
  const periodKey = resolveReviewPeriod(task, requestedPeriod);
  const { reviewKey, krIndex } = reviewSlot(task);
  const reviews = department?.reviews && typeof department.reviews === 'object'
    ? department.reviews[periodKey]
    : null;
  if (!Array.isArray(reviews) || reviews.length === 0) {
    throw new AppError('INVALID_ARGUMENT', '目标复盘周期不存在，请先保存该周期复盘记录。');
  }
  const latest = reviews[reviews.length - 1] ?? {};
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
    throw new AppError('INVALID_ARGUMENT', '目标复盘数据格式错误，请先修复历史记录。');
  }
  if (latest.okrDetails !== undefined
    && (!latest.okrDetails || typeof latest.okrDetails !== 'object' || Array.isArray(latest.okrDetails))) {
    throw new AppError('INVALID_ARGUMENT', '目标复盘的 okrDetails 格式错误，请先修复历史记录。');
  }
  const okrDetails = latest.okrDetails ?? {};
  const rawReview = okrDetails[reviewKey];
  if (rawReview !== undefined && (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview))) {
    throw new AppError('INVALID_ARGUMENT', '目标 OKR 复盘数据格式错误，请先修复历史记录。');
  }
  const currentReview = rawReview ?? {};
  if (currentReview.krReviews !== undefined && !Array.isArray(currentReview.krReviews)) {
    throw new AppError('INVALID_ARGUMENT', '目标 KR 复盘数据格式错误，请先修复历史记录。');
  }
  const currentKr = currentReview.krReviews?.[krIndex] ?? {};
  if (currentKr && (typeof currentKr !== 'object' || Array.isArray(currentKr))) {
    throw new AppError('INVALID_ARGUMENT', '目标 KR 复盘项格式错误，请先修复历史记录。');
  }
  for (const field of ['taskEvaluations', 'taskScores']) {
    if (currentKr[field] !== undefined
      && (!currentKr[field] || typeof currentKr[field] !== 'object' || Array.isArray(currentKr[field]))) {
      throw new AppError('INVALID_ARGUMENT', `目标 KR 的 ${field} 格式错误，请先修复历史记录。`);
    }
  }
  const taskEvaluation = readTaskValue(task, 'taskReview', 'task_review') ?? '';
  const taskScore = readTaskValue(task, 'taskReviewScore', 'task_review_score') ?? 0;
  const oldEvaluation = currentKr?.taskEvaluations?.[task.id] ?? taskEvaluation;
  const oldScore = currentKr?.taskScores?.[task.id] ?? taskScore;
  const nextEvaluation = Object.prototype.hasOwnProperty.call(changes, 'taskReview')
    ? changes.taskReview
    : Object.prototype.hasOwnProperty.call(changes, 'task_review')
      ? changes.task_review
      : taskEvaluation;
  const nextScore = Object.prototype.hasOwnProperty.call(changes, 'taskReviewScore')
    ? changes.taskReviewScore
    : Object.prototype.hasOwnProperty.call(changes, 'task_review_score')
      ? changes.task_review_score
      : taskScore;
  return {
    departmentId,
    periodKey,
    reviewKey,
    krIndex,
    expectedRowVersion: normalizeRowVersion(department),
    ...(department?.rootId && department.rootId !== departmentId ? {
      rootId: department.rootId,
      nodePath: Array.isArray(department.nodePath) ? department.nodePath : [],
    } : {}),
    before: { evaluation: oldEvaluation, score: oldScore },
    after: { evaluation: nextEvaluation ?? '', score: nextScore ?? 0 },
  };
}

function toDbTaskPayload(payload = {}) {
  for (const key of ['ownerName', 'participantNames', 'approverNames']) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) throw new AppError('INVALID_ARGUMENT');
  }
  const result = {};
  for (const [key, dbKey] of Object.entries(TASK_WRITE_FIELDS)) {
    if (payload[key] !== undefined) result[dbKey] = payload[key];
  }
  if (result.status === undefined) result.status = 'draft';
  return result;
}

function toDbChanges(changes = {}) {
  const result = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'departmentId' || key === 'department_id' || key === 'departmentID') {
      throw new AppError('INVALID_ARGUMENT');
    }
    if (key === 'ownerId' || key === 'owner_id') {
      result.owner_id = value;
      continue;
    }
    const dbKey = TASK_WRITE_FIELDS[key] ?? (Object.values(TASK_WRITE_FIELDS).includes(key) ? key : null);
    if (!dbKey) throw new AppError('INVALID_ARGUMENT');
    result[dbKey] = value;
  }
  return result;
}

function toDbReviewEntry(entry = {}) {
  if (containsTaskReviewFields(entry?.okrDetails)) {
    throw new AppError('INVALID_ARGUMENT', '任务复盘请通过 prepare_update_pad_task 和 commit_update_pad_task 提交。');
  }
  return {
    content: entry.content,
    ...(entry.score !== undefined ? { score: entry.score } : {}),
    ...(entry.okrDetails !== undefined ? { okrDetails: entry.okrDetails } : {}),
  };
}

function containsTaskReviewFields(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsTaskReviewFields);
  return Object.entries(value).some(([key, child]) => key === 'taskEvaluations' || key === 'taskScores' || containsTaskReviewFields(child));
}

export function createWriteRepository({ createUserClient, getContext, requestTimeoutMs, logger = console, identityRepository }) {
  async function execute(operationName, operation, { logDataAccess = true } = {}) {
    try {
      const context = requireContext(getContext);
      const client = createUserClient(context.accessToken);
      return await operation(client, context);
    } catch (error) {
      const publicError = error instanceof AppError ? error : mapRpcError(error);
      if (logDataAccess && publicError.code === 'RPC_NOT_CONFIGURED') {
        logger.error?.({
          event: 'supabase_rpc_not_configured',
          operation: operationName,
          code: publicError.diagnosticCode ?? 'RPC_NOT_FOUND',
        });
      } else if (logDataAccess && publicError.code === 'DATA_ACCESS_FAILED') {
        logger.error?.({
          event: 'supabase_write_failed',
          operation: operationName,
          code: publicError.diagnosticCode ?? 'UNKNOWN',
        });
      }
      throw publicError;
    }
  }

  async function readTask(client, taskId) {
    const result = await withTimeout(
      client.from('tasks').select(TASK_FIELDS).eq('id', taskId).maybeSingle(),
      requestTimeoutMs,
    );
    if (result?.error) throw dataAccessError(result.error);
    if (!result.data) throw new AppError('DATA_ACCESS_FAILED', '任务不存在或当前账号无权查看。', 404);
    return result.data;
  }

  async function readDepartment(client, departmentId) {
    const result = await withTimeout(
      client.from('departments').select('id,reviews,row_version').eq('id', departmentId).maybeSingle(),
      requestTimeoutMs,
    );
    if (result?.error) throw dataAccessError(result.error);
    if (result?.data) return result.data;
    const scoped = await withTimeout(client.rpc('mcp_get_department_review_context', {
      p_department_id: departmentId,
    }), requestTimeoutMs);
    if (scoped?.error) {
      if (isMissingRpc(scoped.error)) {
        throw new AppError('DATA_ACCESS_FAILED', '部门不存在或当前账号无权查看。', 404);
      }
      throw mapRpcError(scoped.error);
    }
    if (!scoped?.data || typeof scoped.data !== 'object') {
      throw new AppError('DATA_ACCESS_FAILED', '部门不存在或当前账号无权查看。', 404);
    }
    return {
      id: scoped.data.departmentId ?? departmentId,
      reviews: scoped.data.reviews ?? {},
      row_version: scoped.data.rowVersion,
      rootId: scoped.data.rootId ?? null,
      nodePath: scoped.data.nodePath ?? [],
      departmentName: scoped.data.departmentName ?? null,
    };
  }

  async function callRpc(client, name, args, { allowEmpty = false } = {}) {
    const result = await withTimeout(client.rpc(name, args), requestTimeoutMs);
    if (result?.error) throw mapRpcError(result.error);
    if (allowEmpty) return result?.data;
    return requireRpcResult(name, result?.data);
  }

  async function resolveTaskUserNames(payload) {
    const next = structuredClone(payload ?? {});
    const identity = {};
    if (next.ownerName !== undefined) {
      if (!identityRepository) throw new AppError('DATA_ACCESS_FAILED');
      const resolved = await identityRepository.resolveUser({ ...next.ownerName, purpose: 'owner' });
      if (next.ownerId !== undefined && next.ownerId !== resolved.userId) throw new AppError('INVALID_ARGUMENT');
      next.ownerId = resolved.userId;
      identity.owner = resolved;
      delete next.ownerName;
    }
    for (const [nameKey, idKey, purpose] of [
      ['participantNames', 'participantIds', 'participant'],
      ['approverNames', 'approverIds', 'approver'],
    ]) {
      if (next[nameKey] === undefined) continue;
      if (!identityRepository) throw new AppError('DATA_ACCESS_FAILED');
      const resolved = await identityRepository.resolveUsers({ users: next[nameKey], purpose });
      const ids = resolved.users.map((user) => user.userId);
      if (next[idKey] !== undefined && JSON.stringify(next[idKey]) !== JSON.stringify(ids)) throw new AppError('INVALID_ARGUMENT');
      next[idKey] = ids;
      identity[purpose] = resolved.users;
      delete next[nameKey];
    }
    return { payload: next, identity };
  }

  return Object.freeze({
    getContext,

    async prepareCreatePadTask({ payload }) {
      requireContext(getContext);
      const resolved = await resolveTaskUserNames(payload);
      return { payload: resolved.payload, ...(Object.keys(resolved.identity).length ? { identity: resolved.identity } : {}) };
    },

    async commitCreatePadTask({ payload, requestId }) {
      const rpcName = payload?.departmentId ? 'mcp_create_pad_task_scoped' : 'mcp_create_pad_task';
      return execute('commit_create_pad_task', (client) => callRpc(client, rpcName, {
        p_task: toDbTaskPayload(payload),
        p_request_id: requestId,
      }));
    },

    async prepareUpdatePadTask({ taskId, changes, reviewPeriodKey }) {
      return execute('prepare_update_pad_task', async (client) => {
        const current = await readTask(client, taskId);
        let reviewSync;
        if (hasReviewChanges(changes)) {
          const periodKey = resolveReviewPeriod(current, reviewPeriodKey);
          const department = await readDepartment(client, readTaskValue(current, 'departmentId', 'department_id'));
          reviewSync = readReviewSync(department, current, changes, periodKey);
        }
        if (!hasReviewChanges(changes) && reviewPeriodKey !== undefined) {
          throw new AppError('INVALID_ARGUMENT', '未修改任务复盘字段时不能提供 reviewPeriodKey。');
        }
        const resolved = await resolveTaskUserNames(changes);
        return {
          current,
          changes: resolved.payload,
          expectedRowVersion: normalizeRowVersion(current),
          ...(Object.keys(resolved.identity).length ? { identity: resolved.identity } : {}),
          ...(reviewSync ? { reviewSync } : {}),
        };
      });
    },

    async commitUpdatePadTask({ taskId, changes, reviewPeriodKey, expectedRowVersion, expectedDepartmentRowVersion, reviewKey, krIndex, rootId, nodePath, requestId }) {
      return execute('commit_update_pad_task', (client) => {
        const dbChanges = toDbChanges(changes);
        if (hasReviewChanges(changes)) {
          return callRpc(client, rootId ? 'mcp_update_pad_task_with_review_sync_scoped' : 'mcp_update_pad_task_with_review_sync', {
            p_task_id: taskId,
            p_changes: dbChanges,
            p_review_period_key: reviewPeriodKey,
            p_review_key: reviewKey,
            p_kr_index: krIndex,
            p_expected_row_version: expectedRowVersion,
            p_expected_department_row_version: expectedDepartmentRowVersion,
            p_request_id: requestId,
            ...(rootId ? { p_department_root_id: rootId, p_department_node_path: nodePath ?? [] } : {}),
          });
        }
        const rpcName = ['owner_id', 'participant_ids', 'approver_ids']
          .some((field) => Object.prototype.hasOwnProperty.call(dbChanges, field))
          ? 'mcp_update_pad_task_scoped'
          : 'mcp_update_pad_task';
        return callRpc(client, rpcName, {
          p_task_id: taskId,
          p_changes: dbChanges,
          p_expected_row_version: expectedRowVersion,
          p_request_id: requestId,
        });
      });
    },

    async prepareSubmitPadTask({ taskId }) {
      return execute('prepare_submit_pad_task', async (client) => {
        const current = await readTask(client, taskId);
        if (!['draft', 'in-progress', 'paused'].includes(current.status)) {
          throw new AppError('INVALID_ARGUMENT', '当前状态不允许提交。', 400);
        }
        return {
          current,
          expectedRowVersion: normalizeRowVersion(current),
        };
      });
    },

    async commitSubmitPadTask({ taskId, expectedRowVersion, requestId }) {
      return execute('submit_pad_task', (client) => callRpc(client, 'mcp_submit_pad_task', {
        p_task_id: taskId,
        p_expected_row_version: expectedRowVersion,
        p_request_id: requestId,
      }));
    },

    async prepareSaveReviewRecord({ departmentId, periodKey, entry }) {
      return execute('prepare_save_review_record', async (client) => {
        toDbReviewEntry(entry);
        const current = await readDepartment(client, departmentId);
        return {
          current,
          departmentId,
          periodKey,
          entry: structuredClone(entry ?? {}),
          expectedRowVersion: normalizeRowVersion(current),
        };
      });
    },

    async commitSaveReviewRecord({ departmentId, periodKey, entry, expectedRowVersion, rootId, nodePath, requestId }) {
      return execute('save_review_record', (client) => callRpc(client, rootId ? 'mcp_save_review_record_scoped' : 'mcp_save_review_record', {
        p_department_id: departmentId,
        p_period_key: periodKey,
        p_entry: toDbReviewEntry(entry),
        p_expected_row_version: expectedRowVersion,
        p_request_id: requestId,
        ...(rootId ? { p_department_root_id: rootId, p_department_node_path: nodePath ?? [] } : {}),
      }));
    },

    async lookupWriteResult({ toolName, requestId }) {
      return execute('lookup_write_result', async (client, context) => {
        const result = await withTimeout(
          client.from('mcp_write_log')
            .select('status,result_summary')
            .eq('user_id', context.userId)
            .eq('tool_name', toolName)
            .eq('request_id', requestId)
            .maybeSingle(),
          requestTimeoutMs,
        );
        if (result?.error) {
          if (result.error.code === 'PGRST116') return null;
          throw dataAccessError(result.error);
        }
        if (!result?.data) return null;
        return { status: result.data.status, resultSummary: result.data.result_summary ?? {} };
      });
    },

    async recordFailedWrite({ toolName, requestId, action, objectType, objectId, errorCode, beforeSummary }) {
      try {
        await execute('record_failed_write', (client) => callRpc(client, 'mcp_record_failed_write', {
          p_tool_name: toolName,
          p_request_id: requestId,
          p_action: action,
          p_object_type: objectType,
          p_object_id: objectId ?? 'unknown',
          p_error_code: errorCode,
          p_before_summary: beforeSummary ?? null,
        }, { allowEmpty: true }), { logDataAccess: false });
      } catch (error) {
        logger.error?.({ event: 'failed_write_audit_failed', code: error?.code ?? 'UNKNOWN' });
      }
    },
  });
}
