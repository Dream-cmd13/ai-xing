import { User, SystemRole, MenuPermission, Department, PADEntry, UserRole } from '../types';

export const normalizeUserRole = (role: string | undefined): UserRole => {
  if (role === 'Admin' || role === 'Manager' || role === 'Employee') return role;
  return 'Employee';
};

export const isAdminUser = (user: User, systemRoles: SystemRole[] = []): boolean => {
  if (user.role === 'Admin') return true;

  if (user.systemRoleIds && systemRoles.length > 0) {
    return user.systemRoleIds.some(roleId => {
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
  currentUserId: string
): Department[] => {
  const matches: Department[] = [];

  departments.forEach((department) => {
    if (department.managerUserId === currentUserId) {
      matches.push(department);
    }

    if (department.subDepartments?.length) {
      matches.push(...collectManagedDepartments(department.subDepartments, currentUserId));
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

export const getManagedDepartments = (
  currentUser: User,
  departments: Department[] = []
): Department[] => collectManagedDepartments(departments, currentUser.id);

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

const isManagedDepartment = (targetDepartmentId: string | undefined, currentUser: User, departments: Department[] = []): boolean => {
  if (!targetDepartmentId) return false;
  return getManagedDepartmentIds(currentUser, departments).includes(targetDepartmentId);
};

export const canViewTask = (task: PADEntry, currentUser: User, users: User[], systemRoles: SystemRole[] = [], departments: Department[] = []): boolean => {
  if (isAdminUser(currentUser, systemRoles) || isManagerUser(currentUser)) return true;

  const taskDeptId = task.departmentId || users.find(u => u.id === task.ownerId)?.departmentId;
  
  if (task.createdBy === currentUser.id) return true;
  if (taskDeptId === currentUser.departmentId) return true;
  if (currentUser.padPermissions && taskDeptId && currentUser.padPermissions.includes(taskDeptId)) return true;
  
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
  if (isManagerUser(currentUser) && isManagedDepartment(task.departmentId, currentUser, departments)) return true;
  return task.createdBy === currentUser.id;
};

export const canManageProcess = (
  process: { createdBy?: string; departmentId?: string },
  currentUser: User,
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): boolean => {
  if (isAdminUser(currentUser, systemRoles)) return true;
  if (isManagerUser(currentUser) && isManagedDepartment(process.departmentId, currentUser, departments)) return true;
  return process.createdBy === currentUser.id;
};

export const canPersistProcess = (
  process: { departmentId?: string },
  currentUser: User,
  systemRoles: SystemRole[] = [],
  departments: Department[] = []
): boolean => {
  if (isAdminUser(currentUser, systemRoles)) return true;
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
  if (!isManagerUser(currentUser)) return false;
  return isManagedDepartment(department.id, currentUser, departments);
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
  if (user.customPermissions && user.customPermissions[menuId]) {
    return user.customPermissions[menuId][action];
  }

  // Check role permissions
  if (user.systemRoleIds && user.systemRoleIds.length > 0) {
    for (const roleId of user.systemRoleIds) {
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
  if (user.padPermissions) {
    (user.padPermissions || []).forEach(id => visibleIds.add(id));
  }

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
