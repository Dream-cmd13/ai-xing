import { canAssignTaskOwner, getManagedDepartmentIds, isManagerUser } from './permissions';

const toFiniteNumber = (value) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const prepareTaskForPersistence = (
  entry,
  previousTask,
  currentUser,
  users,
  systemRoles,
  mode,
  isAdmin = false,
  departments = []
) => {
  const entryRowVersion = toFiniteNumber(entry?.rowVersion);
  const previousRowVersion = toFiniteNumber(previousTask?.rowVersion);
  const usePreviousVersion = mode === 'update'
    && previousRowVersion !== undefined
    && (entryRowVersion === undefined || previousRowVersion >= entryRowVersion);
  const requestedOwnerId = entry?.ownerId ?? currentUser.id;
  const ownerId = isAdmin
    ? requestedOwnerId
    : mode === 'create'
      ? (canAssignTaskOwner(currentUser, users, requestedOwnerId, systemRoles, departments) ? requestedOwnerId : currentUser.id)
      : previousTask?.ownerId ?? requestedOwnerId;
  const requestedDepartmentId = entry.departmentId ?? previousTask?.departmentId ?? currentUser.departmentId;
  const managerDepartmentIds = isManagerUser(currentUser)
    ? new Set(getManagedDepartmentIds(currentUser, departments))
    : new Set();
  const departmentId = isAdmin
    ? requestedDepartmentId
    : mode === 'create'
      ? (isManagerUser(currentUser) && requestedDepartmentId && managerDepartmentIds.has(requestedDepartmentId)
        ? requestedDepartmentId
        : currentUser.departmentId)
      : requestedDepartmentId;

  return {
    ...entry,
    ownerId,
    createdBy: mode === 'create'
      ? currentUser.id
      : entry.createdBy ?? previousTask?.createdBy ?? currentUser.id,
    departmentId,
    rowVersion: usePreviousVersion ? previousRowVersion : entryRowVersion,
    updatedAt: usePreviousVersion
      ? previousTask?.updatedAt ?? entry.updatedAt
      : entry.updatedAt ?? previousTask?.updatedAt
  };
};
