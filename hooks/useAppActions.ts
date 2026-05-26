import { useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { 
  getWorkspace, saveWorkspace, addProcess as addDbProcess, updateProcess as updateDbProcess, 
  deleteProcess as deleteDbProcess, updateStrategy, addBusiness, updateBusiness, deleteBusiness, 
  addUser as addDbUser, updateUser as updateDbUser, deleteUser as deleteDbUser, addSystemRole, 
  updateSystemRole, deleteSystemRole, addDepartment as addDbDepartment, updateDepartment as updateDbDepartment, 
  deleteDepartment as deleteDbDepartment, saveAISettings, addTask as addDbTask, updateTask as updateDbTask, deleteTask as deleteDbTask
} from '@/data';
import { PADEntry, ProcessDefinition, ProcessHistory } from '@/types';
import { clearPendingMutation, markPendingMutation, normalizeForConflictComparison } from '@/syncConflictGuard';
import { applyDepartmentPatch, buildDepartmentPatch, hasDepartmentPatchConflict } from '@/utils/departmentSyncState.js';
import { removeTasksById, upsertTasksById } from '@/utils/taskSyncState.js';

export const useAppActions = () => {
  const store = useAppStore();
  const { isAuthenticated, currentUser } = useAuthStore();
  
  const stateRef = useRef(store);
  const saveSuccessTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const savingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    stateRef.current = store;
  }, [store]);

  const dirtyProcessIdsRef = useRef<Set<string>>(new Set());
  const deletedProcessIdsRef = useRef<Set<string>>(new Set());
  const syncStateRef = () => {
    stateRef.current = useAppStore.getState() as any;
  };
  useEffect(() => {
    return () => {
      if (saveSuccessTimeoutRef.current) clearTimeout(saveSuccessTimeoutRef.current);
      if (savingTimeoutRef.current) clearTimeout(savingTimeoutRef.current);
    };
  }, []);

  const executeAtomicOperation = useCallback(async (operation: () => Promise<void>) => {
    if (!isAuthenticated) return;
    store.setIsSaving(true);
    try {
      await operation();
      store.setIsSaving(false);
      store.setIsDirty(false); // Clear dirty on success
      store.setShowSaveSuccess(true);
      setTimeout(() => store.setShowSaveSuccess(false), 3000);
      store.setBackendError(null);
    } catch (error: any) {
      store.setIsSaving(false);
      store.setBackendError(error.message || "操作失败");
    }
  }, [isAuthenticated, store]);

  const showSaveSuccessFeedback = (dirtyStateAfterSuccess: boolean) => {
    store.setIsSaving(false);
    store.setIsDirty(dirtyStateAfterSuccess);
    store.setShowSaveSuccess(true);
    if (saveSuccessTimeoutRef.current) clearTimeout(saveSuccessTimeoutRef.current);
    saveSuccessTimeoutRef.current = setTimeout(() => {
      store.setShowSaveSuccess(false);
      saveSuccessTimeoutRef.current = null;
    }, 3000);
    store.setBackendError(null);
  };

  const rollbackTaskMutation = (
    previousTasks: PADEntry[],
    previousLastSavedTasks: PADEntry[],
    previousDirtyState: boolean,
    error: any
  ) => {
    store.setState({ tasks: previousTasks });
    store.setLastSavedTasks(previousLastSavedTasks);
    store.setIsSaving(false);
    store.setIsDirty(previousDirtyState);
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
    const previousDirtyState = store.isDirty;

    store.setState({ tasks: optimisticTasks });
    store.setIsDirty(true);
    store.setIsSaving(true);
    syncStateRef();

    try {
      const savedEntries: PADEntry[] = [];
      for (const entry of entriesToPersist) {
        markPendingMutation('tasks', entry.id, entry, entry.rowVersion);
        try {
          const savedEntry = mode === 'create'
            ? await addDbTask(entry)
            : await updateDbTask(entry.id, entry);
          savedEntries.push(savedEntry);
        } catch (error) {
          clearPendingMutation('tasks', entry.id);
          throw error;
        }
      }

      const currentTasks = (useAppStore.getState() as any).tasks || [];
      const mergedTasks = upsertTasksById(currentTasks, savedEntries);
      const mergedLastSavedTasks = upsertTasksById(previousLastSavedTasks, savedEntries);

      store.setState({ tasks: mergedTasks });
      store.setLastSavedTasks(mergedLastSavedTasks);
      showSaveSuccessFeedback(previousDirtyState);
      syncStateRef();
      return savedEntries;
    } catch (error: any) {
      rollbackTaskMutation(previousTasks, previousLastSavedTasks, previousDirtyState, error);
      throw error;
    }
  }, [isAuthenticated, store]);

  const persistTaskDeletion = useCallback(async (
    optimisticTasks: PADEntry[],
    taskIds: string[]
  ) => {
    if (!isAuthenticated) return;

    const previousTasks = stateRef.current.tasks || [];
    const previousLastSavedTasks = stateRef.current.lastSavedTasks || [];
    const previousDirtyState = store.isDirty;

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
      showSaveSuccessFeedback(previousDirtyState);
      syncStateRef();
    } catch (error: any) {
      rollbackTaskMutation(previousTasks, previousLastSavedTasks, previousDirtyState, error);
      throw error;
    }
  }, [isAuthenticated, store]);

  const handleSave = useCallback(async () => {
    if (!isAuthenticated) return;
    stateRef.current = useAppStore.getState() as any;
    
    store.setIsSaving(true);
    try {
      markPendingMutation('strategy', 'default', stateRef.current.strategy, stateRef.current.strategy?.rowVersion);
      const savedStrategy = await updateStrategy(stateRef.current.strategy);
      store.setState({ strategy: savedStrategy });

      if (stateRef.current.aiSettings) {
        const savedSettings = await saveAISettings(stateRef.current.aiSettings);
        store.setState({ aiSettings: savedSettings });
      }
      
      const dirtyIds = Array.from(dirtyProcessIdsRef.current);
      const nextProcesses = [...stateRef.current.processes];
      for (const id of dirtyIds as string[]) {
        const processIndex = nextProcesses.findIndex(p => p.id === id);
        const process = processIndex >= 0 ? nextProcesses[processIndex] : null;
        if (process) {
          const isNew = !store.lastSavedProcesses.some(p => p.id === id);
          if (isNew) {
            nextProcesses[processIndex] = await addDbProcess(process);
          } else {
            markPendingMutation('processes', id, process, process.rowVersion);
            try {
            nextProcesses[processIndex] = await updateDbProcess(id, process);
            } catch (error) {
              clearPendingMutation('processes', id);
              throw error;
            }
          }
        }
      }
      
      const deletedIds = Array.from(deletedProcessIdsRef.current);
      for (const id of deletedIds as string[]) {
        await deleteDbProcess(id);
      }
 
      const newDepts = stateRef.current.departments || [];
      const oldDepts = store.lastSavedDepartments;
      const currentIds = new Set(newDepts.map(d => d.id));
      const toDelete = oldDepts.filter(d => !currentIds.has(d.id));
      for (const d of toDelete) {
        await deleteDbDepartment(d.id);
      }
      const savedDepartments: any[] = [];
      for (const newDept of newDepts) {
        const oldDept = oldDepts.find(d => d.id === newDept.id);
        if (!oldDept) {
          savedDepartments.push(await addDbDepartment(newDept));
        } else if (normalizeForConflictComparison(oldDept) !== normalizeForConflictComparison(newDept)) {
          const departmentPatch = buildDepartmentPatch(oldDept, newDept);
          markPendingMutation('departments', newDept.id, newDept, oldDept.rowVersion);
          try {
            savedDepartments.push(await updateDbDepartment(newDept.id, departmentPatch));
          } catch (error) {
            clearPendingMutation('departments', newDept.id);
            const latestDept = (useAppStore.getState() as any).lastSavedDepartments?.find((dept: any) => dept.id === newDept.id);
            if (!latestDept || hasDepartmentPatchConflict(oldDept, newDept, latestDept)) {
              throw error;
            }

            const rebasedDept = applyDepartmentPatch(latestDept, departmentPatch);
            const retryPatch = buildDepartmentPatch(latestDept, rebasedDept);
            const retryFields = Object.keys(retryPatch).filter(key => key !== 'rowVersion');
            if (retryFields.length === 0) {
              savedDepartments.push(latestDept);
              continue;
            }

            markPendingMutation('departments', newDept.id, rebasedDept, latestDept.rowVersion);
            try {
              savedDepartments.push(await updateDbDepartment(newDept.id, retryPatch));
            } catch (retryError) {
              clearPendingMutation('departments', newDept.id);
              throw retryError;
            }
          }
        } else {
          savedDepartments.push(oldDept);
        }
      }

      const newUsers = stateRef.current.users || [];
      const oldUsers = store.lastSavedUsers;
      const userIds = new Set(newUsers.map(u => u.id));
      const deletedUsers = oldUsers.filter(u => !userIds.has(u.id));
      for (const user of deletedUsers) {
        await deleteDbUser(user.id);
      }
      const savedUsers: any[] = [];
      for (const newUser of newUsers) {
        const oldUser = oldUsers.find(u => u.id === newUser.id);
        if (!oldUser) savedUsers.push(await addDbUser(newUser));
        else if (normalizeForConflictComparison(oldUser) !== normalizeForConflictComparison(newUser)) savedUsers.push(await updateDbUser(newUser.id, newUser));
        else savedUsers.push(oldUser);
      }

      const newRoles = stateRef.current.systemRoles || [];
      const oldRoles = store.lastSavedSystemRoles;
      const roleIds = new Set(newRoles.map(r => r.id));
      const deletedRoles = oldRoles.filter(r => !roleIds.has(r.id));
      for (const role of deletedRoles) {
        await deleteSystemRole(role.id);
      }
      const savedRoles: any[] = [];
      for (const newRole of newRoles) {
        const oldRole = oldRoles.find(r => r.id === newRole.id);
        if (!oldRole) savedRoles.push(await addSystemRole(newRole));
        else if (normalizeForConflictComparison(oldRole) !== normalizeForConflictComparison(newRole)) savedRoles.push(await updateSystemRole(newRole.id, newRole));
        else savedRoles.push(oldRole);
      }

      const newBusinesses = stateRef.current.businesses || [];
      const oldBusinesses = store.lastSavedBusinesses;
      const businessIds = new Set(newBusinesses.map(b => b.id));
      const deletedBusinesses = oldBusinesses.filter(b => !businessIds.has(b.id));
      for (const business of deletedBusinesses) {
        await deleteBusiness(business.id);
      }
      const savedBusinesses: any[] = [];
      for (const newBiz of newBusinesses) {
        const oldBiz = oldBusinesses.find(b => b.id === newBiz.id);
        if (!oldBiz) savedBusinesses.push(await addBusiness(newBiz));
        else if (normalizeForConflictComparison(oldBiz) !== normalizeForConflictComparison(newBiz)) {
          markPendingMutation('businesses', newBiz.id, newBiz, newBiz.rowVersion);
          try {
            savedBusinesses.push(await updateBusiness(newBiz.id, newBiz));
          } catch (error) {
            clearPendingMutation('businesses', newBiz.id);
            throw error;
          }
        } else savedBusinesses.push(oldBiz);
      }
      
      store.setState({ 
        processes: nextProcesses,
        departments: savedDepartments,
        users: savedUsers,
        systemRoles: savedRoles,
        businesses: savedBusinesses
      });
      store.setLastSavedStrategy(savedStrategy);
      store.setLastSavedDepartments(savedDepartments);
      store.setLastSavedProcesses(nextProcesses);
      store.setLastSavedUsers(savedUsers);
      store.setLastSavedSystemRoles(savedRoles);
      store.setLastSavedBusinesses(savedBusinesses);
      dirtyProcessIdsRef.current.clear();
      deletedProcessIdsRef.current.clear();

      store.setIsSaving(false);
      store.setIsDirty(false);
      store.setShowSaveSuccess(true);
      setTimeout(() => store.setShowSaveSuccess(false), 3000);
      store.setBackendError(null);
    } catch (error: any) {
      clearPendingMutation('strategy', 'default');
      store.setIsSaving(false);
      store.setBackendError(error.message || "保存失败");
    }
  }, [isAuthenticated, store]);

  const saveStateDirectly = async (newState: any) => {
    if (!isAuthenticated) return;
    store.setState(newState);
    store.setIsDirty(true);
    executeAtomicOperation(async () => {
      if (newState.aiSettings) {
        const savedSettings = await saveAISettings(newState.aiSettings);
        store.setState({ aiSettings: savedSettings });
      } else {
        await saveWorkspace(newState);
      }
      store.setIsDirty(false);
    });
  };

  const handleSetDepartments = (newDepts: any[]) => {
    store.setDepartments(newDepts);
    store.setIsDirty(true);
    syncStateRef();
  };

  const handleSetUsers = (newUsers: any[]) => {
    store.setUsers(newUsers);
    store.setIsDirty(true);
    syncStateRef();
  };

  const handleSetSystemRoles = (newRoles: any[]) => {
    store.setSystemRoles(newRoles);
    store.setIsDirty(true);
    syncStateRef();
  };

  const handleSetAISettings = (newAISettings: any) => {
    store.setAISettings(newAISettings);
    store.setIsDirty(true);
    syncStateRef();
  };

  const submitAISettings = async (newAISettings: any) => {
    if (!isAuthenticated) return;
    store.setIsSaving(true);
    try {
      const nextSettings = {
        ...stateRef.current.aiSettings,
        ...newAISettings
      };
      markPendingMutation('settings', 'default', nextSettings, stateRef.current.aiSettings?.rowVersion);
      const savedSettings = await saveAISettings(nextSettings);
      store.setState({ aiSettings: savedSettings });
      store.setBackendError(null);
      store.setIsDirty(false);
      store.setShowSaveSuccess(true);
      setTimeout(() => store.setShowSaveSuccess(false), 3000);
    } catch (error: any) {
      clearPendingMutation('settings', 'default');
      store.setBackendError(error.message || '保存系统设置失败');
    } finally {
      store.setIsSaving(false);
    }
  };

  const handleSetBusinesses = (businesses: any[]) => {
    store.setBusinesses(businesses);
    store.setIsDirty(true);
    syncStateRef();
  };

  const setProcessData = (id: string, nodes: any[], links: any[]) => {
    store.updateProcess(id, { nodes, links });
    store.setIsDirty(true);
    dirtyProcessIdsRef.current.add(id);
    syncStateRef();
  };

  const updateProcessProps = (id: string, props: Partial<ProcessDefinition>) => {
    store.updateProcess(id, props);
    store.setIsDirty(true);
    dirtyProcessIdsRef.current.add(id);
    syncStateRef();
  };

  const addProcess = (category: any, level: 1 | 2, name: string) => {
    const newProcess: ProcessDefinition = {
      id: `proc-${Date.now()}`, name, category, level, version: 'Draft', isActive: false, type: category === '辅助体系' ? 'auxiliary' : 'main',
      owner: '', coOwner: '', objective: '', nodes: [], links: [], history: [], updatedAt: Date.now()
    };
    store.addProcess(newProcess);
    dirtyProcessIdsRef.current.add(newProcess.id);
    store.setIsDirty(true);
    syncStateRef();
  };

  const deleteProcessFn = (id: string) => {
    store.deleteProcess(id);
    deletedProcessIdsRef.current.add(id);
    dirtyProcessIdsRef.current.delete(id);
    store.setIsDirty(true);
    syncStateRef();
  };

  const publishProcess = (id: string, version: string) => {
    const processToPublish = stateRef.current.processes.find(p => p.id === id);
    if (!processToPublish) return;
    
    const newRecord: ProcessHistory = { id: `hist-${Date.now()}`, version, nodes: JSON.parse(JSON.stringify(processToPublish.nodes)), links: JSON.parse(JSON.stringify(processToPublish.links)), publishedAt: Date.now(), publishedBy: currentUser?.name || 'System' };
    const newHistory = [newRecord, ...processToPublish.history];
    
    store.updateProcess(id, { version, isActive: true, history: newHistory });
    dirtyProcessIdsRef.current.add(id);
    store.setIsDirty(true);
    syncStateRef();
  };

  const rollbackProcess = (procId: string, historyId: string) => {
    const processToRollback = stateRef.current.processes.find(p => p.id === procId);
    if (!processToRollback) return;
    
    const record = processToRollback.history.find(h => h.id === historyId);
    if (!record) return;
    
    const newNodes = JSON.parse(JSON.stringify(record.nodes));
    const newLinks = JSON.parse(JSON.stringify(record.links));
    
    store.updateProcess(procId, { nodes: newNodes, links: newLinks });
    dirtyProcessIdsRef.current.add(procId);
    store.setIsDirty(true);
    syncStateRef();
  };

  const handleSetTasks = (newTasks: any[]) => {
    store.setTasks(newTasks);
    store.setIsDirty(true);
    syncStateRef();
  };

  const handleSetStrategy = (strategyPartial: any) => {
    store.setStrategy(strategyPartial);
    store.setIsDirty(true);
    syncStateRef();
  };

  return {
    handleSave,
    saveStateDirectly,
    executeAtomicOperation,
    handleSetDepartments,
    handleSetUsers,
    handleSetSystemRoles,
    handleSetAISettings,
    submitAISettings,
    handleSetBusinesses,
    setProcessData,
    updateProcessProps,
    addProcess,
    deleteProcessFn,
    publishProcess,
    rollbackProcess,
    handleSetTasks,
    handleSetStrategy,
    persistTaskEntries,
    persistTaskDeletion
  };
};
