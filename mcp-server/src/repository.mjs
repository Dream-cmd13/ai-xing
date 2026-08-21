import { AppError } from './errors.mjs';

const STRATEGY_FIELDS = 'id,mission,vision,customer_issues,employee_issues,company_okrs,updated_at,row_version';
const DEPARTMENT_FIELDS = 'id,name,manager_name,manager_user_id,responsibilities,attributes,sub_departments,okrs,updated_at,row_version';
const BUSINESS_FIELDS = 'id,name,business_format,customer_persona,customer_needs,surface_product_power,core_product_power,updated_at,row_version';
const TASK_FIELDS = 'id,created_by,title,status,priority,owner_id,department_id,aligned_kr_id,target_weeks,start_date,due_date,tags,participant_ids,approver_ids,updated_at,row_version';
const PROCESS_FIELDS = 'id,department_id,created_by,name,category,level,version,is_active,type,owner,co_owner,objective,nodes,links,updated_at,row_version';

function clampInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), maximum);
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

function mapDepartment(row) {
  return {
    id: row.id,
    name: row.name,
    managerName: row.manager_name ?? '',
    managerUserId: row.manager_user_id ?? null,
    responsibilities: row.responsibilities ?? '',
    attributes: row.attributes ?? '',
    subDepartments: row.sub_departments ?? [],
    okrs: row.okrs ?? {},
    updatedAt: row.updated_at ?? 0,
    rowVersion: row.row_version ?? 0,
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
    createdBy: row.created_by ?? null,
    title: row.title,
    status: row.status,
    priority: row.priority,
    ownerId: row.owner_id,
    departmentId: row.department_id ?? null,
    alignedKrId: row.aligned_kr_id ?? null,
    targetWeeks: row.target_weeks ?? [],
    startDate: row.start_date ?? null,
    dueDate: row.due_date ?? null,
    tags: row.tags ?? [],
    participantIds: row.participant_ids ?? [],
    approverIds: row.approver_ids ?? [],
    updatedAt: row.updated_at ?? 0,
    rowVersion: row.row_version ?? 0,
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

export function createReadRepository({ createUserClient, getContext, requestTimeoutMs, logger = console }) {
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
    const result = await withTimeout(client.rpc('get_visible_tasks_full'), requestTimeoutMs);
    if (result?.error && isMissingFunction(result.error)) return null;
    return assertResult(result);
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
          departments: departments.map(mapDepartment),
          businesses: businesses.map(mapBusiness),
        };
      });
    },

    getDepartmentWeeklyPad({ departmentId, weekId, limit = 50 }) {
      return execute('get_department_weekly_pad', async (client) => {
        const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
        let rows = await getVisibleTasks(client);
        if (rows === null) {
          const query = client
            .from('tasks')
            .select(TASK_FIELDS)
            .eq('department_id', departmentId)
            .contains('target_weeks', [weekId])
            .order('updated_at', { ascending: false })
            .limit(boundedLimit);
          rows = assertResult(await withTimeout(query, requestTimeoutMs));
        } else {
          rows = rows
            .filter((row) => row.department_id === departmentId)
            .filter((row) => Array.isArray(row.target_weeks) && row.target_weeks.includes(weekId))
            .slice(0, boundedLimit);
        }
        return { departmentId, weekId, limit: boundedLimit, tasks: rows.map(mapTask) };
      });
    },

    searchPadTasks({ query: search, departmentId, status, limit = 20, offset = 0 } = {}) {
      return execute('search_pad_tasks', async (client) => {
        const boundedLimit = Math.max(clampInteger(limit, 20, 50), 1);
        const boundedOffset = clampInteger(offset, 0, 1000);
        let rows = await getVisibleTasks(client);
        let total;
        if (rows === null) {
          let query = client
            .from('tasks')
            .select(TASK_FIELDS, { count: 'exact' })
            .order('updated_at', { ascending: false })
            .range(boundedOffset, boundedOffset + boundedLimit - 1);
          if (typeof search === 'string' && search.trim()) query = query.ilike('title', `%${search.trim()}%`);
          if (departmentId) query = query.eq('department_id', departmentId);
          if (status) query = query.eq('status', status);
          const result = await withTimeout(query, requestTimeoutMs);
          rows = assertResult(result);
          total = Number.isFinite(result.count) ? result.count : null;
        } else {
          const normalizedSearch = typeof search === 'string' ? search.trim().toLocaleLowerCase() : '';
          const filteredRows = rows
            .filter((row) => !normalizedSearch || String(row.title ?? '').toLocaleLowerCase().includes(normalizedSearch))
            .filter((row) => !departmentId || row.department_id === departmentId)
            .filter((row) => !status || row.status === status);
          total = filteredRows.length;
          rows = filteredRows.slice(boundedOffset, boundedOffset + boundedLimit);
        }
        return {
          tasks: rows.map(mapTask),
          offset: boundedOffset,
          limit: boundedLimit,
          total,
          hasMore: total === null ? rows.length === boundedLimit : boundedOffset + rows.length < total,
        };
      });
    },

    getPersonalWorkbench({ limit = 50 } = {}) {
      return execute('get_personal_workbench', async (client, context) => {
        const boundedLimit = Math.max(clampInteger(limit, 50, 50), 1);
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
        const rows = assertResult(result).slice(0, boundedLimit);
        return { userId: context.userId, limit: boundedLimit, tasks: rows.map(mapTask) };
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
