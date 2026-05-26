import { normalizeForConflictComparison } from '../syncConflictGuard.ts';

export const getLastSavedTask = (lastSavedTasks, taskId) =>
  (lastSavedTasks || []).find((task) => task.id === taskId) || null;

export const hasTaskLocalChanges = (localTasks, lastSavedTasks, taskId) => {
  if (!taskId) return false;

  const localTask = (localTasks || []).find((task) => task.id === taskId);
  const lastSavedTask = getLastSavedTask(lastSavedTasks, taskId);

  if (!localTask || !lastSavedTask) return false;

  return normalizeForConflictComparison(localTask) !== normalizeForConflictComparison(lastSavedTask);
};

export const upsertTasksById = (tasks, entries) => {
  const nextEntries = entries || [];
  const entryMap = new Map(nextEntries.map((entry) => [entry.id, entry]));
  const seen = new Set();

  const updatedTasks = (tasks || []).map((task) => {
    if (entryMap.has(task.id)) {
      seen.add(task.id);
      return entryMap.get(task.id);
    }
    return task;
  });

  nextEntries.forEach((entry) => {
    if (!seen.has(entry.id)) {
      updatedTasks.push(entry);
    }
  });

  return updatedTasks;
};

export const removeTasksById = (tasks, ids) => {
  const deletedIds = new Set(ids || []);
  return (tasks || []).filter((task) => !deletedIds.has(task.id));
};
