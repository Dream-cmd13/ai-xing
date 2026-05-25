
import { AppState, User, Department, ProcessDefinition, CompanyStrategy, BusinessDefinition, SystemRole, PADEntry, AISettings } from "./types";
import { isSupabaseConfigured, supabase } from "./supabase";

/**
 * StratFlow AI 数据持久化层 (Data Access Layer) - Supabase Relational Version (Single Tenant)
 */

const handleSupabaseError = (error: any) => {
  const message = error?.message || String(error);
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

const normalizeRowVersion = (value: any) =>
  typeof value === 'number' ? value : Number(value || 0);

const normalizeUpdatedAt = (value: any) =>
  typeof value === 'number' ? value : Number(value || Date.now());

const mapSettingsRow = (settingsData: any): AISettings => ({
  selectedModelId: settingsData?.ai_settings?.selectedModelId || 'gemini',
  configs: settingsData?.ai_settings?.configs || [
    { id: 'gemini', name: 'Gemini 3 Flash Preview', type: 'gemini', apiKey: 'ENV_KEY' }
  ],
  updatedAt: settingsData?.updated_at,
  rowVersion: normalizeRowVersion(settingsData?.row_version)
});

const mapUserRow = (u: any): User => {
  const reviewsMap: Record<string, any[]> = {};
  if (u.reviews) {
    Object.assign(reviewsMap, u.reviews);
  }

  return {
    id: u.id,
    auth_id: u.auth_id,
    username: u.username,
    name: u.name,
    role: u.role,
    departmentId: u.department_id,
    padPermissions: u.pad_permissions,
    reviews: reviewsMap,
    systemRoleIds: u.system_role_ids,
    customPermissions: u.custom_permissions,
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
    managerName: d.manager_name,
    responsibilities: d.responsibilities,
    roles: d.roles || [],
    roleMembers,
    attributes: d.attributes,
    subDepartments: d.sub_departments,
    okrs: d.okrs,
    reviews: reviewsMap,
    updatedAt: d.updated_at,
    rowVersion: normalizeRowVersion(d.row_version)
  };
};

const mapProcessRow = (p: any): ProcessDefinition => ({
  id: p.id,
  name: p.name,
  category: p.category,
  level: p.level,
  version: p.version,
  isActive: p.is_active,
  type: p.type,
  owner: p.owner,
  coOwner: p.co_owner,
  objective: p.objective,
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
  title: t.title,
  status: t.status,
  priority: t.priority,
  ownerId: t.owner_id,
  departmentId: t.department_id,
  visibility: t.visibility,
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
  updatedAt: t.updated_at,
  rowVersion: normalizeRowVersion(t.row_version)
});

export const saveAISettings = async (settings: AISettings): Promise<AISettings> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured");

  const nextUpdatedAt = Date.now();
  const currentRowVersion = normalizeRowVersion(settings.rowVersion);
  const payload = {
    ai_settings: {
      selectedModelId: settings.selectedModelId,
      configs: settings.configs
    },
    updated_at: nextUpdatedAt,
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
 * 持久化保存整个工作空间的状�?(拆分到各个关系表)
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
 * 读取企业的工作空间数�?(从各个关系表组装)
 */
export const getWorkspace = async (): Promise<AppState | null> => {
  if (!isSupabaseConfigured()) {
    console.warn("Supabase not configured. Returning null workspace.");
    return null;
  }

  try {
    // Check if settings exists
    const { data: settingsData, error: settingsError } = await supabase.from('settings').select('*').eq('id', 'default').maybeSingle();
    
    if (settingsError && settingsError.code !== 'PGRST116' && settingsError.code !== '42P01') {
      console.error("Settings fetch error:", settingsError);
      throw settingsError;
    }

    // Fetch all related data concurrently
    const [
      usersRes,
      departmentsRes,
      processesRes,
      strategyRes,
      businessesRes,
      systemRolesRes,
      tasksRes
    ] = await Promise.all([
      supabase.from('users').select('*'),
      supabase.from('departments').select('*'),
      supabase.from('processes').select('*'),
      supabase.from('strategy').select('*').eq('id', 'default').maybeSingle(),
      supabase.from('businesses').select('*'),
      supabase.from('system_roles').select('*'),
      supabase.from('tasks').select('*')
    ]);

    const errors = [
      usersRes.error, departmentsRes.error, processesRes.error,
      strategyRes.error && strategyRes.error.code !== 'PGRST116' ? strategyRes.error : null,
      businessesRes.error, systemRolesRes.error, tasksRes.error
    ].filter(e => e && e.code !== '42P01'); // Ignore undefined_table errors

    if (errors.length > 0) {
      const firstError = errors[0];
      console.error("Supabase fetch errors:", errors);
      
      if (firstError?.message?.includes('JWT')) {
        throw new Error("数据库访问权限不足 (JWT 错误)。请检查 RLS 策略或登录状态。");
      }
      
      throw firstError;
    }

    const users = usersRes.data || [];
    const departments = departmentsRes.data || [];
    const processes = processesRes.data || [];
    const strategy = strategyRes.data;
    const businesses = businessesRes.data || [];
    const systemRoles = systemRolesRes.data || [];
    const tasks = tasksRes.data || [];

    const appState: AppState = {
      users: (users || []).map(mapUserRow),
      departments: (departments || []).map(mapDepartmentRow),
      processes: (processes || []).map(mapProcessRow),
      strategy: strategy ? mapStrategyRow(strategy) : { mission: '', vision: '', customerIssues: '', employeeIssues: '', companyOKRs: {}, rowVersion: 0 },
      businesses: (businesses || []).map(mapBusinessRow),
      tasks: (tasks || []).map(mapTaskRow),
      systemRoles: (systemRoles || []).map(mapSystemRoleRow),
      aiSettings: mapSettingsRow(settingsData)
    };

    return appState;
  } catch (e) {
    if ((e as any)?.code === 'PGRST116') return null; // No rows for strategy
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
    const nextUpdatedAt = Date.now();
    const dbUpdates: any = {
      updated_at: nextUpdatedAt,
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
    if (!data) throw buildConflictError('战略');
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
    const { data, error } = await supabase.from('businesses').upsert({
      id: business.id, name: business.name, business_format: business.businessFormat || '',
      customer_persona: business.customerPersona || '', customer_needs: business.customerNeeds || '',
      surface_product_power: business.surfaceProductPower || '', core_product_power: business.coreProductPower || '',
      updated_at: Date.now(), row_version: 0
    }).select('*').single();
    if (error) throw error;
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
    dbUpdates.updated_at = Date.now();
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

export const deleteBusiness = async (id: string): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { error } = await supabase.from('businesses').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    handleSupabaseError(e);
  }
};

/**
 * Atomic System Role Operations
 */
export const addSystemRole = async (role: SystemRole): Promise<SystemRole> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('system_roles').upsert({
      id: role.id, name: role.name, description: role.description || '',
      permissions: role.permissions || {}, updated_at: Date.now(), row_version: 0
    }).select('*').single();
    if (error) throw error;
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
    dbUpdates.updated_at = Date.now();
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

export const deleteSystemRole = async (id: string): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { error } = await supabase.from('system_roles').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    handleSupabaseError(e);
  }
};

/**
 * Atomic Process Operations
 */
export const addProcess = async (process: ProcessDefinition): Promise<ProcessDefinition> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('processes').upsert({
      id: process.id, name: process.name, category: process.category, level: process.level,
      version: process.version, is_active: process.isActive, type: process.type, owner: process.owner,
      co_owner: process.coOwner, objective: process.objective, nodes: process.nodes || [],
      links: process.links || [], history: process.history || [], updated_at: process.updatedAt,
      row_version: 0
    }).select('*').single();
    if (error) throw error;
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
    dbUpdates.updated_at = Date.now();
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

export const deleteProcess = async (id: string): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { error } = await supabase.from('processes').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    handleSupabaseError(e);
  }
};

/**
 * Atomic Department Operations
 */
export const addDepartment = async (dept: Department): Promise<Department> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('departments').upsert({
      id: dept.id, name: dept.name, manager_name: dept.managerName || null,
      responsibilities: dept.responsibilities || null, roles: dept.roles || [],
      role_members: dept.roleMembers || null, attributes: dept.attributes || null,
      sub_departments: dept.subDepartments || null, okrs: dept.okrs || null, reviews: null,
      updated_at: Date.now(), row_version: 0
    }).select('*').single();
    if (error) throw error;
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
    if (updates.managerName !== undefined) dbUpdates.manager_name = updates.managerName || null;
    if (updates.responsibilities !== undefined) dbUpdates.responsibilities = updates.responsibilities || null;
    if (updates.roles !== undefined) dbUpdates.roles = updates.roles || [];
    if (updates.roleMembers !== undefined) dbUpdates.role_members = updates.roleMembers || null;
    if (updates.attributes !== undefined) dbUpdates.attributes = updates.attributes || null;
    if (updates.subDepartments !== undefined) dbUpdates.sub_departments = updates.subDepartments || null;
    if (updates.okrs !== undefined) dbUpdates.okrs = updates.okrs || null;
    if (updates.reviews !== undefined) dbUpdates.reviews = updates.reviews || null;
    dbUpdates.updated_at = Date.now();
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

export const deleteDepartment = async (id: string): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { error } = await supabase.from('departments').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    handleSupabaseError(e);
  }
};

/**
 * Atomic User Operations
 */
export const addUser = async (user: User): Promise<User> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { data, error } = await supabase.from('users').upsert({
      id: user.id, username: user.username,
      name: user.name, role: user.role, department_id: user.departmentId || null,
      pad_permissions: user.padPermissions || null, reviews: null,
      system_role_ids: user.systemRoleIds || null, custom_permissions: user.customPermissions || null,
      auth_id: user.auth_id || null, updated_at: Date.now(), row_version: 0
    }).select('*').single();
    if (error) throw error;
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
    if (updates.role !== undefined) dbUpdates.role = updates.role;
    if (updates.departmentId !== undefined) dbUpdates.department_id = updates.departmentId || null;
    if (updates.padPermissions !== undefined) dbUpdates.pad_permissions = updates.padPermissions || null;
    if (updates.reviews !== undefined) dbUpdates.reviews = updates.reviews || null;
    if (updates.systemRoleIds !== undefined) dbUpdates.system_role_ids = updates.systemRoleIds || null;
    if (updates.customPermissions !== undefined) dbUpdates.custom_permissions = updates.customPermissions || null;
    dbUpdates.updated_at = Date.now();
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

export const deleteUser = async (id: string): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    handleSupabaseError(e);
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
      visibility: task.visibility || 'public',
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
      updated_at: Date.now(),
      row_version: 0
    };
    const { data, error } = await supabase.from('tasks').upsert(taskData).select('*').single();
    if (error) throw error;
    return mapTaskRow(data);
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
    if (task.visibility !== undefined) taskData.visibility = task.visibility;
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
    taskData.updated_at = Date.now();
    taskData.row_version = currentRowVersion + 1;

    const { data, error } = await supabase
      .from('tasks')
      .update(taskData)
      .eq('id', taskId)
      .eq('row_version', currentRowVersion)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw buildConflictError('任务');
    return mapTaskRow(data);
  } catch (e) {
    handleSupabaseError(e);
    throw e;
  }
};

export const deleteTask = async (taskId: string): Promise<void> => {
  if (!isSupabaseConfigured()) throw new Error("Supabase not configured")
  try {
    const { error } = await supabase.from('tasks').delete().eq('id', taskId);
    if (error) throw error;
  } catch (e) {
    handleSupabaseError(e);
  }
};

