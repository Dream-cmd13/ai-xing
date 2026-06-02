import { canAssignTaskOwner } from './permissions';

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
  isAdmin = false
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
      ? (canAssignTaskOwner(currentUser, users, requestedOwnerId, systemRoles) ? requestedOwnerId : currentUser.id)
      : previousTask?.ownerId ?? requestedOwnerId;
  const departmentId = isAdmin
    ? entry.departmentId ?? previousTask?.departmentId ?? currentUser.departmentId
    : mode === 'create'
      ? currentUser.departmentId ?? entry.departmentId ?? previousTask?.departmentId
      : entry.departmentId ?? previousTask?.departmentId ?? currentUser.departmentId;

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
