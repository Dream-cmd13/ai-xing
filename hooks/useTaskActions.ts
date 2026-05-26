import { MutableRefObject, useCallback } from 'react';
import { addTask as addDbTask, updateTask as updateDbTask, deleteTask as deleteDbTask } from '@/data';
import { AppStoreState, useAppStore } from '@/store/useAppStore';
import { PADEntry } from '@/types';
import { removeTasksById, upsertTasksById } from '@/utils/taskSyncState.js';

interface UseTaskActionsOptions {
  store: AppStoreState;
  isAuthenticated: boolean;
  stateRef: MutableRefObject<any>;
  syncStateRef: () => void;
  showSaveSuccessFeedback: (clearedDomains: string[]) => void;
}

export const useTaskActions = ({
  store,
  isAuthenticated,
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
    store.setBackendError(error?.message || '任务保存失败');
    syncStateRef();
  };

  const persistTaskEntries = useCallback(async (
    optimisticTasks: PADEntry[],
    entriesToPersist: PADEntry[],
    mode: 'create' | 'update'
  ) => {
    if (!isAuthenticated) return [];

    const previousTasks = stateRef.current.tasks || [];
    const previousLastSavedTasks = stateRef.current.lastSavedTasks || [];
    const previousDirtyDomains = [...store.dirtyDomains];

    store.setState({ tasks: optimisticTasks });
    store.setIsDirty(true);
    store.setIsSaving(true);
    syncStateRef();

    try {
      const savedEntries: PADEntry[] = [];
      for (const entry of entriesToPersist) {
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
  }, [isAuthenticated, showSaveSuccessFeedback, stateRef, store, syncStateRef]);

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
        await deleteDbTask(taskId);
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
