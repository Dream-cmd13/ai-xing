import { AppError } from '../errors.mjs';
import {
  assertResult,
  dataAccessError,
  mapRpcError,
  withTimeout,
} from './internal/repository-helpers.mjs';

const STRATEGY_FIELDS = 'id,mission,vision,customer_issues,employee_issues,company_okrs,updated_at,row_version';
const DEPARTMENT_FIELDS = 'id,name,manager_name,manager_user_id,responsibilities,attributes,sub_departments,okrs,updated_at,row_version';
const BUSINESS_FIELDS = 'id,name,business_format,customer_persona,customer_needs,surface_product_power,core_product_power,updated_at,row_version';

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
    subDepartments: rawChildren.map((child) => mapDepartment(child, depth + 1, nextPath)).filter(Boolean),
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

export function createDepartmentResolver({ requestTimeoutMs, identityRepository }) {
  return async function resolveDepartmentInput(client, { departmentId, departmentName, scope = 'auto' } = {}) {
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
  };
}

export function createOrganizationRepository({ execute, requestTimeoutMs }) {
  return {
    getOrganizationInfo() {
      return execute('get_organization_info', async (client) => {
        const [strategyResult, departmentsResult, businessesResult] = await withTimeout(Promise.all([
          client.from('strategy').select(STRATEGY_FIELDS).eq('id', 'default').maybeSingle(),
          client.from('departments').select(DEPARTMENT_FIELDS).order('name', { ascending: true }),
          client.from('businesses').select(BUSINESS_FIELDS).order('name', { ascending: true }),
        ]), requestTimeoutMs);
        return {
          strategy: mapStrategy(assertResult(strategyResult)),
          departments: assertResult(departmentsResult).map((row) => mapDepartment(row)).filter(Boolean),
          businesses: assertResult(businessesResult).map(mapBusiness),
        };
      });
    },
  };
}
