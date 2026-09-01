import { User, SystemRole, MenuPermission, Department, PADEntry, UserRole } from '../types';
import { collectDepartmentIds, flattenDepartmentTree, getAssignableUsersForScope } from './departmentTree';

export const normalizeUserRole = (role: string | undefined): UserRole => {
  if (role === 'Admin' || role === 'Manager' || role === 'Employee') return role;
  return 'Employee';
};

const normalizeStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return [value];
  }

  return [];
};

export const isAdminUser = (user: User, systemRoles: SystemRole[] = []): boolean => {
  if (user.role === 'Admin') return true;

  const systemRoleIds = normalizeStringArray(user.systemRoleIds);
  if (systemRoleIds.length > 0 && systemRoles.length > 0) {
    return systemRoleIds.some(roleId => {
      const role = systemRoles.find(r => r.id === roleId);
      return role && (role.name.toLowerCase() === 'admin' || role.id === 'admin');
    });
  }

  return false;
};

export const isManagerUser = (user: User): boolean => normalizeUserRole(user.role) === 'Manager';

export const getAssignableTaskOwners = (
  currentUser: User,
  users: User[],
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): User[] => {
  if (isAdminUser(currentUser, systemRoles)) {
    return users;
  }

  if (isManagerUser(currentUser) && currentUser.departmentId && departments.length > 0) {
    const index = flattenDepartmentTree(departments, users);
    return getAssignableUsersForScope(currentUser, users, index, false);
  }

  if (isManagerUser(currentUser) && currentUser.departmentId) {
    const sameDepartmentUsers = users.filter(user => user.departmentId === currentUser.departmentId);
    return sameDepartmentUsers.some(user => user.id === currentUser.id)
      ? sameDepartmentUsers
      : [currentUser, ...sameDepartmentUsers];
  }

  return users.some(user => user.id === currentUser.id)
    ? users.filter(user => user.id === currentUser.id)
    : [currentUser];
};

export const canAssignTaskOwner = (
  currentUser: User,
  users: User[],
  targetOwnerId: string | undefined,
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): boolean => {
  if (!targetOwnerId) return false;
  return getAssignableTaskOwners(currentUser, users, systemRoles, departments).some(user => user.id === targetOwnerId);
};

export const getUserRoleLabel = (role: UserRole): string => {
  switch (role) {
    case 'Admin':
      return '管理员';
    case 'Manager':
      return '部门长';
    default:
      return '普通员工';
  }
};

const findDepartmentById = (
  departments: Department[] = [],
  targetDepartmentId: string
): Department | undefined => {
  for (const department of departments) {
    if (department.id === targetDepartmentId) {
      return department;
    }

    const nestedMatch = findDepartmentById(
      department.subDepartments || [],
      targetDepartmentId
    );
    if (nestedMatch) {
      return nestedMatch;
    }
  }

  return undefined;
};

const collectManagedDepartments = (
  departments: Department[] = [],
  currentUser: User
): Department[] => {
  if (!isManagerUser(currentUser)) return [];
  const matches: Department[] = [];

  departments.forEach((department) => {
    const isExplicitManager = department.managerUserId === currentUser.id;
    const isLegacyOwnDepartmentManager = !department.managerUserId && department.id === currentUser.departmentId;
    if (isExplicitManager || isLegacyOwnDepartmentManager) {
      matches.push(department);
    }

    if (department.subDepartments?.length) {
      matches.push(...collectManagedDepartments(department.subDepartments, currentUser));
    }
  });

  return matches;
};

const collectAncestorDepartmentIds = (
  departments: Department[] = [],
  targetDepartmentId?: string
): string[] => {
  if (!targetDepartmentId) return [];

  const walk = (items: Department[], ancestors: string[]): string[] | null => {
    for (const department of items) {
      const nextAncestors = [...ancestors, department.id];
      if (department.id === targetDepartmentId) {
        return nextAncestors;
      }

      const match = walk(department.subDepartments || [], nextAncestors);
      if (match) return match;
    }

    return null;
  };

  return walk(departments, []) || [];
};

export const isDepartmentSelfOrAncestor = (
  departments: Department[] = [],
  targetDepartmentId?: string,
  currentDepartmentId?: string
): boolean => {
  if (!targetDepartmentId || !currentDepartmentId) return false;
  return collectAncestorDepartmentIds(departments, currentDepartmentId).includes(targetDepartmentId);
};

const getScopedDepartmentIds = (
  currentUser: User,
  departments: Department[] = []
): string[] => {
  const index = flattenDepartmentTree(departments);
  const ids: string[] = [];
  const currentNode = currentUser.departmentId ? index.byId.get(currentUser.departmentId) : undefined;

  if (currentNode) {
    // Every member can read their own department and all descendants. Ancestor
    // nodes are readable as exact nodes so a child employee can inspect the
    // parent department without receiving sibling tasks.
    ids.push(...collectDepartmentIds(index, currentNode.id, 'subtree'));
    ids.push(...currentNode.path.slice(0, -1));
  } else if (currentUser.departmentId) {
    ids.push(currentUser.departmentId);
  }

  normalizeStringArray(currentUser.padPermissions).forEach((departmentId) => {
    ids.push(departmentId);
  });

  getManagedDepartments(currentUser, departments).forEach((department) => {
    ids.push(...collectDepartmentIds(index, department.id, 'subtree'));
  });

  return Array.from(new Set(ids));
};

export const getManagedDepartments = (
  currentUser: User,
  departments: Department[] = []
): Department[] => collectManagedDepartments(departments, currentUser);

export const getManagedDepartmentIds = (
  currentUser: User,
  departments: Department[] = []
): string[] => {
  const index = flattenDepartmentTree(departments);
  return Array.from(new Set(
    getManagedDepartments(currentUser, departments).flatMap((department) => (
      collectDepartmentIds(index, department.id, 'subtree')
    ))
  ));
};

export const getPrimaryManagedDepartmentId = (
  currentUser: User,
  departments: Department[] = []
): string | undefined => getManagedDepartmentIds(currentUser, departments)[0];

export const canViewTask = (task: PADEntry, currentUser: User, users: User[], systemRoles: SystemRole[] = [], departments: Department[] = []): boolean => {
  if (isAdminUser(currentUser, systemRoles)) return true;

  const taskDeptId = task.departmentId || users.find(u => u.id === task.ownerId)?.departmentId;
  
  if (task.createdBy === currentUser.id) return true;
  if (taskDeptId === currentUser.departmentId) return true;
  if (taskDeptId && normalizeStringArray(currentUser.padPermissions).includes(taskDeptId)) return true;
  if (taskDeptId && getScopedDepartmentIds(currentUser, departments).includes(taskDeptId)) return true;
  
  // Also allow if the user is explicitly involved in the task
  if (task.ownerId === currentUser.id) return true;
  if (task.participantIds?.includes(currentUser.id)) return true;
  if (task.approverIds?.includes(currentUser.id)) return true;

  return false;
};

export const canManageTask = (
  task: PADEntry,
  currentUser: User,
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): boolean => {
  if (isAdminUser(currentUser, systemRoles)) return true;
  if (isManagerUser(currentUser) && task.departmentId
    && getManagedDepartmentIds(currentUser, departments).includes(task.departmentId)) return true;
  if (task.ownerId === currentUser.id) return true;
  if (task.participantIds?.includes(currentUser.id)) return true;
  return false;
};

export const canManageProcess = (
  process: { createdBy?: string; departmentId?: string },
  currentUser: User,
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): boolean => {
  if (isAdminUser(currentUser, systemRoles)) return true;
  return hasPermission(currentUser, systemRoles, 'process', 'update');
};

export const canPersistProcess = (
  process: { departmentId?: string },
  currentUser: User,
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): boolean => {
  if (isAdminUser(currentUser, systemRoles)) return true;
  if (hasPermission(currentUser, systemRoles, 'process', 'create') || hasPermission(currentUser, systemRoles, 'process', 'update')) return true;
  if (!isManagerUser(currentUser)) return false;
  return getManagedDepartmentIds(currentUser, departments).includes(process.departmentId || '');
};

export const canManageDepartment = (
  department: Department,
  currentUser: User,
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): boolean => {
  if (isAdminUser(currentUser, systemRoles)) return true;
  return getManagedDepartmentIds(currentUser, departments).includes(department.id);
};

export const canManageReview = (
  department: Department,
  currentUser: User,
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): boolean => canManageDepartment(department, currentUser, systemRoles, departments);

export const hasPermission = (
  user: User,
  systemRoles: SystemRole[],
  menuId: string,
  action: keyof MenuPermission
): boolean => {
  if (isAdminUser(user, systemRoles)) return true;
  if (menuId === 'workbench') return action === 'view';

  // Personal permissions are additive to role permissions.
  const customPermissions = user.customPermissions && typeof user.customPermissions === 'object' && !Array.isArray(user.customPermissions)
    ? user.customPermissions
    : undefined;
  const customAllowed = !!customPermissions?.[menuId]?.[action];

  // Any assigned role can grant the requested action.
  const roleIds = normalizeStringArray(user.systemRoleIds);
  const roleAllowed = roleIds.some(roleId => {
    const role = systemRoles.find(r => r.id === roleId);
    return !!role?.permissions?.[menuId]?.[action];
  });

  return customAllowed || roleAllowed;
};

export const getVisibleDepartments = (user: User, allDepartments: Department[], systemRoles: SystemRole[] = []): Department[] => {
  if (isAdminUser(user, systemRoles)) return allDepartments;

  const visibleIds = new Set<string>();
  if (user.departmentId) visibleIds.add(user.departmentId);
  normalizeStringArray(user.padPermissions).forEach(id => visibleIds.add(id));
  getScopedDepartmentIds(user, allDepartments).forEach(id => visibleIds.add(id));

  // Keep ancestor nodes as navigation wrappers, but only include children that
  // are themselves in the allowed set. This prevents a child employee who can
  // read its parent from seeing the parent's sibling departments.
  const filterTree = (depts: Department[]): Department[] => {
    return depts.map(d => {
      const filteredSubs = d.subDepartments ? filterTree(d.subDepartments) : undefined;

      if (visibleIds.has(d.id) || (filteredSubs && filteredSubs.length > 0)) {
        return {
          ...d,
          subDepartments: filteredSubs && filteredSubs.length > 0 ? filteredSubs : undefined
        };
      }
      return null;
    }).filter(Boolean) as Department[];
  };

  return filterTree(allDepartments);
};

export const getVisibleDepartmentsForOrg = (
  user: User,
  allDepartments: Department[],
  systemRoles: SystemRole[] = []
): Department[] => {
  if (hasPermission(user, systemRoles, 'org', 'view')) return allDepartments;
  return getVisibleDepartments(user, allDepartments, systemRoles);
};
