/**
 * Decide whether the current execution-board scope may create a task.
 * Employees create from their own department or one of its ancestor OKR views;
 * managers and admins must manage the selected department.
 */
export const canCreateExecutionTaskForScope = ({
  hasCreatePermission,
  isAdmin,
  isManager,
  canManageSelectedDepartment,
  isSelectedDepartmentSelfOrAncestor,
}) => {
  if (!hasCreatePermission) return false;
  if (isAdmin || isManager) return canManageSelectedDepartment;
  return isSelectedDepartmentSelfOrAncestor;
};

/**
 * Employees may open task creation from an ancestor OKR view, but the persisted
 * task must still belong to their own department. Managers and admins use the
 * department selected when the task was created.
 */
export const resolveExecutionTaskCreationDepartmentId = ({
  isAdmin,
  isManager,
  selectedDepartmentId,
  currentDepartmentId,
}) => {
  if (isAdmin || isManager) return selectedDepartmentId || currentDepartmentId;
  return currentDepartmentId;
};
