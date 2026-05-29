import { User, SystemRole, MenuPermission, Department, PADEntry, UserRole } from '../types';

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

const collectDepartmentIds = (department: Department): string[] => {
  const ids = [department.id];

  (department.subDepartments || []).forEach((subDepartment) => {
    ids.push(...collectDepartmentIds(subDepartment));
  });

  return ids;
};

const getScopedDepartmentIds = (
  currentUser: User,
  departments: Department[] = []
): string[] => {
  const scopedRoots: Department[] = [];
  const addDepartmentScope = (departmentId: string | undefined) => {
    if (!departmentId) return;
    const department = findDepartmentById(departments, departmentId);
    if (department) scopedRoots.push(department);
  };

  addDepartmentScope(currentUser.departmentId);
  scopedRoots.push(...getManagedDepartments(currentUser, departments));

  return Array.from(
    new Set(scopedRoots.flatMap((department) => collectDepartmentIds(department)))
  );
};

export const getManagedDepartments = (
  currentUser: User,
  departments: Department[] = []
): Department[] => collectManagedDepartments(departments, currentUser);

export const getManagedDepartmentIds = (
  currentUser: User,
  departments: Department[] = []
): string[] => Array.from(
  new Set(
    getManagedDepartments(currentUser, departments).flatMap((department) => collectDepartmentIds(department))
  )
);

export const getPrimaryManagedDepartmentId = (
  currentUser: User,
  departments: Department[] = []
): string | undefined => getManagedDepartmentIds(currentUser, departments)[0];

export const canViewTask = (task: PADEntry, currentUser: User, users: User[], systemRoles: SystemRole[] = [], departments: Department[] = []): boolean => {
  if (isAdminUser(currentUser, systemRoles) || isManagerUser(currentUser)) return true;

  const taskDeptId = task.departmentId || users.find(u => u.id === task.ownerId)?.departmentId;
  
  if (task.createdBy === currentUser.id) return true;
  if (taskDeptId === currentUser.departmentId) return true;
  if (taskDeptId && normalizeStringArray(currentUser.padPermissions).includes(taskDeptId)) return true;
  
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
  if (task.departmentId && currentUser.departmentId && task.departmentId === currentUser.departmentId) return true;
  if (task.participantIds?.includes(currentUser.id)) return true;
  if (task.approverIds?.includes(currentUser.id)) return true;
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
  return getScopedDepartmentIds(currentUser, departments).includes(department.id);
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

  // Check custom permissions first (override)
  const customPermissions = user.customPermissions && typeof user.customPermissions === 'object' && !Array.isArray(user.customPermissions)
    ? user.customPermissions
    : undefined;
  if (customPermissions && customPermissions[menuId]) {
    return customPermissions[menuId][action];
  }

  // Check role permissions
  const roleIds = normalizeStringArray(user.systemRoleIds);
  if (roleIds.length > 0) {
    for (const roleId of roleIds) {
      const role = systemRoles.find(r => r.id === roleId);
      if (role && role.permissions && role.permissions[menuId] && role.permissions[menuId][action]) {
        return true;
      }
    }
  }

  // Default to false if no permission is found
  return false;
};

export const getVisibleDepartments = (user: User, allDepartments: Department[], systemRoles: SystemRole[] = []): Department[] => {
  if (isAdminUser(user, systemRoles) || isManagerUser(user)) return allDepartments;

  const visibleIds = new Set<string>();
  if (user.departmentId) visibleIds.add(user.departmentId);
  normalizeStringArray(user.padPermissions).forEach(id => visibleIds.add(id));

  // Helper to check if a department or any of its ancestors is in visibleIds
  const isVisible = (dept: Department, path: string[] = []): boolean => {
    if (visibleIds.has(dept.id)) return true;
    for (const p of path) {
      if (visibleIds.has(p)) return true;
    }
    return false;
  };

  const filterTree = (depts: Department[], path: string[] = []): Department[] => {
    return depts.map(d => {
      const currentPath = [...path, d.id];
      const visible = isVisible(d, path);
      
      // If this department is visible, all its sub-departments are visible
      // If it's not visible, maybe some sub-department is visible, so we must traverse
      
      let filteredSubs: Department[] | undefined;
      if (d.subDepartments) {
        filteredSubs = filterTree(d.subDepartments, currentPath);
        if (filteredSubs.length === 0) filteredSubs = undefined;
      }

      if (visible || (filteredSubs && filteredSubs.length > 0)) {
        return {
          ...d,
          subDepartments: filteredSubs
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
