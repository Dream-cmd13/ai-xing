const toFiniteNumber = (value) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const prepareTaskForPersistence = (entry, previousTask, currentUser, mode, isAdmin = false) => {
  const entryRowVersion = toFiniteNumber(entry?.rowVersion);
  const previousRowVersion = toFiniteNumber(previousTask?.rowVersion);
  const usePreviousVersion = mode === 'update'
    && previousRowVersion !== undefined
    && (entryRowVersion === undefined || previousRowVersion >= entryRowVersion);
  const ownerId = isAdmin
    ? entry.ownerId
    : mode === 'create'
      ? currentUser.id
      : previousTask?.ownerId ?? entry.ownerId;

  return {
    ...entry,
    ownerId,
    createdBy: mode === 'create'
      ? currentUser.id
      : entry.createdBy ?? previousTask?.createdBy ?? currentUser.id,
    departmentId: entry.departmentId ?? previousTask?.departmentId ?? currentUser.departmentId,
    rowVersion: usePreviousVersion ? previousRowVersion : entryRowVersion,
    updatedAt: usePreviousVersion
      ? previousTask?.updatedAt ?? entry.updatedAt
      : entry.updatedAt ?? previousTask?.updatedAt
  };
};
