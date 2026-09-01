import { AppError } from '../errors.mjs';
import { getCurrentIsoWeekPeriod } from '../task-period-defaults.mjs';
import {
  MAX_VISIBLE_TASK_SCAN,
  assertResult,
  clampInteger,
  decodeCursor,
  encodeCursor,
  isMissingFunction,
  mapRpcError,
  withTimeout,
} from './internal/repository-helpers.mjs';

const TASK_FIELDS = 'id,created_by,title,status,priority,owner_id,department_id,aligned_kr_id,target_weeks,start_date,due_date,tags,participant_ids,approver_ids,updated_at,row_version';

function mapTaskPerson(person = {}, fallbackId = null) {
  const value = person && typeof person === 'object' ? person : {};
  return {
    id: value.id ?? value.user_id ?? value.userId ?? fallbackId,
    name: value.name ?? null,
    departmentId: value.department_id ?? value.departmentId ?? null,
    departmentName: value.department_name ?? value.departmentName ?? null,
  };
}

function mapTask(row) {
  return {
    id: row.id,
    createdBy: row.created_by ?? row.createdBy ?? null,
    title: row.title,
    status: row.status,
    priority: row.priority,
    ownerId: row.owner_id ?? row.ownerId ?? null,
    ownerName: row.owner_name ?? row.ownerName ?? null,
    ownerDepartmentName: row.owner_department_name ?? row.ownerDepartmentName ?? null,
    departmentId: row.department_id ?? row.departmentId ?? null,
    departmentName: row.department_name ?? row.departmentName ?? null,
    alignedKrId: row.aligned_kr_id ?? row.alignedKrId ?? null,
    targetWeeks: row.target_weeks ?? row.targetWeeks ?? [],
    startDate: row.start_date ?? row.startDate ?? null,
    dueDate: row.due_date ?? row.dueDate ?? null,
    tags: row.tags ?? [],
    participantIds: row.participant_ids ?? row.participantIds ?? [],
    participants: Array.isArray(row.participants) ? row.participants.map((person) => mapTaskPerson(person)) : [],
    approverIds: row.approver_ids ?? row.approverIds ?? [],
    approvers: Array.isArray(row.approvers) ? row.approvers.map((person) => mapTaskPerson(person)) : [],
    relationMatches: row.relation_matches ?? row.relationMatches ?? [],
    updatedAt: row.updated_at ?? row.updatedAt ?? 0,
    rowVersion: row.row_version ?? row.rowVersion ?? 0,
  };
}

function mapDisplayUser(row) {
  const user = row?.user ?? row ?? {};
  return {
    name: user.name ?? '',
    role: user.role ?? '',
    departmentId: user.departmentId ?? user.department_id ?? null,
    departmentName: user.departmentName ?? user.department_name ?? null,
  };
}

function mapUserTaskResult(data, fallbackUser) {
  const value = data && typeof data === 'object' ? data : {};
  return {
    user: mapDisplayUser(value.user ?? fallbackUser),
    tasks: Array.isArray(value.tasks) ? value.tasks.map(mapTask) : [],
    total: Number.isFinite(value.total) ? value.total : null,
    limit: value.limit,
    offset: value.offset,
    hasMore: Boolean(value.hasMore),
    nextCursor: null,
    truncated: Boolean(value.truncated),
  };
}

function monthBounds(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new AppError('INVALID_ARGUMENT');
  }
  const [year, monthNumber] = month.split('-').map(Number);
  const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
  return {
    start: Date.UTC(year, monthNumber - 1, 1) - shanghaiOffsetMs,
    end: Date.UTC(year, monthNumber, 1) - shanghaiOffsetMs,
  };
}

export function createTaskReadRepository({
  execute,
  requestTimeoutMs,
  identityRepository,
  resolveDepartmentInput,
  enrichTaskPeople,
  now = Date.now,
}) {
  async function getVisibleTasks(client) {
    let cursor = {};
    const rows = [];
    for (;;) {
      const result = await withTimeout(client.rpc('mcp_get_visible_tasks_page', {
        p_limit: 50,
        p_cursor_updated_at: cursor.updatedAt ?? null,
        p_cursor_id: cursor.id ?? null,
      }), requestTimeoutMs);
      if (result?.error && isMissingFunction(result.error)) break;
      if (result?.error) throw mapRpcError(result.error);
      const page = result?.data;
      if (!page || typeof page !== 'object' || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
        throw new AppError('DATA_ACCESS_FAILED', '任务分页结果格式错误，请检查数据库迁移。', 502);
      }
      rows.push(...page.items);
      if (!page.hasMore) return { rows, truncated: page.truncated === true };
      const nextCursor = page.nextCursor && typeof page.nextCursor === 'object' ? encodeCursor(page.nextCursor) : null;
      if (!nextCursor || rows.length >= MAX_VISIBLE_TASK_SCAN) {
        return { rows: rows.slice(0, MAX_VISIBLE_TASK_SCAN), truncated: true };
      }
      cursor = decodeCursor(nextCursor);
    }

    const result = await withTimeout(client.rpc('get_visible_tasks_full'), requestTimeoutMs);
    if (result?.error && isMissingFunction(result.error)) return null;
    const fallbackRows = assertResult(result);
    return { rows: fallbackRows.slice(0, MAX_VISIBLE_TASK_SCAN), truncated: fallbackRows.length >= 1000 };
  }

  async function getVisibleTaskPage(client, {
    limit = 50, cursor, departmentId, status, weekId, query,
  } = {}) {
    const cursorValue = decodeCursor(cursor);
    const result = await withTimeout(client.rpc('mcp_get_visible_tasks_page', {
      p_limit: Math.max(clampInteger(limit, 50, 50), 1),
      p_cursor_updated_at: cursorValue.updatedAt ?? null,
      p_cursor_id: cursorValue.id ?? null,
      p_department_id: departmentId ?? null,
      p_status: status ?? null,
      p_week_id: weekId ?? null,
      p_query: query?.trim() || null,
    }), requestTimeoutMs);
    if (result?.error && isMissingFunction(result.error)) return null;
    if (result?.error) throw mapRpcError(result.error);
    const page = result?.data;
    if (!page || typeof page !== 'object' || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
      throw new AppError('DATA_ACCESS_FAILED', '任务分页结果格式错误，请检查数据库迁移。', 502);
    }
    const items = page.items.slice(0, Math.max(clampInteger(limit, 50, 50), 1));
    const nextCursor = page.nextCursor && typeof page.nextCursor === 'object' ? encodeCursor(page.nextCursor) : null;
    const brokenCursor = page.hasMore && !nextCursor;
    return {
      items,
      hasMore: page.hasMore && !brokenCursor,
      nextCursor,
      truncated: page.truncated === true || page.items.length > items.length || brokenCursor,
    };
  }

  async function collectVisibleTaskPages(client, {
    departmentId, status, weekId, query, offset = 0, limit = 50,
  } = {}) {
    let cursor = null;
    const rows = [];
    const targetCount = offset + limit;
    for (;;) {
      const page = await getVisibleTaskPage(client, { limit: 50, cursor, departmentId, status, weekId, query });
      if (!page) return null;
      rows.push(...page.items);
      if (!page.hasMore) {
        return { rows: rows.slice(offset, targetCount), hasMore: false, nextCursor: null, truncated: page.truncated };
      }
      if (rows.length >= targetCount) {
        const selectedRows = rows.slice(offset, targetCount);
        return {
          rows: selectedRows,
          hasMore: true,
          nextCursor: encodeCursor({
            updatedAt: Number(selectedRows.at(-1)?.updated_at ?? selectedRows.at(-1)?.updatedAt),
            id: selectedRows.at(-1)?.id,
          }) ?? page.nextCursor,
          truncated: page.truncated,
        };
      }
      if (!page.nextCursor || rows.length >= MAX_VISIBLE_TASK_SCAN) {
        return { rows: rows.slice(offset, targetCount), hasMore: false, nextCursor: null, truncated: true };
      }
      cursor = page.nextCursor;
    }
  }

  async function getDepartmentTaskPage(client, {
    departmentId, departmentName, scope = 'auto', weekId, query, status, cursor, limit = 50,
    resolvedDepartment,
  } = {}) {
    const resolved = resolvedDepartment
      ?? await resolveDepartmentInput(client, { departmentId, departmentName, scope });
    if (!resolved) throw new AppError('INVALID_ARGUMENT', '请提供部门 ID 或部门名称。');
    const cursorValue = decodeCursor(cursor);
    const result = await withTimeout(client.rpc('mcp_get_department_tasks_page', {
      p_department_id: resolved.id,
      p_scope: resolved.scope,
      p_week_id: weekId ?? null,
      p_query: query?.trim() || null,
      p_status: status ?? null,
      p_limit: Math.max(clampInteger(limit, 50, 50), 1),
      p_cursor_updated_at: cursorValue.updatedAt ?? null,
      p_cursor_id: cursorValue.id ?? null,
    }), requestTimeoutMs);
    if (result?.error && isMissingFunction(result.error)) {
      if (scope !== 'exact' || resolved.scope !== 'exact') throw mapRpcError(result.error);
      return { resolved, page: null };
    }
    if (result?.error) throw mapRpcError(result.error);
    const page = result?.data;
    if (Array.isArray(page)) {
      if (scope !== 'exact' || resolved.scope !== 'exact') throw new AppError('RPC_NOT_CONFIGURED', undefined, 503);
      return { resolved, page: null };
    }
    if (!page || typeof page !== 'object' || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
      throw new AppError('DATA_ACCESS_FAILED', '部门任务分页结果格式错误，请检查数据库迁移。', 502);
    }
    const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
    const items = page.items.slice(0, boundedLimit);
    const nextCursor = page.nextCursor && typeof page.nextCursor === 'object' ? encodeCursor(page.nextCursor) : null;
    return {
      resolved,
      page: {
        items,
        total: Number.isFinite(page.total) ? page.total : null,
        hasMore: page.hasMore === true && Boolean(nextCursor),
        nextCursor,
        truncated: page.truncated === true || page.items.length > items.length || (page.hasMore === true && !nextCursor),
      },
    };
  }

  async function collectDepartmentTaskPages(client, {
    departmentId, departmentName, scope = 'auto', weekId, query, status, offset = 0, limit = 50,
  } = {}) {
    const boundedOffset = clampInteger(offset, 0, 1000);
    const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
    const targetCount = boundedOffset + boundedLimit;
    const rows = [];
    let cursor = null;
    let resolved = null;
    let total = null;
    let truncated = false;

    for (;;) {
      const pageLimit = Math.min(50, Math.max(targetCount - rows.length, 1));
      const result = await getDepartmentTaskPage(client, {
        departmentId, departmentName, scope, weekId, query, status, cursor, limit: pageLimit,
        resolvedDepartment: resolved,
      });
      resolved = result.resolved;
      if (!result.page) return { resolved, page: null };
      const page = result.page;
      if (total === null && Number.isFinite(page.total)) total = page.total;
      rows.push(...page.items);
      truncated ||= page.truncated;

      if (rows.length >= targetCount) {
        const items = rows.slice(boundedOffset, targetCount);
        const hasMore = rows.length > targetCount || page.hasMore;
        const lastItem = items.at(-1);
        const nextCursor = hasMore && lastItem
          ? encodeCursor({ updatedAt: Number(lastItem.updated_at ?? lastItem.updatedAt), id: lastItem.id }) ?? page.nextCursor
          : null;
        return {
          resolved,
          page: { items, total, hasMore: hasMore && Boolean(nextCursor), nextCursor, truncated: truncated || (hasMore && !nextCursor) },
        };
      }
      if (!page.hasMore) {
        return {
          resolved,
          page: { items: rows.slice(boundedOffset, targetCount), total, hasMore: false, nextCursor: null, truncated },
        };
      }
      if (!page.nextCursor || rows.length >= MAX_VISIBLE_TASK_SCAN) {
        return {
          resolved,
          page: { items: rows.slice(boundedOffset, targetCount), total, hasMore: false, nextCursor: null, truncated: true },
        };
      }
      cursor = page.nextCursor;
    }
  }

  return {
    getDepartmentWeeklyPad({ departmentId, departmentName, scope = 'auto', weekId, limit = 50, cursor } = {}) {
      return execute('get_department_weekly_pad', async (client) => {
        const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
        if (!departmentId && departmentName) {
          const scoped = await getDepartmentTaskPage(client, { departmentName, scope, weekId, limit: boundedLimit, cursor });
          if (scoped.page) {
            const rows = await enrichTaskPeople(client, scoped.page.items);
            return {
              departmentId: scoped.resolved.id,
              departmentName: scoped.resolved.name,
              scope: scoped.resolved.scope,
              weekId,
              limit: boundedLimit,
              tasks: rows.map(mapTask),
              hasMore: scoped.page.hasMore,
              nextCursor: scoped.page.nextCursor,
              truncated: scoped.page.truncated,
            };
          }
          departmentId = scoped.resolved.id;
        }
        const scopedPage = await getDepartmentTaskPage(client, { departmentId, scope, weekId, limit: boundedLimit, cursor });
        if (scopedPage.page) {
          const rows = await enrichTaskPeople(client, scopedPage.page.items);
          return {
            departmentId: scopedPage.resolved.id,
            departmentName: scopedPage.resolved.name,
            scope: scopedPage.resolved.scope,
            weekId,
            limit: boundedLimit,
            tasks: rows.map(mapTask),
            hasMore: scopedPage.page.hasMore,
            nextCursor: scopedPage.page.nextCursor,
            truncated: scopedPage.page.truncated,
          };
        }
        let page = await getVisibleTaskPage(client, { limit: boundedLimit, cursor, departmentId, weekId });
        let rows;
        let truncated = false;
        let hasMore = false;
        let nextCursor = null;
        if (page) {
          rows = page.items;
          hasMore = page.hasMore;
          nextCursor = page.nextCursor;
          truncated = page.truncated;
        } else {
          const visible = await getVisibleTasks(client);
          if (visible !== null) {
            const filteredRows = visible.rows
              .filter((row) => row.department_id === departmentId)
              .filter((row) => Array.isArray(row.target_weeks) && row.target_weeks.includes(weekId));
            rows = filteredRows.slice(0, boundedLimit);
            truncated = visible.truncated || filteredRows.length > rows.length;
          }
        }
        if (!rows) {
          const query = client.from('tasks').select(TASK_FIELDS)
            .eq('department_id', departmentId)
            .contains('target_weeks', [weekId])
            .order('updated_at', { ascending: false })
            .limit(boundedLimit);
          rows = assertResult(await withTimeout(query, requestTimeoutMs));
          truncated = rows.length === boundedLimit;
        }
        rows = await enrichTaskPeople(client, rows);
        return { departmentId, weekId, limit: boundedLimit, tasks: rows.map(mapTask), hasMore, nextCursor, truncated, scope };
      });
    },

    searchPadTasks({
      query: search, departmentId, departmentName, status, userName, month,
      relation = 'owner', weekId, scope = 'auto', limit = 20, offset = 0, cursor,
    } = {}) {
      return execute('search_pad_tasks', async (client) => {
        const boundedLimit = Math.max(clampInteger(limit, 20, 50), 1);
        const boundedOffset = clampInteger(offset, 0, 1000);
        if (userName || month || weekId || departmentName || departmentId) {
          if (cursor) throw new AppError('INVALID_ARGUMENT', '姓名/月份查询暂不接受游标，请使用 offset。');
          if (!userName) {
            const scoped = await collectDepartmentTaskPages(client, {
              departmentId, departmentName, scope, weekId, query: search, status,
              offset: boundedOffset, limit: boundedLimit,
            });
            if (scoped.page) {
              const rows = await enrichTaskPeople(client, scoped.page.items);
              return {
                tasks: rows.map(mapTask),
                departmentId: scoped.resolved.id,
                departmentName: scoped.resolved.name,
                scope: scoped.resolved.scope,
                offset: boundedOffset,
                limit: boundedLimit,
                total: Number.isFinite(scoped.page.total) ? scoped.page.total : null,
                hasMore: scoped.page.hasMore,
                nextCursor: scoped.page.nextCursor,
                truncated: scoped.page.truncated,
              };
            }
            if (scope !== 'exact' || scoped.resolved.scope !== 'exact') {
              throw new AppError('RPC_NOT_CONFIGURED', undefined, 503);
            }
            departmentId = scoped.resolved.id;
          } else {
            if (!identityRepository) throw new AppError('INVALID_ARGUMENT');
            if (!['owner', 'participant', 'approver', 'any'].includes(relation)) throw new AppError('INVALID_ARGUMENT');
            const user = await identityRepository.resolveUser({ name: userName, departmentName, purpose: 'query' });
            const bounds = month ? monthBounds(month) : {};
            const result = await withTimeout(client.rpc('mcp_query_user_tasks', {
              p_user_id: user.userId,
              p_relation: relation,
              p_month_start: bounds.start ?? null,
              p_month_end: bounds.end ?? null,
              p_week_id: weekId ?? null,
              p_query: typeof search === 'string' && search.trim() ? search.trim() : null,
              p_status: status ?? null,
              p_limit: boundedLimit,
              p_offset: boundedOffset,
            }), requestTimeoutMs);
            if (result?.error) throw mapRpcError(result.error);
            const data = result?.data && typeof result.data === 'object' ? result.data : {};
            const tasks = await enrichTaskPeople(client, Array.isArray(data.tasks) ? data.tasks : []);
            return mapUserTaskResult({ ...data, tasks }, user);
          }
        }

        let rows;
        let total;
        let truncated = false;
        let hasMore = false;
        let nextCursor = null;
        if (cursor && boundedOffset > 0) throw new AppError('INVALID_ARGUMENT', 'cursor 与 offset 不能同时使用。');
        const paged = boundedOffset === 0
          ? await getVisibleTaskPage(client, { departmentId, status, weekId, query: search, cursor, limit: boundedLimit })
          : await collectVisibleTaskPages(client, {
            departmentId, status, weekId, query: search, offset: boundedOffset, limit: boundedLimit,
          });
        if (paged) {
          rows = paged.rows ?? paged.items;
          hasMore = paged.hasMore;
          nextCursor = paged.nextCursor;
          truncated = paged.truncated;
          total = null;
        } else {
          const visible = await getVisibleTasks(client);
          if (visible !== null) {
            const normalizedSearch = typeof search === 'string' ? search.trim().toLocaleLowerCase() : '';
            const filteredRows = visible.rows
              .filter((row) => !normalizedSearch || String(row.title ?? '').toLocaleLowerCase().includes(normalizedSearch))
              .filter((row) => !departmentId || row.department_id === departmentId)
              .filter((row) => !status || row.status === status);
            total = filteredRows.length;
            rows = filteredRows.slice(boundedOffset, boundedOffset + boundedLimit);
            truncated = visible.truncated;
            hasMore = boundedOffset + rows.length < total || truncated;
          }
        }
        if (!rows) {
          let query = client.from('tasks').select(TASK_FIELDS, { count: 'exact' })
            .order('updated_at', { ascending: false })
            .range(boundedOffset, boundedOffset + boundedLimit - 1);
          if (typeof search === 'string' && search.trim()) query = query.ilike('title', `%${search.trim()}%`);
          if (departmentId) query = query.eq('department_id', departmentId);
          if (status) query = query.eq('status', status);
          if (weekId) query = query.contains('target_weeks', [weekId]);
          const result = await withTimeout(query, requestTimeoutMs);
          rows = assertResult(result);
          total = Number.isFinite(result.count) ? result.count : null;
          hasMore = total === null ? rows.length === boundedLimit : boundedOffset + rows.length < total;
        }
        rows = await enrichTaskPeople(client, rows);
        return { tasks: rows.map(mapTask), offset: boundedOffset, limit: boundedLimit, total, hasMore, nextCursor, truncated };
      });
    },

    getPersonalWorkbench({ limit = 50, todayCursor, thisWeekCursor, nextWeekCursor } = {}) {
      return execute('get_personal_workbench', async (client, context) => {
        const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
        const todayCursorValue = decodeCursor(todayCursor);
        const thisWeekCursorValue = decodeCursor(thisWeekCursor);
        const nextWeekCursorValue = decodeCursor(nextWeekCursor);
        const todayMs = now();
        const currentPeriod = getCurrentIsoWeekPeriod(todayMs);
        const nextPeriod = getCurrentIsoWeekPeriod(todayMs + (24 * 60 * 60 * 1000 * 7));

        let pagedResult = await withTimeout(client.rpc('mcp_get_personal_workbench_page', {
          p_limit: boundedLimit,
          p_today_cursor_updated_at: todayCursorValue.updatedAt ?? null,
          p_today_cursor_id: todayCursorValue.id ?? null,
          p_this_week_id: currentPeriod.weekId,
          p_this_week_cursor_updated_at: thisWeekCursorValue.updatedAt ?? null,
          p_this_week_cursor_id: thisWeekCursorValue.id ?? null,
          p_next_week_id: nextPeriod.weekId,
          p_next_week_cursor_updated_at: nextWeekCursorValue.updatedAt ?? null,
          p_next_week_cursor_id: nextWeekCursorValue.id ?? null,
        }), requestTimeoutMs);
        if (pagedResult?.error && !isMissingFunction(pagedResult.error)) throw mapRpcError(pagedResult.error);

        const hasPagedWorkbenchShape = !pagedResult?.error
          && pagedResult?.data && typeof pagedResult.data === 'object'
          && ['today', 'thisWeek', 'nextWeek'].every((key) => (
            pagedResult.data[key] && typeof pagedResult.data[key] === 'object'
            && Array.isArray(pagedResult.data[key].items)
            && typeof pagedResult.data[key].hasMore === 'boolean'
          ));
        if (!pagedResult?.error && !hasPagedWorkbenchShape) {
          throw new AppError('DATA_ACCESS_FAILED', '工作台分页结果格式错误，请检查数据库迁移。', 502);
        }
        if (hasPagedWorkbenchShape) {
          const data = pagedResult.data;
          const readPage = (key) => {
            const page = data[key] && typeof data[key] === 'object' ? data[key] : {};
            const items = Array.isArray(page.items) ? page.items.slice(0, boundedLimit) : [];
            const cursorValue = page.nextCursor && typeof page.nextCursor === 'object'
              ? encodeCursor({ updatedAt: page.nextCursor.updatedAt, id: page.nextCursor.id })
              : null;
            const brokenCursor = page.hasMore === true && !cursorValue;
            return {
              items,
              hasMore: page.hasMore === true && !brokenCursor,
              nextCursor: cursorValue,
              truncated: page.truncated === true || brokenCursor || (Array.isArray(page.items) && page.items.length > items.length),
            };
          };
          const todayPage = readPage('today');
          const thisWeekPage = readPage('thisWeek');
          const nextWeekPage = readPage('nextWeek');
          const groups = {
            todayTasks: todayPage.items,
            thisWeekTasks: thisWeekPage.items,
            nextWeekTasks: nextWeekPage.items,
          };
          const candidateRows = [...new Map(Object.values(groups).flat().map((row) => [row?.id, row])).values()]
            .filter((row) => row?.id);
          const enriched = await enrichTaskPeople(client, candidateRows);
          const byId = new Map(enriched.map((row) => [row.id, mapTask(row)]));
          const mapGroup = (group) => group.map((row) => byId.get(row.id)).filter(Boolean);
          const todayTasks = mapGroup(groups.todayTasks);
          const thisWeekTasks = mapGroup(groups.thisWeekTasks);
          const nextWeekTasks = mapGroup(groups.nextWeekTasks);
          const tasks = [...new Map([...todayTasks, ...thisWeekTasks, ...nextWeekTasks].map((task) => [task.id, task])).values()];
          return {
            userId: context.userId,
            limit: boundedLimit,
            currentWeekId: currentPeriod.weekId,
            nextWeekId: nextPeriod.weekId,
            todayTasks,
            thisWeekTasks,
            nextWeekTasks,
            tasks,
            pageInfo: {
              today: { hasMore: todayPage.hasMore, nextCursor: todayPage.nextCursor, truncated: todayPage.truncated },
              thisWeek: { hasMore: thisWeekPage.hasMore, nextCursor: thisWeekPage.nextCursor, truncated: thisWeekPage.truncated },
              nextWeek: { hasMore: nextWeekPage.hasMore, nextCursor: nextWeekPage.nextCursor, truncated: nextWeekPage.truncated },
            },
          };
        }

        let result = await withTimeout(client.rpc('get_my_workbench_tasks'), requestTimeoutMs);
        if (result?.error && isMissingFunction(result.error)) {
          const memberJson = JSON.stringify([context.userId]);
          result = await withTimeout(
            client.from('tasks').select(TASK_FIELDS)
              .or(`owner_id.eq.${context.userId},participant_ids.cs.${memberJson},approver_ids.cs.${memberJson}`)
              .order('updated_at', { ascending: false })
              .limit(boundedLimit),
            requestTimeoutMs,
          );
        }
        const rows = assertResult(result);
        const isToday = (row) => {
          const start = row?.start_date ?? row?.startDate;
          const due = row?.due_date ?? row?.dueDate;
          return Number.isFinite(start) && Number.isFinite(due) && todayMs >= start && todayMs <= due;
        };
        const hasWeek = (row, weekId) => {
          const weeks = row?.target_weeks ?? row?.targetWeeks;
          return Array.isArray(weeks) && weeks.includes(weekId);
        };
        const groups = {
          todayTasks: rows.filter(isToday),
          thisWeekTasks: rows.filter((row) => hasWeek(row, currentPeriod.weekId)),
          nextWeekTasks: rows.filter((row) => hasWeek(row, nextPeriod.weekId)),
        };
        const candidateRows = [...new Map(Object.values(groups).flat().map((row) => [row?.id, row])).values()]
          .filter((row) => row?.id);
        const enriched = await enrichTaskPeople(client, candidateRows);
        const byId = new Map(enriched.map((row) => [row.id, mapTask(row)]));
        const mapGroup = (group) => group.map((row) => byId.get(row.id)).filter(Boolean).slice(0, boundedLimit);
        const todayTasks = mapGroup(groups.todayTasks);
        const thisWeekTasks = mapGroup(groups.thisWeekTasks);
        const nextWeekTasks = mapGroup(groups.nextWeekTasks);
        const tasks = [...new Map([...todayTasks, ...thisWeekTasks, ...nextWeekTasks].map((task) => [task.id, task])).values()];
        return {
          userId: context.userId,
          limit: boundedLimit,
          currentWeekId: currentPeriod.weekId,
          nextWeekId: nextPeriod.weekId,
          todayTasks,
          thisWeekTasks,
          nextWeekTasks,
          tasks,
          pageInfo: {
            today: { hasMore: false, nextCursor: null, truncated: false },
            thisWeek: { hasMore: false, nextCursor: null, truncated: false },
            nextWeek: { hasMore: false, nextCursor: null, truncated: false },
          },
        };
      });
    },
  };
}
