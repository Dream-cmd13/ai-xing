import { assertResult, clampInteger, withTimeout } from './internal/repository-helpers.mjs';

const PROCESS_FIELDS = 'id,department_id,created_by,name,category,level,version,is_active,type,owner,co_owner,objective,nodes,links,updated_at,row_version';

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

export function createProcessRepository({ execute, requestTimeoutMs }) {
  return {
    getProcessSipoc({ processId, departmentId, limit = 20 } = {}) {
      return execute('get_process_sipoc', async (client) => {
        const boundedLimit = Math.max(clampInteger(limit, 20, 20), 1);
        let query = client.from('processes').select(PROCESS_FIELDS).order('updated_at', { ascending: false }).limit(boundedLimit);
        if (processId) query = query.eq('id', processId);
        if (departmentId) query = query.eq('department_id', departmentId);
        const rows = assertResult(await withTimeout(query, requestTimeoutMs));
        return { limit: boundedLimit, processes: rows.map(mapProcess) };
      });
    },
  };
}
