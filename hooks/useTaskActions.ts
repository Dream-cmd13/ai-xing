import { MutableRefObject, useCallback } from 'react';
import { addTask as addDbTask, updateTask as updateDbTask, deleteTask as deleteDbTask } from '@/data';
import { AppStoreState, useAppStore } from '@/store/useAppStore';
import { PADEntry, User } from '@/types';
import { removeTasksById, upsertTasksById } from '@/utils/taskSyncState.js';
import { getUserFacingError } from '@/utils/userFacingError';

interface UseTaskActionsOptions {
  store: AppStoreState;
  isAuthenticated: boolean;
  currentUser: User | null;
  stateRef: MutableRefObject<any>;
  syncStateRef: () => void;
  showSaveSuccessFeedback: (clearedDomains: string[]) => void;
}

export const useTaskActions = ({
  store,
  isAuthenticated,
  currentUser,
  stateRef,
  syncStateRef,
  showSaveSuccessFeedback
}: UseTaskActionsOptions) => {
  const rollbackTaskMutation = (
    previousTasks: PADEntry[],
    previousLastSavedTasks: PADEntry[],
    previousDirtyDomains: string[],
    error: any
  ) => {
    store.setState({ tasks: previousTasks });
    store.setLastSavedTasks(previousLastSavedTasks);
    store.setDirtyDomains(previousDirtyDomains as any);
    store.setIsSaving(false);
    store.setBackendError(getUserFacingError(error, '任务保存失败，请稍后重试'));
    syncStateRef();
  };

  const persistTaskEntries = useCallback(async (
    optimisticTasks: PADEntry[],
    entriesToPersist: PADEntry[],
    mode: 'create' | 'update'
  ) => {
    if (!isAuthenticated || !currentUser) return [];

    const previousTasks = stateRef.current.tasks || [];
    const previousLastSavedTasks = stateRef.current.lastSavedTasks || [];
    const previousDirtyDomains = [...store.dirtyDomains];
    const normalizedEntries = entriesToPersist.map((entry) => {
      const previousTask = previousLastSavedTasks.find((task) => task.id === entry.id);
      return {
        ...entry,
        createdBy: mode === 'create'
          ? currentUser.id
          : entry.createdBy ?? previousTask?.createdBy ?? currentUser.id,
        departmentId: entry.departmentId ?? previousTask?.departmentId ?? currentUser.departmentId
      };
    });
    const optimisticTaskMap = new Map(normalizedEntries.map((entry) => [entry.id, entry]));
    const nextOptimisticTasks = optimisticTasks.map((task) => optimisticTaskMap.get(task.id) ?? task);

    store.setState({ tasks: nextOptimisticTasks });
    store.setIsDirty(true);
    store.setIsSaving(true);
    syncStateRef();

    try {
      const savedEntries: PADEntry[] = [];
      for (const entry of normalizedEntries) {
        const savedEntry = mode === 'create'
          ? await addDbTask(entry)
          : await updateDbTask(entry.id, entry);
        savedEntries.push(savedEntry);
      }

      const currentTasks = (useAppStore.getState() as any).tasks || [];
      const mergedTasks = upsertTasksById(currentTasks, savedEntries);
      const mergedLastSavedTasks = upsertTasksById(previousLastSavedTasks, savedEntries);

      store.setState({ tasks: mergedTasks });
      store.setLastSavedTasks(mergedLastSavedTasks);
      showSaveSuccessFeedback(['tasks']);
      syncStateRef();
      return savedEntries;
    } catch (error: any) {
      rollbackTaskMutation(previousTasks, previousLastSavedTasks, previousDirtyDomains, error);
      throw error;
    }
  }, [currentUser, isAuthenticated, showSaveSuccessFeedback, stateRef, store, syncStateRef]);

  const persistTaskDeletion = useCallback(async (
    optimisticTasks: PADEntry[],
    taskIds: string[]
  ) => {
    if (!isAuthenticated) return;

    const previousTasks = stateRef.current.tasks || [];
    const previousLastSavedTasks = stateRef.current.lastSavedTasks || [];
    const previousDirtyDomains = [...store.dirtyDomains];

    store.setState({ tasks: optimisticTasks });
    store.setIsDirty(true);
    store.setIsSaving(true);
    syncStateRef();

    try {
      for (const taskId of taskIds) {
        const previousTask = previousLastSavedTasks.find((task) => task.id === taskId);
        if (!previousTask) {
          continue;
        }
        await deleteDbTask(taskId, previousTask.rowVersion);
      }

      const mergedLastSavedTasks = removeTasksById(previousLastSavedTasks, taskIds);
      store.setLastSavedTasks(mergedLastSavedTasks);
      showSaveSuccessFeedback(['tasks']);
      syncStateRef();
    } catch (error: any) {
      rollbackTaskMutation(previousTasks, previousLastSavedTasks, previousDirtyDomains, error);
      throw error;
    }
  }, [isAuthenticated, showSaveSuccessFeedback, stateRef, store, syncStateRef]);

  return {
    persistTaskEntries,
    persistTaskDeletion
  };
};
