import { AppError } from '../errors.mjs';
import { clampInteger, mapRpcError, withTimeout } from './internal/repository-helpers.mjs';

function mapDisplayUser(row) {
  const user = row?.user ?? row ?? {};
  return {
    name: user.name ?? '',
    role: user.role ?? '',
    departmentId: user.departmentId ?? user.department_id ?? null,
    departmentName: user.departmentName ?? user.department_name ?? null,
  };
}

function mapReviewGapResult(data) {
  const value = data && typeof data === 'object' ? data : {};
  const groups = Array.isArray(value.groups) ? value.groups.map((group) => ({
    user: mapDisplayUser(group?.user),
    tasks: Array.isArray(group?.tasks) ? group.tasks.map((task) => ({
      id: task?.id,
      title: task?.title ?? '',
      status: task?.status,
      departmentId: task?.departmentId ?? task?.department_id ?? null,
      departmentName: task?.departmentName ?? task?.department_name ?? null,
      targetWeeks: task?.targetWeeks ?? task?.target_weeks ?? [],
      reviewState: task?.reviewState ?? task?.review_state ?? 'missing',
      reviewReason: task?.reviewReason ?? task?.review_reason ?? null,
      taskReview: task?.taskReview ?? task?.task_review ?? '',
      cardEvaluation: task?.cardEvaluation ?? task?.card_evaluation ?? '',
      inconsistent: Boolean(task?.inconsistent),
    })) : [],
  })) : [];
  return {
    weekId: value.weekId ?? value.week_id,
    groups,
    total: Number.isFinite(value.total) ? value.total : groups.reduce((sum, group) => sum + group.tasks.length, 0),
    limit: value.limit,
    offset: value.offset,
    hasMore: Boolean(value.hasMore),
  };
}

export function createReviewGapRepository({ execute, requestTimeoutMs, resolveDepartmentInput }) {
  return {
    getWeeklyReviewGaps({ weekId, departmentId, departmentName, scope = 'auto', limit = 50, offset = 0 } = {}) {
      return execute('get_weekly_review_gaps', async (client) => {
        if (typeof weekId !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(weekId)) {
          throw new AppError('INVALID_ARGUMENT');
        }
        const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
        const boundedOffset = clampInteger(offset, 0, 1000);
        const resolved = (departmentId || departmentName)
          ? await resolveDepartmentInput(client, { departmentId, departmentName, scope })
          : null;
        const result = resolved
          ? await withTimeout(client.rpc('mcp_get_weekly_review_gaps_scope_v2', {
            p_week_id: weekId,
            p_department_id: resolved.id,
            p_scope: resolved.scope,
            p_limit: boundedLimit,
            p_offset: boundedOffset,
          }), requestTimeoutMs)
          : await withTimeout(client.rpc('mcp_get_weekly_review_gaps', {
            p_week_id: weekId,
            p_department_id: null,
            p_limit: boundedLimit,
            p_offset: boundedOffset,
          }), requestTimeoutMs);
        if (result?.error) throw mapRpcError(result.error);
        if (!Array.isArray(result?.data?.groups)) {
          throw new AppError('DATA_ACCESS_FAILED', '复盘缺口结果格式错误，请检查当前版本迁移。', 502);
        }
        return mapReviewGapResult(result.data);
      });
    },
  };
}
