import { AppError } from '../errors.mjs';
import { clampInteger, mapRpcError, withTimeout } from './internal/repository-helpers.mjs';

function mapOkrTask(task) {
  return {
    id: task?.id,
    title: task?.title ?? '',
    status: task?.status,
    ownerId: task?.ownerId ?? task?.owner_id ?? null,
    ownerName: task?.ownerName ?? task?.owner_name ?? null,
    departmentId: task?.departmentId ?? task?.department_id ?? null,
    departmentName: task?.departmentName ?? task?.department_name ?? null,
    targetWeeks: Array.isArray(task?.targetWeeks ?? task?.target_weeks) ? (task.targetWeeks ?? task.target_weeks) : [],
    startDate: task?.startDate ?? task?.start_date ?? null,
    dueDate: task?.dueDate ?? task?.due_date ?? null,
  };
}

function mapKrTasks(krTasks) {
  if (!Array.isArray(krTasks)) return [];
  return krTasks.map((entry) => ({
    krIndex: entry?.krIndex,
    krText: entry?.krText ?? '',
    taskCount: Number.isFinite(entry?.taskCount) ? entry.taskCount : (Array.isArray(entry?.tasks) ? entry.tasks.length : 0),
    tasks: Array.isArray(entry?.tasks) ? entry.tasks.map(mapOkrTask) : [],
    tasksTruncated: entry?.tasksTruncated === true,
  }));
}

function mapOkr(okr) {
  const dataQuality = okr?.dataQuality && typeof okr.dataQuality === 'object'
    ? {
      valid: okr.dataQuality.valid !== false,
      issues: Array.isArray(okr.dataQuality.issues)
        ? okr.dataQuality.issues.filter((item) => typeof item === 'string').slice(0, 20)
        : [],
    }
    : undefined;
  return {
    id: okr?.id,
    objective: okr?.objective ?? '',
    keyResults: Array.isArray(okr?.keyResults) ? okr.keyResults : [],
    krCount: Number.isFinite(okr?.krCount) ? okr.krCount : (Array.isArray(okr?.keyResults) ? okr.keyResults.length : 0),
    truncated: okr?.truncated === true,
    krTasks: mapKrTasks(okr?.krTasks),
    ...(dataQuality ? { dataQuality } : {}),
  };
}

function mapCompanyOkrResult(data) {
  const value = data && typeof data === 'object' ? data : {};
  return {
    year: Number.isFinite(value.year) ? value.year : null,
    okrCount: Number.isFinite(value.okrCount) ? value.okrCount : 0,
    okrs: Array.isArray(value.okrs) ? value.okrs.map(mapOkr) : [],
  };
}

function mapDepartmentOkrResult(data) {
  const value = data && typeof data === 'object' ? data : {};
  return {
    year: Number.isFinite(value.year) ? value.year : null,
    period: value.period ?? null,
    departmentCount: Number.isFinite(value.departmentCount) ? value.departmentCount : 0,
    hasMore: value.hasMore === true,
    limit: value.limit,
    departments: Array.isArray(value.departments) ? value.departments.map((department) => ({
      id: department?.id,
      name: department?.name ?? '',
      managerName: department?.managerName ?? '',
      parentName: department?.parentName ?? null,
      periods: Object.fromEntries(Object.entries(department?.periods ?? {}).map(([period, okrs]) => (
        [period, Array.isArray(okrs) ? okrs.map(mapOkr) : []]
      ))),
    })) : [],
  };
}

export function createOkrRepository({ execute, requestTimeoutMs, resolveDepartmentInput }) {
  return {
    getCompanyOkrs({ year, includeTasks = true } = {}) {
      return execute('get_company_okrs', async (client) => {
        const result = await withTimeout(client.rpc('mcp_get_company_okrs', {
          p_year: Number.isInteger(year) ? year : null,
          p_include_tasks: includeTasks !== false,
        }), requestTimeoutMs);
        if (result?.error) throw mapRpcError(result.error);
        return mapCompanyOkrResult(result?.data);
      });
    },

    getDepartmentOkrs({ departmentId, departmentName, scope = 'auto', year, period, includeTasks = true, limit = 20 } = {}) {
      return execute('get_department_okrs', async (client) => {
        const boundedLimit = Math.max(clampInteger(limit, 20, 50), 1);
        const resolved = (departmentId || departmentName)
          ? await resolveDepartmentInput(client, { departmentId, departmentName, scope })
          : null;
        const args = {
          p_department_id: resolved?.id ?? null,
          p_scope: resolved?.scope ?? scope,
          p_year: Number.isInteger(year) ? year : null,
          p_period: period ?? null,
          p_include_tasks: includeTasks !== false,
          p_limit: boundedLimit,
        };
        const result = resolved
          ? await withTimeout(client.rpc('mcp_get_department_okrs_scope_v2', args), requestTimeoutMs)
          : await withTimeout(client.rpc('mcp_get_department_okrs', {
            p_department_id: null,
            p_year: args.p_year,
            p_period: args.p_period,
            p_include_tasks: args.p_include_tasks,
            p_limit: args.p_limit,
          }), requestTimeoutMs);
        if (result?.error) throw mapRpcError(result.error);
        if (!Array.isArray(result?.data?.departments)) {
          throw new AppError('DATA_ACCESS_FAILED', '部门 OKR 结果格式错误，请检查当前版本迁移。', 502);
        }
        return mapDepartmentOkrResult({ ...result.data, limit: boundedLimit });
      });
    },
  };
}
