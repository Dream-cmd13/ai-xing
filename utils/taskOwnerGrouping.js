const UNKNOWN_OWNER_NAME = 'Unassigned';
const DEPARTMENT_MANAGER_ROLE_NAME = '\u90e8\u95e8\u957f';
const PINYIN_COLLATOR = new Intl.Collator('zh-Hans-u-co-pinyin');

const normalizeManagerUserIds = (managerUserIds) => {
  if (!managerUserIds) return new Set();
  return new Set(Array.isArray(managerUserIds) ? managerUserIds.filter(Boolean) : [managerUserIds]);
};

export const getDepartmentManagerUserIds = (department, users = []) => {
  if (!department) return [];

  const managerIds = new Set();
  if (department.managerUserId) managerIds.add(department.managerUserId);

  Object.entries(department.roleMembers || {}).forEach(([roleName, memberIds]) => {
    if (roleName === DEPARTMENT_MANAGER_ROLE_NAME && Array.isArray(memberIds)) {
      memberIds.forEach((memberId) => {
        if (memberId) managerIds.add(memberId);
      });
    }
  });

  users.forEach((user) => {
    const configuredManagerName = department.managerName || '';
    const matchesConfiguredManager = configuredManagerName
      && (user.name === configuredManagerName || user.username === configuredManagerName);
    if ((user.role === 'Manager' && user.departmentId === department.id) || matchesConfiguredManager) {
      managerIds.add(user.id);
    }
  });

  return Array.from(managerIds);
};

export const createTaskOwnerSections = (tasks, users, managerUserIds) => {
  const usersById = new Map(users.map((user) => [user.id, user]));
  const managerIdSet = normalizeManagerUserIds(managerUserIds);
  const groups = [];
  const groupsByOwner = new Map();

  tasks.forEach((task) => {
    const ownerId = task.ownerId || '';

    if (!groupsByOwner.has(ownerId)) {
      const group = {
        ownerId,
        originalIndex: groups.length,
        ownerName: usersById.get(ownerId)?.name || UNKNOWN_OWNER_NAME,
        tasks: [],
      };
      groupsByOwner.set(ownerId, group);
      groups.push(group);
    }

    groupsByOwner.get(ownerId).tasks.push(task);
  });

  const sortedGroups = [...groups].sort((a, b) => {
    const aIsManager = managerIdSet.has(a.ownerId);
    const bIsManager = managerIdSet.has(b.ownerId);
    if (aIsManager !== bIsManager) return aIsManager ? -1 : 1;

    const pinyinCompare = PINYIN_COLLATOR.compare(a.ownerName, b.ownerName);
    if (pinyinCompare !== 0) return pinyinCompare;

    const nameCompare = a.ownerName.localeCompare(b.ownerName, 'zh-Hans-CN');
    if (nameCompare !== 0) return nameCompare;

    return a.ownerId.localeCompare(b.ownerId, 'en');
  });

  return sortedGroups.flatMap((group) => {
    const ownerName = usersById.get(group.ownerId)?.name || UNKNOWN_OWNER_NAME;
    const isDepartmentManager = managerIdSet.has(group.ownerId);

    return group.tasks.map((task, taskIndex) => ({
      task,
      ownerId: group.ownerId,
      ownerName,
      isDepartmentManager,
      isFirstTaskForOwner: taskIndex === 0,
    }));
  });
};
