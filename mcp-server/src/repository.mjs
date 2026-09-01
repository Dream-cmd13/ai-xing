import { AppError } from './errors.mjs';
import { getCurrentIsoWeekPeriod } from './task-period-defaults.mjs';

const STRATEGY_FIELDS = 'id,mission,vision,customer_issues,employee_issues,company_okrs,updated_at,row_version';
const DEPARTMENT_FIELDS = 'id,name,manager_name,manager_user_id,responsibilities,attributes,sub_departments,okrs,updated_at,row_version';
const BUSINESS_FIELDS = 'id,name,business_format,customer_persona,customer_needs,surface_product_power,core_product_power,updated_at,row_version';
const TASK_FIELDS = 'id,created_by,title,status,priority,owner_id,department_id,aligned_kr_id,target_weeks,start_date,due_date,tags,participant_ids,approver_ids,updated_at,row_version';
const PROCESS_FIELDS = 'id,department_id,created_by,name,category,level,version,is_active,type,owner,co_owner,objective,nodes,links,updated_at,row_version';
const MAX_VISIBLE_TASK_SCAN = 10_000;

function clampInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), maximum);
}

function decodeCursor(value) {
  if (!value) return {};
  if (typeof value !== 'string' || value.length > 512) throw new AppError('INVALID_ARGUMENT', '分页游标无效。');
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(decoded?.updatedAt) || typeof decoded?.id !== 'string' || decoded.id.length === 0) {
      throw new Error('invalid cursor');
    }
    return { updatedAt: decoded.updatedAt, id: decoded.id };
  } catch {
    throw new AppError('INVALID_ARGUMENT', '分页游标无效。');
  }
}

function encodeCursor(value) {
  if (!value || !Number.isSafeInteger(Number(value.updatedAt)) || typeof value.id !== 'string' || value.id.length === 0) {
    return null;
  }
  return Buffer.from(JSON.stringify({ updatedAt: Number(value.updatedAt), id: value.id })).toString('base64url');
}

function safeDiagnosticCode(error) {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : 'UNKNOWN';
}

function dataAccessError(error, message = '数据读取失败，请稍后重试。', status = 502) {
  const appError = new AppError('DATA_ACCESS_FAILED', message, status);
  appError.diagnosticCode = safeDiagnosticCode(error);
  return appError;
}

function mapRpcError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (isMissingFunction(error)) {
    const result = new AppError('RPC_NOT_CONFIGURED', undefined, 503);
    result.diagnosticCode = 'RPC_NOT_FOUND';
    return result;
  }
  if (message.startsWith('MCP_PERMISSION_DENIED:')) return new AppError('PERMISSION_DENIED');
  if (message.startsWith('MCP_VALIDATION:')) return new AppError('INVALID_ARGUMENT');
  if (message.startsWith('MCP_USER_NOT_FOUND:')) return new AppError('USER_NOT_FOUND');
  if (message.startsWith('MCP_USER_NAME_AMBIGUOUS:')) return new AppError('USER_NAME_AMBIGUOUS');
  if (message.startsWith('MCP_DEPARTMENT_NOT_FOUND:')) return new AppError('DEPARTMENT_NOT_FOUND');
  if (message.startsWith('MCP_DEPARTMENT_NAME_AMBIGUOUS:')) return new AppError('DEPARTMENT_NAME_AMBIGUOUS');
  return dataAccessError(error);
}

function assertResult(result) {
  if (result?.error) throw dataAccessError(result.error);
  return result?.data ?? [];
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(dataAccessError(
      { code: 'TIMEOUT' },
      '数据读取超时，请稍后重试。',
      504,
    )), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function mapStrategy(row) {
  if (!row) return null;
  return {
    id: row.id,
    mission: row.mission ?? '',
    vision: row.vision ?? '',
    customerIssues: row.customer_issues ?? '',
    employeeIssues: row.employee_issues ?? '',
    companyOKRs: row.company_okrs ?? {},
    updatedAt: row.updated_at ?? 0,
    rowVersion: row.row_version ?? 0,
  };
}

function mapDepartment(row, depth = 0, path = new Set()) {
  if (!row || typeof row !== 'object' || depth > 100 || typeof row.id !== 'string' || path.has(row.id)) return null;
  const nextPath = new Set(path);
  nextPath.add(row.id);
  const rawChildren = Array.isArray(row.subDepartments)
    ? row.subDepartments
    : (Array.isArray(row.sub_departments) ? row.sub_departments : []);
  return {
    id: row.id,
    name: row.name,
    managerName: row.managerName ?? row.manager_name ?? '',
    managerUserId: row.managerUserId ?? row.manager_user_id ?? null,
    responsibilities: row.responsibilities ?? '',
    attributes: row.attributes ?? '',
    subDepartments: rawChildren
      .map((child) => mapDepartment(child, depth + 1, nextPath))
      .filter(Boolean),
    okrs: row.okrs ?? {},
    updatedAt: row.updatedAt ?? row.updated_at ?? 0,
    rowVersion: row.rowVersion ?? row.row_version ?? 0,
  };
}

function mapBusiness(row) {
  return {
    id: row.id,
    name: row.name,
    businessFormat: row.business_format ?? '',
    customerPersona: row.customer_persona ?? '',
    customerNeeds: row.customer_needs ?? '',
    surfaceProductPower: row.surface_product_power ?? '',
    coreProductPower: row.core_product_power ?? '',
    updatedAt: row.updated_at ?? 0,
    rowVersion: row.row_version ?? 0,
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

function mapTaskPerson(person = {}, fallbackId = null) {
  const value = person && typeof person === 'object' ? person : {};
  return {
    id: value.id ?? value.user_id ?? value.userId ?? fallbackId,
    name: value.name ?? null,
    departmentId: value.department_id ?? value.departmentId ?? null,
    departmentName: value.department_name ?? value.departmentName ?? null,
  };
}

function mapResolvedUser(row) {
  const user = row?.user ?? row ?? {};
  return {
    userId: user.userId ?? user.user_id ?? null,
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
    tasks: Array.isArray(value.tasks) ? value.tasks.map(mapScopedTask) : [],
    total: Number.isFinite(value.total) ? value.total : null,
    limit: value.limit,
    offset: value.offset,
    hasMore: Boolean(value.hasMore),
    nextCursor: null,
    truncated: Boolean(value.truncated),
  };
}

function mapDisplayUser(row) {
  const user = mapResolvedUser(row);
  const { userId: _userId, ...display } = user;
  return display;
}

function mapScopedTask(row) {
  return mapTask(row);
}

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


function mapProcess(row) {
  return {
    id: row.id,
    departmentId: row.department_id ?? null,
    createdBy: row.created_by ?? null,
    name: row.name,
    category: row.category,
    level: row.level,
    version: row.version,
    isActive: row.is_active,
    type: row.type,
    owner: row.owner ?? '',
    coOwner: row.co_owner ?? '',
    objective: row.objective ?? '',
    nodes: row.nodes ?? [],
    links: row.links ?? [],
    updatedAt: row.updated_at ?? 0,
    rowVersion: row.row_version ?? 0,
  };
}

function isMissingFunction(error) {
  return error?.code === 'PGRST202' || error?.code === '42883' || error?.message?.includes('Could not find the function');
}

export function createReadRepository({ createUserClient, getContext, requestTimeoutMs, logger = console, identityRepository, now = Date.now }) {
  async function execute(operationName, operation) {
    try {
      const context = getContext();
      if (!context?.accessToken) throw new AppError('SESSION_EXPIRED', '登录会话已失效，请重新连接。', 401);
      const client = createUserClient(context.accessToken);
      return await operation(client, context);
    } catch (error) {
      const publicError = error instanceof AppError ? error : dataAccessError(error);
      if (publicError.code === 'DATA_ACCESS_FAILED') {
        logger.error?.({
          event: 'supabase_query_failed',
          operation: operationName,
          code: publicError.diagnosticCode ?? 'UNKNOWN',
        });
      }
      throw publicError;
    }
  }

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
      if (!page || typeof page !== 'object' || !Array.isArray(page.items)
        || typeof page.hasMore !== 'boolean') {
        throw new AppError('DATA_ACCESS_FAILED', '任务分页结果格式错误，请检查数据库迁移。', 502);
      }
      rows.push(...page.items);
      if (!page.hasMore) return { rows, truncated: page.truncated === true };
      const nextCursor = page.nextCursor && typeof page.nextCursor === 'object'
        ? encodeCursor(page.nextCursor) : null;
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
    if (!page || typeof page !== 'object' || !Array.isArray(page.items)
      || typeof page.hasMore !== 'boolean') {
      throw new AppError('DATA_ACCESS_FAILED', '任务分页结果格式错误，请检查数据库迁移。', 502);
    }
    const items = page.items.slice(0, Math.max(clampInteger(limit, 50, 50), 1));
    const nextCursor = page.nextCursor && typeof page.nextCursor === 'object'
      ? encodeCursor(page.nextCursor) : null;
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
      const page = await getVisibleTaskPage(client, {
        limit: 50,
        cursor,
        departmentId,
        status,
        weekId,
        query,
      });
      if (!page) return null;
      rows.push(...page.items);
      if (!page.hasMore) {
        return {
          rows: rows.slice(offset, targetCount),
          hasMore: false,
          nextCursor: null,
          truncated: page.truncated,
        };
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
        return {
          rows: rows.slice(offset, targetCount),
          hasMore: false,
          nextCursor: null,
          truncated: true,
        };
      }
      cursor = page.nextCursor;
    }
  }

  async function resolveDepartmentInput(client, { departmentId, departmentName, scope = 'auto' } = {}) {
    if (!departmentId && !departmentName) return null;
    if (!['auto', 'exact', 'subtree'].includes(scope)) throw new AppError('INVALID_ARGUMENT');
    if (identityRepository?.resolveDepartment) {
      return identityRepository.resolveDepartment({ name: departmentName, id: departmentId, scope });
    }
    const result = await withTimeout(client.rpc('mcp_resolve_department', {
      p_department_name: departmentName?.trim() || null,
      p_department_id: departmentId?.trim() || null,
      p_scope: scope,
    }), requestTimeoutMs);
    if (result?.error) throw mapRpcError(result.error);
    const value = result?.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : null;
    if (!value && departmentId) {
      return { id: departmentId.trim(), name: '', scope, ids: [departmentId.trim()] };
    }
    if (!value && departmentName) {
      const legacy = await withTimeout(
        client.from('departments').select('id,name').eq('name', departmentName.trim()),
        requestTimeoutMs,
      );
      if (legacy?.error) throw dataAccessError(legacy.error);
      const rows = Array.isArray(legacy?.data) ? legacy.data : [];
      if (rows.length === 0) throw new AppError('DEPARTMENT_NOT_FOUND');
      if (rows.length > 1) throw new AppError('DEPARTMENT_NAME_AMBIGUOUS', undefined, 400, { candidates: rows.slice(0, 20) });
      return { id: rows[0].id, name: rows[0].name, scope, ids: [rows[0].id] };
    }
    if (!value || value.ambiguous === true) {
      const error = new AppError('DEPARTMENT_NAME_AMBIGUOUS');
      if (Array.isArray(value?.candidates)) error.details = { candidates: value.candidates.slice(0, 20) };
      throw error;
    }
    const node = value.department ?? value.node ?? value;
    if (!node || typeof node.id !== 'string' || typeof node.name !== 'string') throw new AppError('DATA_ACCESS_FAILED');
    return {
      id: node.id,
      name: node.name,
      scope: value.scope === 'exact' || value.scope === 'subtree' ? value.scope : scope,
      ids: Array.isArray(value.ids) ? value.ids.filter((item) => typeof item === 'string') : [node.id],
      ...node,
    };
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
    if (result?.error && isMissingFunction(result.error)) return { resolved, page: null };
    if (result?.error) throw mapRpcError(result.error);
    const page = result?.data;
    if (Array.isArray(page)) return { resolved, page: null };
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
        departmentId,
        departmentName,
        scope,
        weekId,
        query,
        status,
        cursor,
        limit: pageLimit,
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
          ? encodeCursor({
            updatedAt: Number(lastItem.updated_at ?? lastItem.updatedAt),
            id: lastItem.id,
          }) ?? page.nextCursor
          : null;
        return {
          resolved,
          page: {
            items,
            total,
            hasMore: hasMore && Boolean(nextCursor),
            nextCursor,
            truncated: truncated || (hasMore && !nextCursor),
          },
        };
      }

      if (!page.hasMore) {
        return {
          resolved,
          page: {
            items: rows.slice(boundedOffset, targetCount),
            total,
            hasMore: false,
            nextCursor: null,
            truncated,
          },
        };
      }

      if (!page.nextCursor || rows.length >= MAX_VISIBLE_TASK_SCAN) {
        return {
          resolved,
          page: {
            items: rows.slice(boundedOffset, targetCount),
            total,
            hasMore: false,
            nextCursor: null,
            truncated: true,
          },
        };
      }
      cursor = page.nextCursor;
    }
  }

  async function getScopedDepartmentResult(client, name, args, fallbackName, fallbackArgs, isUsable = (value) => value?.data !== undefined) {
    const scoped = await withTimeout(client.rpc(name, args), requestTimeoutMs);
    if (!scoped?.error && isUsable(scoped)) return scoped;
    if (scoped?.error && !isMissingFunction(scoped.error)) throw mapRpcError(scoped.error);
    const fallback = await withTimeout(client.rpc(fallbackName, fallbackArgs), requestTimeoutMs);
    if (fallback?.error) throw mapRpcError(fallback.error);
    return fallback;
  }

  async function enrichTaskPeople(client, rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const taskIds = [...new Set(rows.map((row) => row?.id).filter(Boolean))];
    const entries = [];
    for (let start = 0; start < taskIds.length; start += 50) {
      const batch = taskIds.slice(start, start + 50);
      const result = await withTimeout(
        client.rpc('mcp_get_task_people', { p_task_ids: batch }),
        requestTimeoutMs,
      );
      if (result?.error && isMissingFunction(result.error)) {
        const error = new AppError('RPC_NOT_CONFIGURED', '任务人员信息功能尚未启用，请先完成本地测试库迁移后重试。', 503);
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
  }

  return Object.freeze({
    getOrganizationInfo() {
      return execute('get_organization_info', async (client) => {
        const [strategyResult, departmentsResult, businessesResult] = await withTimeout(Promise.all([
          client.from('strategy').select(STRATEGY_FIELDS).eq('id', 'default').maybeSingle(),
          client.from('departments').select(DEPARTMENT_FIELDS).order('name', { ascending: true }),
          client.from('businesses').select(BUSINESS_FIELDS).order('name', { ascending: true }),
        ]), requestTimeoutMs);

        const strategy = assertResult(strategyResult);
        const departments = assertResult(departmentsResult);
        const businesses = assertResult(businessesResult);
        return {
          strategy: mapStrategy(strategy),
          departments: departments.map((row) => mapDepartment(row)).filter(Boolean),
          businesses: businesses.map(mapBusiness),
        };
      });
    },

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
        let page = await getVisibleTaskPage(client, {
          limit: boundedLimit, cursor, departmentId, weekId,
        });
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
          const query = client
            .from('tasks')
            .select(TASK_FIELDS)
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
              departmentId,
              departmentName,
              scope,
              weekId,
              query: search,
              status,
              offset: boundedOffset,
              limit: boundedLimit,
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
            if (scoped.resolved.scope === 'subtree' || scope === 'subtree') {
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
          ? await getVisibleTaskPage(client, {
            departmentId, status, weekId, query: search, cursor, limit: boundedLimit,
          })
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
          let query = client
            .from('tasks')
            .select(TASK_FIELDS, { count: 'exact' })
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
        return {
          tasks: rows.map(mapTask),
          offset: boundedOffset,
          limit: boundedLimit,
          total,
          hasMore,
          nextCursor,
          truncated,
        };
      });
    },

    getWeeklyReviewGaps({ weekId, departmentId, departmentName, scope = 'auto', limit = 50, offset = 0 } = {}) {
      return execute('get_weekly_review_gaps', async (client) => {
        if (typeof weekId !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(weekId)) {
          throw new AppError('INVALID_ARGUMENT');
        }
        const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
        const boundedOffset = clampInteger(offset, 0, 1000);
        const resolvedDepartment = (departmentId || departmentName)
          ? await resolveDepartmentInput(client, { departmentId, departmentName, scope })
          : null;
        const resolvedDepartmentId = resolvedDepartment?.id ?? null;
        const result = resolvedDepartmentId
          ? await getScopedDepartmentResult(
            client,
            'mcp_get_weekly_review_gaps_scope_v2',
            {
              p_week_id: weekId,
              p_department_id: resolvedDepartmentId,
              p_scope: resolvedDepartment?.scope ?? scope,
              p_limit: boundedLimit,
              p_offset: boundedOffset,
            },
            'mcp_get_weekly_review_gaps',
            {
              p_week_id: weekId,
              p_department_id: resolvedDepartmentId,
              p_limit: boundedLimit,
              p_offset: boundedOffset,
            },
            (value) => Array.isArray(value?.data?.groups),
          )
          : await withTimeout(client.rpc('mcp_get_weekly_review_gaps', {
            p_week_id: weekId,
            p_department_id: null,
            p_limit: boundedLimit,
            p_offset: boundedOffset,
          }), requestTimeoutMs);
        if (result?.error) throw mapRpcError(result.error);
        return mapReviewGapResult(result?.data);
      });
    },

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
        const resolvedDepartment = (departmentId || departmentName)
          ? await resolveDepartmentInput(client, { departmentId, departmentName, scope })
          : null;
        const resolvedDepartmentId = resolvedDepartment?.id ?? null;
        const okrArgs = {
          p_department_id: resolvedDepartmentId,
          p_scope: resolvedDepartment?.scope ?? scope,
          p_year: Number.isInteger(year) ? year : null,
          p_period: period ?? null,
          p_include_tasks: includeTasks !== false,
          p_limit: boundedLimit,
        };
        const result = resolvedDepartmentId
          ? await getScopedDepartmentResult(
            client,
            'mcp_get_department_okrs_scope_v2',
            okrArgs,
            'mcp_get_department_okrs',
            {
              p_department_id: resolvedDepartmentId,
              p_year: okrArgs.p_year,
              p_period: okrArgs.p_period,
              p_include_tasks: okrArgs.p_include_tasks,
              p_limit: okrArgs.p_limit,
            },
            (value) => Array.isArray(value?.data?.departments),
          )
          : await withTimeout(client.rpc('mcp_get_department_okrs', {
            p_department_id: null,
            p_year: okrArgs.p_year,
            p_period: okrArgs.p_period,
            p_include_tasks: okrArgs.p_include_tasks,
            p_limit: okrArgs.p_limit,
          }), requestTimeoutMs);
        if (result?.error) throw mapRpcError(result.error);
        return mapDepartmentOkrResult({ ...result?.data, limit: boundedLimit });
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
          const data = pagedResult?.data && typeof pagedResult.data === 'object' ? pagedResult.data : {};
          const readPage = (key) => {
            const page = data[key] && typeof data[key] === 'object' ? data[key] : {};
            const items = Array.isArray(page.items) ? page.items.slice(0, boundedLimit) : [];
            const cursor = page.nextCursor && typeof page.nextCursor === 'object'
              ? encodeCursor({ updatedAt: page.nextCursor.updatedAt, id: page.nextCursor.id })
              : null;
            const brokenCursor = page.hasMore === true && !cursor;
            return {
              items,
              hasMore: page.hasMore === true && !brokenCursor,
              nextCursor: cursor,
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
          const candidateRows = [...new Map(
            Object.values(groups).flat().map((row) => [row?.id, row]),
          ).values()].filter((row) => row?.id);
          const enriched = await enrichTaskPeople(client, candidateRows);
          const byId = new Map(enriched.map((row) => [row.id, mapTask(row)]));
          const mapGroup = (group) => group.map((row) => byId.get(row.id)).filter(Boolean);
          const todayTasks = mapGroup(groups.todayTasks);
          const thisWeekTasks = mapGroup(groups.thisWeekTasks);
          const nextWeekTasks = mapGroup(groups.nextWeekTasks);
          const tasks = [...new Map(
            [...todayTasks, ...thisWeekTasks, ...nextWeekTasks].map((task) => [task.id, task]),
          ).values()];
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
            client
              .from('tasks')
              .select(TASK_FIELDS)
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
        const candidateRows = [...new Map(
          Object.values(groups).flat().map((row) => [row?.id, row]),
        ).values()].filter((row) => row?.id);
        const enriched = await enrichTaskPeople(client, candidateRows);
        const byId = new Map(enriched.map((row) => [row.id, mapTask(row)]));
        const mapGroup = (group) => group
          .map((row) => byId.get(row.id))
          .filter(Boolean)
          .slice(0, boundedLimit);
        const todayTasks = mapGroup(groups.todayTasks);
        const thisWeekTasks = mapGroup(groups.thisWeekTasks);
        const nextWeekTasks = mapGroup(groups.nextWeekTasks);
        const tasks = [...new Map(
          [...todayTasks, ...thisWeekTasks, ...nextWeekTasks].map((task) => [task.id, task]),
        ).values()];
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

    getProcessSipoc({ processId, departmentId, limit = 20 } = {}) {
      return execute('get_process_sipoc', async (client) => {
        const boundedLimit = Math.max(clampInteger(limit, 20, 20), 1);
        let query = client
          .from('processes')
          .select(PROCESS_FIELDS)
          .order('updated_at', { ascending: false })
          .limit(boundedLimit);
        if (processId) query = query.eq('id', processId);
        if (departmentId) query = query.eq('department_id', departmentId);
        const rows = assertResult(await withTimeout(query, requestTimeoutMs));
        return { limit: boundedLimit, processes: rows.map(mapProcess) };
      });
    },
  });
}
