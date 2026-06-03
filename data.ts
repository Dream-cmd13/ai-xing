
import { AppState, User, Department, ProcessDefinition, CompanyStrategy, BusinessDefinition, SystemRole, PADEntry, AIModelConfig, AISettings, UserRole } from "./types";
import { isSupabaseConfigured, supabase } from "./supabase";
import { isMissingTaskReviewColumnError, omitTaskReviewColumns, stripTaskReviewFieldsFromSelect } from "./utils/taskSchemaCompat";

/**
 * StratFlow AI 数据持久化层 (Data Access Layer) - Supabase Relational Version (Single Tenant)
 */

const handleSupabaseError = (error: any) => {
  const message =
    error?.message ||
    (typeof error === 'string' && error.trim().length > 0 ? error : "未知数据库错误");
  const isNetworkError = 
    message.includes('Failed to fetch') || 
    message.includes('network error') ||
    error?.name === 'TypeError' ||
    message.includes('TypeError');

  if (isNetworkError) {
    throw new Error("网络连接失败或 Supabase URL 配置错误。请检查 VITE_SUPABASE_URL 是否正确，以及网络是否畅通。");
  }
  throw new Error(message || "未知数据库错误");
};

const buildConflictError = (entityLabel: string) =>
  new Error(`${entityLabel}已被其他人修改，请先刷新最新数据后再重试。`);

const buildDeleteConflictError = (entityLabel: string) =>
  new Error(`${entityLabel}已被其他人修改或删除，请先刷新最新数据后再重试。`);

const buildPermissionError = (entityLabel: string) =>
  new Error(`您暂无权限保存${entityLabel}，请联系管理员检查权限配置。`);

const buildDuplicateCreateError = (entityLabel: string) =>
  new Error(`${entityLabel}创建失败，可能是重复提交或记录已存在。`);

const normalizeRowVersion = (value: any) =>
  typeof value === 'number' ? value : Number(value || 0);

const normalizeUpdatedAt = (value: any) =>
  typeof value === 'number' ? value : Number(value || Date.now());

const normalizeUserRole = (value: any): UserRole => {
  if (value === 'Admin' || value === 'Manager' || value === 'Employee') return value;
  return 'Employee';
};

const normalizeStringArray = (value: any): string[] | undefined => {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return [value];
  }

  return undefined;
};

const normalizeObject = <T extends Record<string, any>>(value: any): T | undefined => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  return undefined;
};

const DEFAULT_AI_CONFIGS: AIModelConfig[] = [
  { id: 'gemini', name: 'Gemini 2.5 Flash', type: 'gemini', modelName: 'gemini-2.5-flash' },
  { id: 'deepseek', name: 'DeepSeek V4 Flash', type: 'deepseek', modelName: 'deepseek-v4-flash' }
];

const sanitizeAIConfigs = (configs: any): AIModelConfig[] => {
  if (!Array.isArray(configs)) {
    return DEFAULT_AI_CONFIGS;
  }

  const sanitized = configs
    .filter((config): config is Record<string, any> => Boolean(config && typeof config === 'object'))
    .map((config) => {
      const type = config.type === 'deepseek' ? 'deepseek' : 'gemini';
      return {
        id: typeof config.id === 'string' && config.id.trim() ? config.id.trim() : type,
        name:
          typeof config.name === 'string' && config.name.trim()
            ? config.name.trim()
            : type === 'deepseek'
              ? 'DeepSeek V4 Flash'
              : 'Gemini 2.5 Flash',
        type,
        modelName:
          typeof config.modelName === 'string' && config.modelName.trim()
            ? config.modelName.trim()
            : type === 'deepseek'
              ? 'deepseek-v4-flash'
              : 'gemini-2.5-flash'
      } satisfies AIModelConfig;
    });

  return sanitized.length > 0 ? sanitized : DEFAULT_AI_CONFIGS;
};

const mapSettingsRow = (settingsData: any): AISettings => ({
  selectedModelId: settingsData?.ai_settings?.selectedModelId || 'gemini',
  configs: sanitizeAIConfigs(settingsData?.ai_settings?.configs),
  updatedAt: settingsData?.updated_at,
  rowVersion: normalizeRowVersion(settingsData?.row_version)
});

const mapUserRow = (u: any): User => {
  const reviewsMap: Record<string, any[]> = {};
  if (normalizeObject(u.reviews)) {
    Object.assign(reviewsMap, u.reviews);
  }

  return {
    id: u.id,
    auth_id: u.auth_id,
    username: u.username,
    name: u.name,
    role: normalizeUserRole(u.role),
    departmentId: u.department_id,
    padPermissions: normalizeStringArray(u.pad_permissions),
    reviews: reviewsMap,
    systemRoleIds: normalizeStringArray(u.system_role_ids),
    customPermissions: normalizeObject(u.custom_permissions),
    updatedAt: u.updated_at,
    rowVersion: normalizeRowVersion(u.row_version)
  };
};

const mapDepartmentRow = (d: any): Department => {
  const roleMembers: Record<string, string[]> = {};
  if (d.role_members) {
    Object.assign(roleMembers, d.role_members);
  }

  const reviewsMap: Record<string, any[]> = {};
  if (d.reviews) {
    Object.assign(reviewsMap, d.reviews);
  }

  return {
    id: d.id,
    name: d.name,
    managerName: d.manager_name ?? '',
    managerUserId: d.manager_user_id ?? undefined,
    responsibilities: d.responsibilities ?? '',
    roles: d.roles || [],
    roleMembers,
    attributes: d.attributes ?? '',
    subDepartments: d.sub_departments || [],
    okrs: d.okrs || {},
    reviews: reviewsMap,
    updatedAt: d.updated_at,
    rowVersion: normalizeRowVersion(d.row_version)
  };
};

const mapProcessRow = (p: any): ProcessDefinition => ({
  id: p.id,
  departmentId: p.department_id ?? undefined,
  createdBy: p.created_by ?? undefined,
  name: p.name,
  category: p.category,
  level: p.level,
  version: p.version,
  isActive: p.is_active,
  type: p.type,
  owner: p.owner ?? '',
  coOwner: p.co_owner ?? '',
  objective: p.objective ?? '',
  nodes: p.nodes || [],
  links: p.links || [],
  history: p.history || [],
  updatedAt: normalizeUpdatedAt(p.updated_at),
  rowVersion: normalizeRowVersion(p.row_version)
});

const mapStrategyRow = (strategy: any): CompanyStrategy => ({
  mission: strategy?.mission || '',
  vision: strategy?.vision || '',
  customerIssues: strategy?.customer_issues || '',
  employeeIssues: strategy?.employee_issues || '',
  companyOKRs: strategy?.company_okrs || {},
  updatedAt: strategy?.updated_at,
  rowVersion: normalizeRowVersion(strategy?.row_version)
});

const mapBusinessRow = (b: any): BusinessDefinition => ({
  id: b.id,
  name: b.name,
  businessFormat: b.business_format,
  customerPersona: b.customer_persona,
  customerNeeds: b.customer_needs,
  surfaceProductPower: b.surface_product_power,
  coreProductPower: b.core_product_power,
  updatedAt: b.updated_at,
  rowVersion: normalizeRowVersion(b.row_version)
});

const mapSystemRoleRow = (r: any): SystemRole => ({
  id: r.id,
  name: r.name,
  description: r.description,
  permissions: r.permissions,
  updatedAt: r.updated_at,
  rowVersion: normalizeRowVersion(r.row_version)
});

const mapTaskRow = (t: any): PADEntry => ({
  id: t.id,
  createdBy: t.created_by ?? t.owner_id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  ownerId: t.owner_id,
  departmentId: t.department_id,
  alignedKrId: t.aligned_kr_id,
  targetWeeks: t.target_weeks || [],
  startDate: t.start_date,
  dueDate: t.due_date,
  tags: t.tags || [],
  participantIds: t.participant_ids || [],
  approverIds: t.approver_ids || [],
  logs: t.logs || [],
  plan: t.plan,
  action: t.action,
  deliverable: t.deliverable,
  taskReview: t.task_review,
  taskReviewScore: t.task_review_score,
  updatedAt: t.updated_at,
  rowVersion: normalizeRowVersion(t.row_version)
});

const USERS_SELECT_FIELDS = 'id,auth_id,username,name,role,department_id,pad_permissions,reviews,system_role_ids,custom_permissions,updated_at,row_version';
const DEPARTMENTS_SELECT_FIELDS = 'id,name,manager_name,manager_user_id,responsibilities,roles,role_members,attributes,sub_departments,okrs,reviews,updated_at,row_version';
const PROCESSES_SELECT_FIELDS = 'id,department_id,created_by,name,category,level,version,is_active,type,owner,co_owner,objective,nodes,links,history,updated_at,row_version';
const STRATEGY_SELECT_FIELDS = 'id,mission,vision,customer_issues,employee_issues,company_okrs,updated_at,row_version';
const BUSINESSES_SELECT_FIELDS = 'id,name,business_format,customer_persona,customer_needs,surface_product_power,core_product_power,updated_at,row_version';
const SYSTEM_ROLES_SELECT_FIELDS = 'id,name,description,permissions,updated_at,row_version';
const TASKS_SELECT_FIELDS = 'id,created_by,title,status,priority,owner_id,department_id,aligned_kr_id,target_weeks,start_date,due_date,tags,participant_ids,approver_ids,logs,plan,action,deliverable,task_review,task_review_score,updated_at,row_version';
const TASKS_LIST_SELECT_FIELDS = 'id,created_by,title,status,priority,owner_id,department_id,aligned_kr_id,target_weeks,start_date,due_date,tags,participant_ids,approver_ids,updated_at,row_version';
const TASKS_SELECT_FIELDS_LEGACY = stripTaskReviewFieldsFromSelect(TASKS_SELECT_FIELDS);
const TASKS_LIST_SELECT_FIELDS_LEGACY = stripTaskReviewFieldsFromSelect(TASKS_LIST_SELECT_FIELDS);
export const TASK_LIST_PAGE_SIZE = 100;

export interface TaskListPage {
  tasks: PADEntry[];
  nextOffset: number;
  hasMore: boolean;
}

const isIgnoredNoRowsError = (error: any) => error?.code === 'PGRST116';
const isIgnoredMissingTableError = (error: any) => error?.code === '42P01';
const isIgnoredMissingFunctionError = (error: any) =>
  error?.code === 'PGRST202' ||
  error?.code === '42883' ||
  error?.message?.includes('Could not find the function');

const buildTaskListPage = (rows: any[], offset: number, limit: number): TaskListPage => {
  const pageRows = rows.slice(0, limit);
  return {
    tasks: pageRows.map(mapTaskRow),
    nextOffset: offset + pageRows.length,
    hasMore: rows.length > limit
  };
};

const buildDefaultStrategy = (): CompanyStrategy => ({
  mission: '',
  vision: '',
  customerIssues: '',
  employeeIssues: '',
  companyOKRs: {},
  rowVersion: 0
});

const fetchSettingsRow = async () => {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .eq('id', 'default')
    .maybeSingle();

  if (error && !isIgnoredNoRowsError(error) && !isIgnoredMissingTableError(error)) {
    throw error;
  }

  return data;
};

export const getBootstrapData = async (): Promise<Pick<AppState, 'users' | 'systemRoles' | 'aiSettings'>> => {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase not configured");
  }

  try {
    const [usersRes, systemRolesRes, settingsData] = await Promise.all([
      supabase.from('users').select(USERS_SELECT_FIELDS),
      supabase.from('system_roles').select(SYSTEM_ROLES_SELECT_FIELDS),
      fetchSettingsRow()
    ]);

    const errors = [usersRes.error, systemRolesRes.error].filter(
      (error): error is NonNullable<typeof error> => Boolean(error) && !isIgnoredMissingTableError(error)
    );
    if (errors.length > 0) {
      throw errors[0];
    }

    return {
      users: (usersRes.data || []).map(mapUserRow),
      systemRoles: (systemRolesRes.data || []).map(mapSystemRoleRow),
      aiSettings: mapSettingsRow(settingsData)
    };
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getUsers = async (): Promise<User[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.from('users').select(USERS_SELECT_FIELDS);
    if (error && !isIgnoredMissingTableError(error)) throw error;
    return (data || []).map(mapUserRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getCurrentUserTaskUsers = async (): Promise<User[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.rpc('get_current_user_task_users');
    if (error) throw error;
    return (data || []).map(mapUserRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getDepartments = async (): Promise<Department[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.from('departments').select(DEPARTMENTS_SELECT_FIELDS);
    if (error && !isIgnoredMissingTableError(error)) throw error;
    return (data || []).map(mapDepartmentRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getProcesses = async (): Promise<ProcessDefinition[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.from('processes').select(PROCESSES_SELECT_FIELDS);
    if (error && !isIgnoredMissingTableError(error)) throw error;
    return (data || []).map(mapProcessRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getStrategy = async (): Promise<CompanyStrategy> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase
      .from('strategy')
      .select(STRATEGY_SELECT_FIELDS)
      .eq('id', 'default')
      .maybeSingle();

    if (error && !isIgnoredNoRowsError(error) && !isIgnoredMissingTableError(error)) {
      throw error;
    }

    return data ? mapStrategyRow(data) : buildDefaultStrategy();
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getBusinesses = async (): Promise<BusinessDefinition[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.from('businesses').select(BUSINESSES_SELECT_FIELDS);
    if (error && !isIgnoredMissingTableError(error)) throw error;
    return (data || []).map(mapBusinessRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getSystemRoles = async (): Promise<SystemRole[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.from('system_roles').select(SYSTEM_ROLES_SELECT_FIELDS);
    if (error && !isIgnoredMissingTableError(error)) throw error;
    return (data || []).map(mapSystemRoleRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getTasks = async (): Promise<PADEntry[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    let data: any[] | null = null;
    let error: any = null;

    ({ data, error } = await supabase.rpc('get_visible_tasks_full'));

    if (isIgnoredMissingFunctionError(error)) {
      ({ data, error } = await supabase.from('tasks').select(TASKS_SELECT_FIELDS));
    }

    if (isMissingTaskReviewColumnError(error)) {
      ({ data, error } = await supabase.from('tasks').select(TASKS_SELECT_FIELDS_LEGACY));
    }

    if (error && !isIgnoredMissingTableError(error)) throw error;
    return (data || []).map(mapTaskRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getTaskUsersForTasks = async (taskIds: string[]): Promise<User[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  if (taskIds.length === 0) return [];
  try {
    const { data, error } = await supabase.rpc('get_current_user_task_users_for_tasks', {
      p_task_ids: taskIds
    });
    if (error) throw error;
    return (data || []).map(mapUserRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getTaskList = async (): Promise<PADEntry[]> => {
  const page = await getTaskListPage();
  return page.tasks;
};

export const getTaskListPage = async (offset = 0, limit = TASK_LIST_PAGE_SIZE): Promise<TaskListPage> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    let data: any[] | null = null;
    let error: any = null;

    ({ data, error } = await supabase.rpc('get_visible_task_list_page', {
      p_offset: offset,
      p_limit: limit + 1
    }));

    if (isIgnoredMissingFunctionError(error)) {
      ({ data, error } = await supabase
        .from('tasks')
        .select(TASKS_LIST_SELECT_FIELDS)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit));
    }

    if (isMissingTaskReviewColumnError(error)) {
      ({ data, error } = await supabase
        .from('tasks')
        .select(TASKS_LIST_SELECT_FIELDS_LEGACY)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit));
    }

    if (error && !isIgnoredMissingTableError(error)) throw error;
    return buildTaskListPage(data || [], offset, limit);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getMyTaskList = async (userId: string): Promise<PADEntry[]> => {
  const page = await getMyTaskListPage(userId);
  return page.tasks;
};

export const getMyTaskListPage = async (_userId: string, offset = 0, limit = TASK_LIST_PAGE_SIZE): Promise<TaskListPage> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    let data: any[] | null = null;
    let error: any = null;

    ({ data, error } = await supabase.rpc('get_my_task_list_page', {
      p_offset: offset,
      p_limit: limit + 1
    }));

    if (isIgnoredMissingFunctionError(error)) {
      const userId = _userId;
      const memberJson = JSON.stringify([userId]);
      ({ data, error } = await supabase
        .from('tasks')
        .select(TASKS_LIST_SELECT_FIELDS)
        .or(`created_by.eq.${userId},owner_id.eq.${userId},participant_ids.cs.${memberJson},approver_ids.cs.${memberJson}`)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit));
    }

    if (isMissingTaskReviewColumnError(error)) {
      const userId = _userId;
      const memberJson = JSON.stringify([userId]);
      ({ data, error } = await supabase
        .from('tasks')
        .select(TASKS_LIST_SELECT_FIELDS_LEGACY)
        .or(`created_by.eq.${userId},owner_id.eq.${userId},participant_ids.cs.${memberJson},approver_ids.cs.${memberJson}`)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit));
    }

    if (error && !isIgnoredMissingTableError(error)) throw error;
    return buildTaskListPage(data || [], offset, limit);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getTaskById = async (taskId: string): Promise<PADEntry> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    let data: any | null = null;
    let error: any = null;

    ({ data, error } = await supabase
      .from('tasks')
      .select(TASKS_SELECT_FIELDS)
      .eq('id', taskId)
      .maybeSingle());

    if (isMissingTaskReviewColumnError(error)) {
      ({ data, error } = await supabase
        .from('tasks')
        .select(TASKS_SELECT_FIELDS_LEGACY)
        .eq('id', taskId)
        .maybeSingle());
    }

    if (error && !isIgnoredMissingTableError(error)) throw error;
    if (!data) throw new Error('任务不存在或无权限查看');
    return mapTaskRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const getWorkbenchTasks = async (_userId: string): Promise<PADEntry[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    let data: any[] | null = null;
    let error: any = null;

    ({ data, error } = await supabase.rpc('get_my_workbench_tasks'));

    if (isIgnoredMissingFunctionError(error)) {
      const userId = _userId;
      const memberJson = JSON.stringify([userId]);
      ({ data, error } = await supabase
        .from('tasks')
        .select(TASKS_SELECT_FIELDS)
        .or(`owner_id.eq.${userId},participant_ids.cs.${memberJson},approver_ids.cs.${memberJson}`));
    }

    if (isMissingTaskReviewColumnError(error)) {
      const userId = _userId;
      const memberJson = JSON.stringify([userId]);
      ({ data, error } = await supabase
        .from('tasks')
        .select(TASKS_SELECT_FIELDS_LEGACY)
        .or(`owner_id.eq.${userId},participant_ids.cs.${memberJson},approver_ids.cs.${memberJson}`));
    }

    if (error && !isIgnoredMissingTableError(error)) throw error;
    return (data || []).map(mapTaskRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const saveAISettings = async (settings: AISettings): Promise<AISettings> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");

  const currentRowVersion = normalizeRowVersion(settings.rowVersion);
  const payload = {
    ai_settings: {
      selectedModelId: settings.selectedModelId,
      configs: sanitizeAIConfigs(settings.configs)
    },
    row_version: currentRowVersion + 1
  };

  try {
    const existing = await supabase.from('settings').select('id').eq('id', 'default').maybeSingle();
    if (existing.error && existing.error.code !== 'PGRST116' && existing.error.code !== '42P01') {
      throw existing.error;
    }

    if (!existing.data) {
      const { data, error } = await supabase
        .from('settings')
        .insert({ id: 'default', ...payload })
        .select('*')
        .single();
      if (error) throw error;
      return mapSettingsRow(data);
    }

    const { data, error } = await supabase
      .from('settings')
      .update(payload)
      .eq('id', 'default')
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle();

    if (error) throw error;
    if (!data) throw buildConflictError('系统设置');
    return mapSettingsRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

/**
 * 持久化保存整个工作空间的状态(拆分到各个关系表)
 */
export const saveWorkspace = async (state: AppState): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");

  try {
    // 0. AI Settings
    if (state.aiSettings) {
      await saveAISettings(state.aiSettings);
    }

    // 1. Users - Removed from full sync, now using atomic operations
    // 2. Departments - Removed from full sync, now using atomic operations
    // 3. Processes - Removed from full sync, now using atomic operations in App.tsx
    // 4. Strategy - Removed from full sync, now using atomic operations
    // 5. Businesses - Removed from full sync, now using atomic operations
    // 6. System Roles - Removed from full sync, now using atomic operations

    // 7. Tasks (Flat structure) - Removed from full save to support atomic updates
    // Tasks are now saved incrementally via addTask, updateTask, deleteTask

    // 8. Reviews - Removed from full sync, now using atomic operations
    // 9. Roles - Removed from full sync, now using atomic operations

  } catch (e) {
    handleSupabaseError(e);
  }
};

/**
 * 读取企业的工作空间数据(从各个关系表组装)
 */
export const getWorkspace = async (): Promise<AppState | null> => {
  if (!isSupabaseConfigured()) {
    console.warn("Supabase not configured. Returning null workspace.");
    return null;
  }

  try {
    const [
      bootstrapData,
      departments,
      processes,
      strategy,
      businesses,
      tasks
    ] = await Promise.all([
      getBootstrapData(),
      getDepartments(),
      getProcesses(),
      getStrategy(),
      getBusinesses(),
      getTasks()
    ]);

    const appState: AppState = {
      users: bootstrapData.users,
      departments,
      processes,
      strategy,
      businesses,
      tasks,
      systemRoles: bootstrapData.systemRoles,
      aiSettings: bootstrapData.aiSettings
    };

    return appState;
  } catch (e) {
    handleSupabaseError(e);
    return null;
  }
};

/**
 * 过滤查询任务
 */
export const getFilteredTasks = async (filters: {
  ownerId?: string;
  departmentId?: string;
  status?: string;
  priority?: string;
  search?: string;
}): Promise<any[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    let query = supabase.from('tasks').select('*');
    
    if (filters.ownerId) query = query.eq('owner_id', filters.ownerId);
    if (filters.departmentId) query = query.eq('department_id', filters.departmentId);
    if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
    if (filters.priority && filters.priority !== 'all') query = query.eq('priority', filters.priority);
    if (filters.search) query = query.ilike('title', `%${filters.search}%`);
    
    const { data, error } = await query;
    if (error) throw error;
    
    return (data || []).map(mapTaskRow);
  } catch (e) {
    handleSupabaseError(e);
    return [];
  }
};

/**
 * 过滤查询用户
 */
export const getFilteredUsers = async (filters: {
  departmentId?: string;
  search?: string;
}): Promise<User[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    let query = supabase.from('users').select('*');
    
    if (filters.departmentId) query = query.eq('department_id', filters.departmentId);
    if (filters.search) {
      query = query.or(`name.ilike.%${filters.search}%,username.ilike.%${filters.search}%`);
    }
    
    const { data, error } = await query;
    if (error) throw error;
    
    return (data || []).map(mapUserRow);
  } catch (e) {
    handleSupabaseError(e);
    return [];
  }
};

/**
 * Atomic Strategy Operations
 */
export const updateStrategy = async (strategy: Partial<CompanyStrategy>): Promise<CompanyStrategy> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const currentRowVersion = normalizeRowVersion(strategy.rowVersion);
    const dbUpdates: any = {
      row_version: currentRowVersion + 1
    };
    if (strategy.mission !== undefined) dbUpdates.mission = strategy.mission;
    if (strategy.vision !== undefined) dbUpdates.vision = strategy.vision;
    if (strategy.customerIssues !== undefined) dbUpdates.customer_issues = strategy.customerIssues;
    if (strategy.employeeIssues !== undefined) dbUpdates.employee_issues = strategy.employeeIssues;
    if (strategy.companyOKRs !== undefined) dbUpdates.company_okrs = strategy.companyOKRs;

    const existing = await supabase.from('strategy').select('id').eq('id', 'default').maybeSingle();
    if (existing.error && existing.error.code !== 'PGRST116' && existing.error.code !== '42P01') {
      throw existing.error;
    }

    if (!existing.data) {
      const { data, error } = await supabase
        .from('strategy')
        .insert({ id: 'default', ...dbUpdates })
        .select('*')
        .single();
      if (error) throw error;
      return mapStrategyRow(data);
    }

    const { data, error } = await supabase
      .from('strategy')
      .update(dbUpdates)
      .eq('id', 'default')
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      const latest = await supabase
        .from('strategy')
        .select('id,row_version')
        .eq('id', 'default')
        .maybeSingle();

      if (latest.error) throw latest.error;
      if (!latest.data) throw buildDeleteConflictError('战略');

      const latestRowVersion = normalizeRowVersion(latest.data.row_version);
      if (latestRowVersion !== currentRowVersion) {
        throw buildConflictError('战略');
      }

      throw buildPermissionError('战略');
    }
    return mapStrategyRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

/**
 * Atomic Business Operations
 */
export const addBusiness = async (business: BusinessDefinition): Promise<BusinessDefinition> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('businesses').insert({
      id: business.id, name: business.name, business_format: business.businessFormat || '',
      customer_persona: business.customerPersona || '', customer_needs: business.customerNeeds || '',
      surface_product_power: business.surfaceProductPower || '', core_product_power: business.coreProductPower || '',
      row_version: 0
    }).select('*').single();
    if (error) throw error;
    if (!data) throw buildDuplicateCreateError('业务定义');
    return mapBusinessRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const updateBusiness = async (id: string, updates: Partial<BusinessDefinition>): Promise<BusinessDefinition> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const currentRowVersion = normalizeRowVersion(updates.rowVersion);
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.businessFormat !== undefined) dbUpdates.business_format = updates.businessFormat;
    if (updates.customerPersona !== undefined) dbUpdates.customer_persona = updates.customerPersona;
    if (updates.customerNeeds !== undefined) dbUpdates.customer_needs = updates.customerNeeds;
    if (updates.surfaceProductPower !== undefined) dbUpdates.surface_product_power = updates.surfaceProductPower;
    if (updates.coreProductPower !== undefined) dbUpdates.core_product_power = updates.coreProductPower;
    dbUpdates.row_version = currentRowVersion + 1;

    const { data, error } = await supabase
      .from('businesses')
      .update(dbUpdates)
      .eq('id', id)
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildConflictError('业务定义');
    return mapBusinessRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const deleteBusiness = async (id: string, rowVersion?: number): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase
      .from('businesses')
      .delete()
      .eq('id', id)
      .eq('row_version', normalizeRowVersion(rowVersion))
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildDeleteConflictError('业务定义');
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

/**
 * Atomic System Role Operations
 */
export const addSystemRole = async (role: SystemRole): Promise<SystemRole> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('system_roles').insert({
      id: role.id, name: role.name, description: role.description || '',
      permissions: role.permissions || {}, row_version: 0
    }).select('*').single();
    if (error) throw error;
    if (!data) throw buildDuplicateCreateError('系统角色');
    return mapSystemRoleRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const updateSystemRole = async (id: string, updates: Partial<SystemRole>): Promise<SystemRole> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const currentRowVersion = normalizeRowVersion(updates.rowVersion);
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.permissions !== undefined) dbUpdates.permissions = updates.permissions;
    dbUpdates.row_version = currentRowVersion + 1;

    const { data, error } = await supabase
      .from('system_roles')
      .update(dbUpdates)
      .eq('id', id)
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildConflictError('系统角色');
    return mapSystemRoleRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const deleteSystemRole = async (id: string, rowVersion?: number): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase
      .from('system_roles')
      .delete()
      .eq('id', id)
      .eq('row_version', normalizeRowVersion(rowVersion))
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildDeleteConflictError('系统角色');
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

/**
 * Atomic Process Operations
 */
export const addProcess = async (process: ProcessDefinition): Promise<ProcessDefinition> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('processes').insert({
      id: process.id, department_id: process.departmentId || null,
      name: process.name, category: process.category, level: process.level,
      version: process.version, is_active: process.isActive, type: process.type, owner: process.owner,
      co_owner: process.coOwner, objective: process.objective, nodes: process.nodes || [],
      links: process.links || [], history: process.history || [],
      row_version: 0
    }).select('*').single();
    if (error) throw error;
    if (!data) throw buildDuplicateCreateError('流程');
    return mapProcessRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const updateProcess = async (id: string, updates: Partial<ProcessDefinition>): Promise<ProcessDefinition> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const currentRowVersion = normalizeRowVersion(updates.rowVersion);
    const dbUpdates: any = {};
    if (updates.departmentId !== undefined) dbUpdates.department_id = updates.departmentId || null;
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.category !== undefined) dbUpdates.category = updates.category;
    if (updates.level !== undefined) dbUpdates.level = updates.level;
    if (updates.version !== undefined) dbUpdates.version = updates.version;
    if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;
    if (updates.type !== undefined) dbUpdates.type = updates.type;
    if (updates.owner !== undefined) dbUpdates.owner = updates.owner;
    if (updates.coOwner !== undefined) dbUpdates.co_owner = updates.coOwner;
    if (updates.objective !== undefined) dbUpdates.objective = updates.objective;
    if (updates.nodes !== undefined) dbUpdates.nodes = updates.nodes || [];
    if (updates.links !== undefined) dbUpdates.links = updates.links || [];
    if (updates.history !== undefined) dbUpdates.history = updates.history || [];
    dbUpdates.row_version = currentRowVersion + 1;

    const { data, error } = await supabase
      .from('processes')
      .update(dbUpdates)
      .eq('id', id)
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildConflictError('流程');
    return mapProcessRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const deleteProcess = async (id: string, rowVersion?: number): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase
      .from('processes')
      .delete()
      .eq('id', id)
      .eq('row_version', normalizeRowVersion(rowVersion))
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildDeleteConflictError('流程');
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

/**
 * Atomic Department Operations
 */
export const addDepartment = async (dept: Department): Promise<Department> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('departments').insert({
      id: dept.id, name: dept.name, manager_name: dept.managerName ?? '', manager_user_id: dept.managerUserId ?? null,
      responsibilities: dept.responsibilities ?? '', roles: dept.roles || [],
      role_members: dept.roleMembers ?? {}, attributes: dept.attributes ?? '',
      sub_departments: dept.subDepartments ?? [], okrs: dept.okrs ?? {}, reviews: dept.reviews ?? {},
      row_version: 0
    }).select('*').single();
    if (error) throw error;
    if (!data) throw buildDuplicateCreateError('部门');
    return mapDepartmentRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const updateDepartment = async (id: string, updates: Partial<Department>): Promise<Department> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const currentRowVersion = normalizeRowVersion(updates.rowVersion);
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.managerName !== undefined) dbUpdates.manager_name = updates.managerName ?? '';
    if (updates.managerUserId !== undefined) dbUpdates.manager_user_id = updates.managerUserId ?? null;
    if (updates.responsibilities !== undefined) dbUpdates.responsibilities = updates.responsibilities ?? '';
    if (updates.roles !== undefined) dbUpdates.roles = updates.roles || [];
    if (updates.roleMembers !== undefined) dbUpdates.role_members = updates.roleMembers ?? {};
    if (updates.attributes !== undefined) dbUpdates.attributes = updates.attributes ?? '';
    if (updates.subDepartments !== undefined) dbUpdates.sub_departments = updates.subDepartments ?? [];
    if (updates.okrs !== undefined) dbUpdates.okrs = updates.okrs ?? {};
    if (updates.reviews !== undefined) dbUpdates.reviews = updates.reviews ?? {};
    dbUpdates.row_version = currentRowVersion + 1;

    const { data, error } = await supabase
      .from('departments')
      .update(dbUpdates)
      .eq('id', id)
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildConflictError('部门');
    return mapDepartmentRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const deleteDepartment = async (id: string, rowVersion?: number): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase
      .from('departments')
      .delete()
      .eq('id', id)
      .eq('row_version', normalizeRowVersion(rowVersion))
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildDeleteConflictError('部门');
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const saveDepartmentsAtomically = async (
  nextDepartments: Department[],
  previousDepartments: Department[]
): Promise<Department[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.rpc('save_departments_atomic', {
      p_next_departments: nextDepartments ?? [],
      p_previous_departments: previousDepartments ?? []
    });
    if (error) throw error;
    return (data || []).map(mapDepartmentRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const saveProcessesAtomically = async (
  nextProcesses: ProcessDefinition[],
  previousProcesses: ProcessDefinition[]
): Promise<ProcessDefinition[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.rpc('save_processes_atomic', {
      p_next_processes: nextProcesses ?? [],
      p_previous_processes: previousProcesses ?? []
    });
    if (error) throw error;
    return (data || []).map(mapProcessRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const saveUsersAtomically = async (
  nextUsers: User[],
  previousUsers: User[]
): Promise<User[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.rpc('save_users_atomic', {
      p_next_users: nextUsers ?? [],
      p_previous_users: previousUsers ?? []
    });
    if (error) throw error;
    return (data || []).map(mapUserRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const updateMyProfileName = async (
  name: string,
  expectedRowVersion?: number
): Promise<User> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.rpc('update_my_profile_name', {
      p_name: name,
      p_expected_row_version: expectedRowVersion ?? null
    });
    if (error) throw error;
    if (!data) throw new Error('更新个人资料失败');
    return mapUserRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const saveSystemRolesAtomically = async (
  nextRoles: SystemRole[],
  previousRoles: SystemRole[]
): Promise<SystemRole[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.rpc('save_system_roles_atomic', {
      p_next_roles: nextRoles ?? [],
      p_previous_roles: previousRoles ?? []
    });
    if (error) throw error;
    return (data || []).map(mapSystemRoleRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const saveBusinessesAtomically = async (
  nextBusinesses: BusinessDefinition[],
  previousBusinesses: BusinessDefinition[]
): Promise<BusinessDefinition[]> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
  try {
    const { data, error } = await supabase.rpc('save_businesses_atomic', {
      p_next_businesses: nextBusinesses ?? [],
      p_previous_businesses: previousBusinesses ?? []
    });
    if (error) throw error;
    return (data || []).map(mapBusinessRow);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

/**
 * Atomic User Operations
 */
export const addUser = async (user: User): Promise<User> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('users').insert({
      id: user.id, username: user.username,
      name: user.name, role: normalizeUserRole(user.role), department_id: user.departmentId || null,
      pad_permissions: user.padPermissions || null, reviews: null,
      system_role_ids: user.systemRoleIds || null, custom_permissions: user.customPermissions || null,
      auth_id: user.auth_id || null, row_version: 0
    }).select('*').single();
    if (error) throw error;
    if (!data) throw buildDuplicateCreateError('用户');
    return mapUserRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const updateUser = async (id: string, updates: Partial<User>): Promise<User> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const currentRowVersion = normalizeRowVersion(updates.rowVersion);
    const dbUpdates: any = {};
    if (updates.username !== undefined) dbUpdates.username = updates.username;
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.role !== undefined) dbUpdates.role = normalizeUserRole(updates.role);
    if (updates.departmentId !== undefined) dbUpdates.department_id = updates.departmentId || null;
    if (updates.padPermissions !== undefined) dbUpdates.pad_permissions = updates.padPermissions || null;
    if (updates.reviews !== undefined) dbUpdates.reviews = updates.reviews || null;
    if (updates.systemRoleIds !== undefined) dbUpdates.system_role_ids = updates.systemRoleIds || null;
    if (updates.customPermissions !== undefined) dbUpdates.custom_permissions = updates.customPermissions || null;
    dbUpdates.row_version = currentRowVersion + 1;

    const { data, error } = await supabase
      .from('users')
      .update(dbUpdates)
      .eq('id', id)
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildConflictError('用户');
    return mapUserRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const deleteUser = async (id: string, rowVersion?: number): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase
      .from('users')
      .delete()
      .eq('id', id)
      .eq('row_version', normalizeRowVersion(rowVersion))
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildDeleteConflictError('用户');
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

/**
 * Atomic Task Operations
 */
export const addTask = async (task: PADEntry): Promise<PADEntry> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const taskData = {
      id: task.id,
      department_id: task.departmentId || null,
      title: task.title || '',
      status: task.status || 'draft',
      priority: task.priority || 'medium',
      owner_id: task.ownerId || null,
      aligned_kr_id: task.alignedKrId || null,
      target_weeks: task.targetWeeks || [],
      start_date: task.startDate || null,
      due_date: task.dueDate || null,
      tags: task.tags || [],
      participant_ids: task.participantIds || [],
      approver_ids: task.approverIds || [],
      logs: task.logs || [],
      plan: task.plan || null,
      action: task.action || null,
      deliverable: task.deliverable || null,
      task_review: task.taskReview || null,
      task_review_score: task.taskReviewScore ?? null,
      row_version: 0
    };
    let data: any = null;
    let error: any = null;

    ({ data, error } = await supabase.from('tasks').insert(taskData).select('*').single());

    if (isMissingTaskReviewColumnError(error)) {
      ({ data, error } = await supabase.from('tasks').insert(omitTaskReviewColumns(taskData)).select('*').single());
    }

    if (error) throw error;
    if (!data) throw buildDuplicateCreateError('任务');
    return {
      ...mapTaskRow(data),
      taskReview: task.taskReview || '',
      taskReviewScore: task.taskReviewScore ?? 0
    };
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const updateTask = async (taskId: string, task: Partial<PADEntry>): Promise<PADEntry> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const currentRowVersion = normalizeRowVersion(task.rowVersion);
    const taskData: any = {};
    if (task.departmentId !== undefined) taskData.department_id = task.departmentId;
    if (task.title !== undefined) taskData.title = task.title;
    if (task.status !== undefined) taskData.status = task.status;
    if (task.priority !== undefined) taskData.priority = task.priority;
    if (task.ownerId !== undefined) taskData.owner_id = task.ownerId;
    if (task.alignedKrId !== undefined) taskData.aligned_kr_id = task.alignedKrId;
    if (task.targetWeeks !== undefined) taskData.target_weeks = task.targetWeeks;
    if (task.startDate !== undefined) taskData.start_date = task.startDate;
    if (task.dueDate !== undefined) taskData.due_date = task.dueDate;
    if (task.tags !== undefined) taskData.tags = task.tags;
    if (task.participantIds !== undefined) taskData.participant_ids = task.participantIds;
    if (task.approverIds !== undefined) taskData.approver_ids = task.approverIds;
    if (task.logs !== undefined) taskData.logs = task.logs;
    if (task.plan !== undefined) taskData.plan = task.plan;
    if (task.action !== undefined) taskData.action = task.action;
    if (task.deliverable !== undefined) taskData.deliverable = task.deliverable;
    if (task.taskReview !== undefined) taskData.task_review = task.taskReview;
    if (task.taskReviewScore !== undefined) taskData.task_review_score = task.taskReviewScore;
    taskData.row_version = currentRowVersion + 1;

    let data: any = null;
    let error: any = null;

    ({ data, error } = await supabase
      .from('tasks')
      .update(taskData)
      .eq('id', taskId)
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle());

    if (isMissingTaskReviewColumnError(error)) {
      ({ data, error } = await supabase
        .from('tasks')
        .update(omitTaskReviewColumns(taskData))
        .eq('id', taskId)
        .eq('row_version', currentRowVersion)
        .select('*')
        .maybeSingle());
    }

    if (error) throw error;
    if (!data) throw buildConflictError('任务');
    return {
      ...mapTaskRow(data),
      taskReview: task.taskReview ?? data?.task_review ?? '',
      taskReviewScore: task.taskReviewScore ?? data?.task_review_score ?? 0
    };
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const deleteTask = async (taskId: string, rowVersion?: number): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', taskId)
      .eq('row_version', normalizeRowVersion(rowVersion))
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildDeleteConflictError('任务');
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};
