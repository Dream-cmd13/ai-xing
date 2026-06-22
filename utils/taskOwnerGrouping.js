const UNKNOWN_OWNER_NAME = '未分配';

export const createTaskOwnerSections = (tasks, users, managerUserId) => {
  const usersById = new Map(users.map((user) => [user.id, user]));
  const groups = [];
  const groupsByOwner = new Map();

  tasks.forEach((task) => {
    const ownerId = task.ownerId || '';

    if (!groupsByOwner.has(ownerId)) {
      const group = {
        ownerId,
        originalIndex: groups.length,
        tasks: [],
      };
      groupsByOwner.set(ownerId, group);
      groups.push(group);
    }

    groupsByOwner.get(ownerId).tasks.push(task);
  });

  const sortedGroups = [...groups].sort((a, b) => {
    const aIsManager = Boolean(managerUserId && a.ownerId === managerUserId);
    const bIsManager = Boolean(managerUserId && b.ownerId === managerUserId);
    if (aIsManager !== bIsManager) return aIsManager ? -1 : 1;
    return a.originalIndex - b.originalIndex;
  });

  return sortedGroups.flatMap((group) => {
    const ownerName = usersById.get(group.ownerId)?.name || UNKNOWN_OWNER_NAME;
    const isDepartmentManager = Boolean(managerUserId && group.ownerId === managerUserId);

    return group.tasks.map((task, taskIndex) => ({
      task,
      ownerId: group.ownerId,
      ownerName,
      isDepartmentManager,
      isFirstTaskForOwner: taskIndex === 0,
    }));
  });
};
