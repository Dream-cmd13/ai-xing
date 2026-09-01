import { Department, User } from '../types';

export type DepartmentScope = 'exact' | 'subtree';

export interface DepartmentNodeMeta {
  id: string;
  name: string;
  parentId?: string;
  parentName?: string;
  rootId: string;
  rootName: string;
  depth: number;
  path: string[];
  namePath: string[];
  hasChildren: boolean;
  managerUserId?: string;
  managerName?: string;
  managerUsername?: string;
  node: Department;
}

export interface DepartmentTreeIndex {
  nodes: DepartmentNodeMeta[];
  byId: Map<string, DepartmentNodeMeta>;
  byName: Map<string, DepartmentNodeMeta[]>;
  diagnostics: string[];
}

export interface ResolvedDepartmentScope {
  node: DepartmentNodeMeta;
  scope: DepartmentScope;
  ids: string[];
  candidates?: DepartmentNodeMeta[];
}

const asText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const sameIdentity = (left: unknown, right: unknown): boolean => {
  const a = asText(left);
  const b = asText(right);
  return Boolean(a && b && a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0);
};

const childDepartments = (value: any): Department[] => {
  const modern = Array.isArray(value?.subDepartments) ? value.subDepartments : null;
  const legacy = Array.isArray(value?.sub_departments) ? value.sub_departments : null;
  return (modern || legacy || []).filter((item): item is Department => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
};

const normalizeManager = (node: any, users: User[]): Pick<DepartmentNodeMeta, 'managerUserId' | 'managerName' | 'managerUsername'> => {
  const explicitIdentity = asText(node?.managerUserId ?? node?.manager_user_id);
  const configuredName = asText(node?.managerName ?? node?.manager_name);
  const resolveIdentity = (value: string): User | undefined => {
    if (!value) return undefined;
    const byId = users.filter((candidate) => candidate.id === value);
    if (byId.length === 1) return byId[0];
    const byUsername = users.filter((candidate) => sameIdentity(candidate.username, value));
    if (byUsername.length === 1) return byUsername[0];
    const byName = users.filter((candidate) => sameIdentity(candidate.name, value));
    return byName.length === 1 ? byName[0] : undefined;
  };
  const user = resolveIdentity(explicitIdentity) ?? resolveIdentity(configuredName);
  return {
    managerUserId: user?.id || explicitIdentity || undefined,
    managerName: configuredName || user?.name,
    managerUsername: user?.username,
  };
};

export const flattenDepartmentTree = (
  departments: Department[] = [],
  users: User[] = []
): DepartmentTreeIndex => {
  const nodes: DepartmentNodeMeta[] = [];
  const byId = new Map<string, DepartmentNodeMeta>();
  const byName = new Map<string, DepartmentNodeMeta[]>();
  const diagnostics: string[] = [];

  const walk = (
    items: Department[],
    parent: DepartmentNodeMeta | undefined,
    root: { id: string; name: string },
    path: string[],
    namePath: string[],
    visited: Set<string>
  ) => {
    for (const item of items) {
      const id = asText(item?.id);
      const name = asText(item?.name);
      if (!id || !name) {
        diagnostics.push('invalid_node');
        continue;
      }
      if (visited.has(id)) {
        diagnostics.push('cycle_detected');
        continue;
      }
      const nextPath = [...path, id];
      const nextNamePath = [...namePath, name];
      const children = childDepartments(item);
      const manager = normalizeManager(item, users);
      const node: DepartmentNodeMeta = {
        id,
        name,
        parentId: parent?.id,
        parentName: parent?.name,
        rootId: root.id,
        rootName: root.name,
        depth: nextPath.length - 1,
        path: nextPath,
        namePath: nextNamePath,
        hasChildren: children.length > 0,
        ...manager,
        node: item,
      };
      if (byId.has(id)) {
        diagnostics.push('duplicate_node_id');
        continue;
      }
      byId.set(id, node);
      nodes.push(node);
      const sameName = byName.get(name) || [];
      sameName.push(node);
      byName.set(name, sameName);
      walk(children, node, root, nextPath, nextNamePath, new Set([...visited, id]));
    }
  };

  for (const rootItem of departments || []) {
    const rootId = asText(rootItem?.id);
    const rootName = asText(rootItem?.name);
    if (!rootId || !rootName) {
      diagnostics.push('invalid_root');
      continue;
    }
    walk([rootItem], undefined, { id: rootId, name: rootName }, [], [], new Set());
  }

  return { nodes, byId, byName, diagnostics: Array.from(new Set(diagnostics)) };
};

export const collectDepartmentIds = (
  index: DepartmentTreeIndex,
  departmentId: string,
  scope: DepartmentScope = 'exact'
): string[] => {
  const node = index.byId.get(departmentId);
  if (!node) return [];
  if (scope === 'exact') return [node.id];
  const prefix = node.path.join('\u0000');
  return index.nodes
    .filter((candidate) => candidate.path.length >= node.path.length
      && candidate.path.slice(0, node.path.length).join('\u0000') === prefix)
    .sort((a, b) => a.path.length - b.path.length || a.id.localeCompare(b.id))
    .map((candidate) => candidate.id);
};

export const resolveDepartmentScope = (
  index: DepartmentTreeIndex,
  input: { id?: string; name?: string; scope?: DepartmentScope | 'auto' } = {}
): ResolvedDepartmentScope | null => {
  const id = asText(input.id);
  const name = asText(input.name);
  let candidates = id ? (index.byId.has(id) ? [index.byId.get(id)!] : []) : (index.byName.get(name) || []);
  if (candidates.length !== 1) {
    return candidates.length > 1
      ? { node: candidates[0], scope: 'exact', ids: [], candidates }
      : null;
  }
  const node = candidates[0];
  const scope = input.scope === 'exact' || input.scope === 'subtree'
    ? input.scope
    : (node.hasChildren ? 'subtree' : 'exact');
  return { node, scope, ids: collectDepartmentIds(index, node.id, scope) };
};

export const isDepartmentPathAncestor = (
  ancestor: DepartmentNodeMeta | undefined,
  descendant: DepartmentNodeMeta | undefined
): boolean => Boolean(
  ancestor && descendant
  && ancestor.rootId === descendant.rootId
  && descendant.path.length > ancestor.path.length
  && descendant.path.slice(0, ancestor.path.length).every((id, index) => id === ancestor.path[index])
);

export const resolveDepartmentScopeForUser = (
  index: DepartmentTreeIndex,
  input: { id?: string; name?: string; scope?: DepartmentScope | 'auto' } = {},
  currentDepartmentId?: string,
  forceAncestorExact = true
): ResolvedDepartmentScope | null => {
  const resolved = resolveDepartmentScope(index, input);
  if (!resolved || !forceAncestorExact || !currentDepartmentId) return resolved;
  const currentNode = index.byId.get(currentDepartmentId);
  if (!isDepartmentPathAncestor(resolved.node, currentNode)) return resolved;
  return { ...resolved, scope: 'exact', ids: [resolved.node.id] };
};

export const getManagerUserIds = (
  node: DepartmentNodeMeta,
  users: User[] = []
): string[] => {
  const explicit = node.managerUserId;
  if (explicit) {
    const byId = users.filter((user) => user.id === explicit);
    if (byId.length === 1) return [byId[0].id];
    const byUsername = users.filter((user) => sameIdentity(user.username, explicit));
    if (byUsername.length === 1) return [byUsername[0].id];
    const byName = users.filter((user) => sameIdentity(user.name, explicit));
    if (byName.length === 1) return [byName[0].id];
  }
  const managerName = asText(node.managerName);
  if (!managerName) return [];
  const matches = users.filter((user) => user.name === managerName || user.username === managerName);
  return matches.length === 1 ? [matches[0].id] : [];
};

export const getAssignableUsersForScope = (
  currentUser: User,
  users: User[],
  index: DepartmentTreeIndex,
  systemRoleIsAdmin = false
): User[] => {
  if (systemRoleIsAdmin) return users;
  const currentNode = currentUser.departmentId ? index.byId.get(currentUser.departmentId) : undefined;
  const managedRoots = index.nodes.filter((node) => (
    node.managerUserId === currentUser.id
      || (node.id === currentUser.departmentId && currentUser.role === 'Manager')
  ));
  const roots = managedRoots.length > 0
    ? managedRoots
    : (currentUser.role === 'Manager' && currentNode ? [currentNode] : []);
  const ids = new Set(roots.flatMap((root) => collectDepartmentIds(index, root.id, 'subtree')));
  return users.filter((user) => user.id === currentUser.id || (user.departmentId && ids.has(user.departmentId)));
};
