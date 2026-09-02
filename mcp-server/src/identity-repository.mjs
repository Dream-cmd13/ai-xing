import { AppError } from './errors.mjs';

const PURPOSES = new Set(['owner', 'participant', 'approver', 'query']);

function safeDiagnosticCode(error) {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : 'UNKNOWN';
}

function dataAccessError(error) {
  const result = new AppError('DATA_ACCESS_FAILED');
  result.diagnosticCode = safeDiagnosticCode(error);
  return result;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(dataAccessError({ code: 'TIMEOUT' })), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function mapRpcError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (error?.code === 'PGRST202' || error?.code === '42883' || /could not find the function|function .* does not exist|schema cache/i.test(message)) {
    const result = new AppError('RPC_NOT_CONFIGURED', undefined, 503);
    result.diagnosticCode = 'RPC_NOT_FOUND';
    return result;
  }
  if (message.startsWith('MCP_USER_NOT_FOUND:')) return new AppError('USER_NOT_FOUND');
  if (message.startsWith('MCP_USER_NAME_AMBIGUOUS:')) return new AppError('USER_NAME_AMBIGUOUS');
  if (message.startsWith('MCP_DEPARTMENT_NOT_FOUND:')) return new AppError('DEPARTMENT_NOT_FOUND');
  if (message.startsWith('MCP_DEPARTMENT_NAME_AMBIGUOUS:')) return new AppError('DEPARTMENT_NAME_AMBIGUOUS');
  return dataAccessError(error);
}

function normalizeUser(value) {
  const row = value?.user ?? value;
  if (!row || typeof row !== 'object' || typeof row.user_id !== 'string' || typeof row.name !== 'string') {
    throw dataAccessError({ code: 'MALFORMED_USER' });
  }
  return {
    userId: row.user_id,
    name: row.name,
    role: typeof row.role === 'string' ? row.role : '',
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
  };
}

function normalizeDepartmentCandidate(value) {
  const row = value && typeof value === 'object' ? value : {};
  if (typeof row.id !== 'string' || typeof row.name !== 'string') return null;
  return {
    id: row.id,
    name: row.name,
    parentId: typeof row.parent_id === 'string' ? row.parent_id : (typeof row.parentId === 'string' ? row.parentId : null),
    parentName: typeof row.parent_name === 'string' ? row.parent_name : (typeof row.parentName === 'string' ? row.parentName : null),
    rootId: typeof row.root_id === 'string' ? row.root_id : (typeof row.rootId === 'string' ? row.rootId : row.id),
    rootName: typeof row.root_name === 'string' ? row.root_name : (typeof row.rootName === 'string' ? row.rootName : row.name),
    depth: Number.isInteger(row.depth) ? row.depth : 0,
    path: Array.isArray(row.node_path) ? row.node_path.filter((item) => typeof item === 'string') : (Array.isArray(row.path) ? row.path.filter((item) => typeof item === 'string') : [row.id]),
    namePath: Array.isArray(row.name_path) ? row.name_path.filter((item) => typeof item === 'string') : (Array.isArray(row.namePath) ? row.namePath.filter((item) => typeof item === 'string') : [row.name]),
    hasChildren: row.has_children === true || row.hasChildren === true,
  };
}

export function createIdentityRepository({ createUserClient, getContext, requestTimeoutMs, logger = console }) {
  async function resolveUser({ name, departmentName, purpose = 'query' } = {}) {
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedDepartment = typeof departmentName === 'string' && departmentName.trim()
      ? departmentName.trim()
      : null;
    if (!normalizedName || normalizedName.length > 128 || (normalizedDepartment && normalizedDepartment.length > 128)) {
      throw new AppError('INVALID_ARGUMENT');
    }
    if (!PURPOSES.has(purpose)) throw new AppError('INVALID_ARGUMENT');
    const context = getContext();
    if (!context?.accessToken) throw new AppError('SESSION_EXPIRED', '登录会话已失效，请重新连接。', 401);
    try {
      const client = createUserClient(context.accessToken);
      const result = await withTimeout(client.rpc('mcp_resolve_users_by_name', {
        p_name: normalizedName,
        p_department_name: normalizedDepartment,
        p_purpose: purpose,
      }), requestTimeoutMs);
      if (result?.error) throw mapRpcError(result.error);
      const data = result?.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : null;
      if (data?.departmentAmbiguous === true) {
        const candidates = Array.isArray(data.candidates)
          ? data.candidates.map(normalizeDepartmentCandidate).filter(Boolean)
          : [];
        throw new AppError('DEPARTMENT_NAME_AMBIGUOUS', undefined, 400, { candidates });
      }
      return normalizeUser(data);
    } catch (error) {
      const publicError = error instanceof AppError ? error : mapRpcError(error);
      if (publicError.code === 'DATA_ACCESS_FAILED') {
        logger.error?.({ event: 'identity_resolution_failed', operation: 'resolve_user', code: publicError.diagnosticCode ?? 'UNKNOWN' });
      }
      throw publicError;
    }
  }

  async function resolveUsers({ users = [], purpose = 'query' } = {}) {
    if (!Array.isArray(users)) throw new AppError('INVALID_ARGUMENT');
    const maximum = purpose === 'approver' ? 20 : 50;
    if (users.length > maximum) throw new AppError('INVALID_ARGUMENT');
    const resolved = [];
    for (const user of users) {
      if (!user || typeof user !== 'object' || Array.isArray(user)) throw new AppError('INVALID_ARGUMENT');
      resolved.push(await resolveUser({ ...user, purpose }));
    }
    return { users: resolved, requested: users };
  }

  async function resolveDepartment({ name, id, scope = 'auto' } = {}) {
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if ((!normalizedName && !normalizedId) || (normalizedName && normalizedName.length > 128)
      || (normalizedId && normalizedId.length > 128)
      || !['auto', 'exact', 'subtree'].includes(scope)) {
      throw new AppError('INVALID_ARGUMENT');
    }
    const context = getContext();
    if (!context?.accessToken) throw new AppError('SESSION_EXPIRED', '登录会话已失效，请重新连接。', 401);
    try {
      const client = createUserClient(context.accessToken);
      const result = await withTimeout(client.rpc('mcp_resolve_department', {
        p_department_name: normalizedName || null,
        p_department_id: normalizedId || null,
        p_scope: scope,
      }), requestTimeoutMs);
      if (result?.error) throw mapRpcError(result.error);
      const data = result?.data && typeof result.data === 'object' ? result.data : null;
      if (!data) throw dataAccessError({ code: 'MALFORMED_DEPARTMENT' });
      const candidates = Array.isArray(data.candidates)
        ? data.candidates.map(normalizeDepartmentCandidate).filter(Boolean)
        : [];
      if (data.ambiguous === true || candidates.length > 1) {
        throw new AppError('DEPARTMENT_NAME_AMBIGUOUS', undefined, 400, { candidates });
      }
      const node = normalizeDepartmentCandidate(data.department ?? data.node ?? data);
      if (!node) throw dataAccessError({ code: 'MALFORMED_DEPARTMENT' });
      const resolvedScope = data.scope === 'exact' || data.scope === 'subtree' ? data.scope : (scope === 'auto' ? 'auto' : scope);
      return { ...node, scope: resolvedScope, ids: Array.isArray(data.ids) ? data.ids.filter((item) => typeof item === 'string') : [node.id] };
    } catch (error) {
      const publicError = error instanceof AppError ? error : mapRpcError(error);
      if (publicError.code === 'DATA_ACCESS_FAILED') {
        logger.error?.({ event: 'identity_resolution_failed', operation: 'resolve_department', code: publicError.diagnosticCode ?? 'UNKNOWN' });
      }
      throw publicError;
    }
  }

  return Object.freeze({ resolveUser, resolveUsers, resolveDepartment });
}
