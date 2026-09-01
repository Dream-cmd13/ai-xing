import { AppError } from '../errors.mjs';
import {
  clampInteger,
  isMissingFunction,
  mapRpcError,
  withTimeout,
} from './internal/repository-helpers.mjs';

function mapTaskPerson(person = {}, fallbackId = null) {
  const value = person && typeof person === 'object' ? person : {};
  return {
    id: value.id ?? value.user_id ?? value.userId ?? fallbackId,
    name: value.name ?? null,
    departmentId: value.department_id ?? value.departmentId ?? null,
    departmentName: value.department_name ?? value.departmentName ?? null,
  };
}

export function createTaskPeopleReader({ requestTimeoutMs }) {
  return async function enrichTaskPeople(client, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const taskIds = [...new Set(rows.map((row) => row?.id).filter(Boolean))];
    const entries = [];
    for (let start = 0; start < taskIds.length; start += 50) {
      const batch = taskIds.slice(start, start + 50);
      const result = await withTimeout(client.rpc('mcp_get_task_people', { p_task_ids: batch }), requestTimeoutMs);
      if (result?.error && isMissingFunction(result.error)) {
        const error = new AppError('RPC_NOT_CONFIGURED', '任务人员信息功能尚未启用，请先完成当前版本迁移后重试。', 503);
        error.diagnosticCode = 'RPC_NOT_FOUND';
        throw error;
      }
      if (result?.error) throw mapRpcError(result.error);
      if (Array.isArray(result?.data?.tasks)) entries.push(...result.data.tasks);
    }
    const byTaskId = new Map(entries.map((entry) => [entry?.task_id ?? entry?.taskId, entry]));
    return rows.flatMap((row) => {
      const people = byTaskId.get(row.id);
      if (!people) return [];
      const owner = mapTaskPerson(people.owner, row.owner_id ?? row.ownerId ?? null);
      const participants = Array.isArray(people.participants)
        ? people.participants.map((person) => mapTaskPerson(person)) : [];
      const approvers = Array.isArray(people.approvers)
        ? people.approvers.map((person) => mapTaskPerson(person)) : [];
      return [{
        ...row,
        owner_id: row.owner_id ?? row.ownerId ?? owner.id,
        owner_name: owner.name,
        owner_department_name: owner.departmentName,
        participant_ids: row.participant_ids ?? row.participantIds ?? participants.map((person) => person.id),
        participants,
        approver_ids: row.approver_ids ?? row.approverIds ?? approvers.map((person) => person.id),
        approvers,
      }];
    });
  };
}

export function createTaskPeopleRepository({ execute, requestTimeoutMs, resolveDepartmentInput }) {
  return {
    getDepartmentPeople({ departmentId, departmentName, scope = 'auto', limit = 50, cursorName, cursorId } = {}) {
      return execute('get_department_people', async (client) => {
        const resolved = await resolveDepartmentInput(client, { departmentId, departmentName, scope });
        if (!resolved) throw new AppError('INVALID_ARGUMENT');
        const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
        const result = await withTimeout(client.rpc('mcp_get_department_people', {
          p_department_id: resolved.id,
          p_scope: resolved.scope,
          p_limit: boundedLimit,
          p_cursor_name: cursorName ?? null,
          p_cursor_id: cursorId ?? null,
        }), requestTimeoutMs);
        if (result?.error) throw mapRpcError(result.error);
        const data = result?.data && typeof result.data === 'object' ? result.data : {};
        if (!Array.isArray(data.people)) throw new AppError('DATA_ACCESS_FAILED', '部门人员结果格式错误，请检查数据库迁移。', 502);
        return {
          departmentId: resolved.id,
          departmentName: resolved.name || data.department?.name || null,
          scope: data.scope === 'exact' || data.scope === 'subtree' ? data.scope : resolved.scope,
          people: data.people.map((person) => ({
            id: person?.id ?? person?.user_id ?? null,
            name: person?.name ?? null,
            username: person?.username ?? null,
            role: person?.role ?? null,
            departmentId: person?.department_id ?? person?.departmentId ?? null,
            departmentName: person?.department_name ?? person?.departmentName ?? null,
          })),
          hasMore: Boolean(data.hasMore),
        };
      });
    },
  };
}
