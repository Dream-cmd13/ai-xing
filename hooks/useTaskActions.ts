import { MutableRefObject, useCallback, useRef } from 'react';
import { addTask as addDbTask, updateTask as updateDbTask, deleteTask as deleteDbTask, getTaskById, invalidateVisibleTaskScopeCache } from '@/data';
import { AppStoreState, useAppStore } from '@/store/useAppStore';
import { PADEntry, User } from '@/types';
import { isAdminUser } from '@/utils/permissions';
import { prepareTaskForPersistence } from '@/utils/taskPersistence.js';
import { removeTasksById, resolveLatestTaskBaseline, upsertTasksById } from '@/utils/taskSyncState.js';
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
  const taskMutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueTaskMutation = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const previousMutation = taskMutationQueueRef.current;
    let releaseCurrentMutation: () => void = () => {};

    taskMutationQueueRef.current = new Promise<void>((resolve) => {
      releaseCurrentMutation = resolve;
    });

    await previousMutation;

    try {
      return await operation();
    } finally {
      releaseCurrentMutation();
    }
  }, []);

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
    return enqueueTaskMutation(async () => {
      if (!isAuthenticated || !currentUser) return [];

      stateRef.current = useAppStore.getState() as any;

      const previousTasks = stateRef.current.tasks || [];
      const previousLastSavedTasks = stateRef.current.lastSavedTasks || [];
      const previousDirtyDomains = [...store.dirtyDomains];
      const currentUserIsAdmin = isAdminUser(currentUser, store.systemRoles || []);
      const normalizedEntries: PADEntry[] = [];

      for (const entry of entriesToPersist) {
        const previousTask = previousLastSavedTasks.find((task) => task.id === entry.id);
        const latestTask = mode === 'update'
          ? await getTaskById(entry.id)
          : null;
        const taskBaseline = mode === 'update'
          ? resolveLatestTaskBaseline(previousTask, latestTask)
          : previousTask;

        normalizedEntries.push(prepareTaskForPersistence(
          entry,
          taskBaseline,
          currentUser,
          store.users || [],
          store.systemRoles || [],
          mode,
          currentUserIsAdmin,
          store.departments || []
        ));
      }

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
        invalidateVisibleTaskScopeCache(currentUser?.id);
        showSaveSuccessFeedback(['tasks']);
        syncStateRef();
        return savedEntries;
      } catch (error: any) {
        rollbackTaskMutation(previousTasks, previousLastSavedTasks, previousDirtyDomains, error);
        throw error;
      }
    });
  }, [currentUser, enqueueTaskMutation, isAuthenticated, showSaveSuccessFeedback, stateRef, store, syncStateRef]);

  const persistTaskDeletion = useCallback(async (
    optimisticTasks: PADEntry[],
    taskIds: string[]
  ) => {
    return enqueueTaskMutation(async () => {
      if (!isAuthenticated) return;

      stateRef.current = useAppStore.getState() as any;

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
        invalidateVisibleTaskScopeCache(currentUser?.id);
        showSaveSuccessFeedback(['tasks']);
        syncStateRef();
      } catch (error: any) {
        rollbackTaskMutation(previousTasks, previousLastSavedTasks, previousDirtyDomains, error);
        throw error;
      }
    });
  }, [enqueueTaskMutation, isAuthenticated, showSaveSuccessFeedback, stateRef, store, syncStateRef]);

  return {
    persistTaskEntries,
    persistTaskDeletion
  };
};
