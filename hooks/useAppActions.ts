import { useCallback, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { debounce, memoize } from 'lodash';
import { 
  getWorkspace, saveWorkspace, addProcess as addDbProcess, updateProcess as updateDbProcess, 
  deleteProcess as deleteDbProcess, updateStrategy, addBusiness, updateBusiness, deleteBusiness, 
  addUser as addDbUser, updateUser as updateDbUser, deleteUser as deleteDbUser, addSystemRole, 
  updateSystemRole, deleteSystemRole, addDepartment as addDbDepartment, updateDepartment as updateDbDepartment, 
  deleteDepartment as deleteDbDepartment 
} from '@/data';
import { ProcessDefinition, ProcessHistory } from '@/types';

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

  // Debounced save functions to prevent race conditions during rapid typing
  const debouncedSaveStrategy = useMemo(
    () => debounce(async (strategyToSave: any) => {
      if (!isAuthenticated) return;
      
      // Only show saving indicator if it takes more than 300ms
      if (savingTimeoutRef.current) clearTimeout(savingTimeoutRef.current);
      savingTimeoutRef.current = setTimeout(() => store.setIsSaving(true), 300);
      
      try {
        await updateStrategy(strategyToSave);
        if (savingTimeoutRef.current) {
          clearTimeout(savingTimeoutRef.current);
          savingTimeoutRef.current = null;
        }
        store.setIsSaving(false);
        store.setLastSavedStrategy(strategyToSave);
        store.setShowSaveSuccess(true);
        
        if (saveSuccessTimeoutRef.current) clearTimeout(saveSuccessTimeoutRef.current);
        saveSuccessTimeoutRef.current = setTimeout(() => {
          store.setShowSaveSuccess(false);
          saveSuccessTimeoutRef.current = null;
        }, 2000);
        
        store.setBackendError(null);
        store.setIsDirty(false);
      } catch (error: any) {
        if (savingTimeoutRef.current) {
          clearTimeout(savingTimeoutRef.current);
          savingTimeoutRef.current = null;
        }
        store.setIsSaving(false);
        store.setBackendError(error.message || "保存战略失败");
      }
    }, 1000),
    [isAuthenticated, store]
  );

  const debouncedSaveProcess = useMemo(
    () => debounce(async (id: string, processToSave: any) => {
      if (!isAuthenticated) return;
      
      if (savingTimeoutRef.current) clearTimeout(savingTimeoutRef.current);
      savingTimeoutRef.current = setTimeout(() => store.setIsSaving(true), 300);
      
      try {
        await updateDbProcess(id, processToSave);
        if (savingTimeoutRef.current) {
          clearTimeout(savingTimeoutRef.current);
          savingTimeoutRef.current = null;
        }
        store.setIsSaving(false);
        store.setLastSavedProcesses(stateRef.current.processes);
        store.setShowSaveSuccess(true);
        
        if (saveSuccessTimeoutRef.current) clearTimeout(saveSuccessTimeoutRef.current);
        saveSuccessTimeoutRef.current = setTimeout(() => {
          store.setShowSaveSuccess(false);
          saveSuccessTimeoutRef.current = null;
        }, 2000);
        
        store.setBackendError(null);
        store.setIsDirty(false);
      } catch (error: any) {
        if (savingTimeoutRef.current) {
          clearTimeout(savingTimeoutRef.current);
          savingTimeoutRef.current = null;
        }
        store.setIsSaving(false);
        store.setBackendError(error.message || "保存流程失败");
      }
    }, 1000),
    [isAuthenticated, store]
  );

  const debouncedSaveDepartments = useMemo(
    () => debounce(async (deptsToSave: any[]) => {
      if (!isAuthenticated) return;
      store.setIsSaving(true);
      try {
        const oldDepts = store.lastSavedDepartments;
        const currentIds = new Set(deptsToSave.map(d => d.id));
        const toDelete = oldDepts.filter(d => !currentIds.has(d.id));
        for (const d of toDelete) await deleteDbDepartment(d.id);
        for (const newDept of deptsToSave) {
          const oldDept = oldDepts.find(d => d.id === newDept.id);
          if (!oldDept) await addDbDepartment(newDept);
          else if (JSON.stringify(oldDept) !== JSON.stringify(newDept)) await updateDbDepartment(newDept.id, newDept);
        }
        store.setLastSavedDepartments(deptsToSave);
        store.setShowSaveSuccess(true);
        setTimeout(() => store.setShowSaveSuccess(false), 3000);
        store.setBackendError(null);
      } catch (error: any) {
        store.setBackendError(error.message || "保存部门失败");
      } finally {
        store.setIsSaving(false);
        // Only clear dirty if the current departments in store matches what we just saved
        if (JSON.stringify(stateRef.current.departments) === JSON.stringify(deptsToSave)) {
          store.setIsDirty(false);
        }
      }
    }, 1000),
    [isAuthenticated, store]
  );

  // Cleanup debounced functions on unmount
  useEffect(() => {
    return () => {
      debouncedSaveStrategy.flush();
      debouncedSaveDepartments.flush();
      if ((debouncedSaveProcess as any).flush) (debouncedSaveProcess as any).flush();
      if (saveSuccessTimeoutRef.current) clearTimeout(saveSuccessTimeoutRef.current);
      if (savingTimeoutRef.current) clearTimeout(savingTimeoutRef.current);
    };
  }, [debouncedSaveStrategy, debouncedSaveDepartments, debouncedSaveProcess]);

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

  const handleSave = useCallback(async () => {
    if (!isAuthenticated) return;
    
    // Cancel any pending debounced saves
    debouncedSaveStrategy.cancel();
    debouncedSaveDepartments.cancel();
    
    store.setIsSaving(true);
    try {
      await updateStrategy(stateRef.current.strategy);
      await saveWorkspace(stateRef.current);
      
      const dirtyIds = Array.from(dirtyProcessIdsRef.current);
      for (const id of dirtyIds as string[]) {
        const process = stateRef.current.processes.find(p => p.id === id);
        if (process) {
          const isNew = !store.lastSavedProcesses.some(p => p.id === id);
          if (isNew) {
            await addDbProcess(process);
          } else {
            await updateDbProcess(id, process);
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
      for (const newDept of newDepts) {
        const oldDept = oldDepts.find(d => d.id === newDept.id);
        if (!oldDept) {
          await addDbDepartment(newDept);
        } else if (JSON.stringify(oldDept) !== JSON.stringify(newDept)) {
          await updateDbDepartment(newDept.id, newDept);
        }
      }
      
      store.setLastSavedDepartments(newDepts);
      store.setLastSavedProcesses(stateRef.current.processes);
      store.setLastSavedBusinesses(stateRef.current.businesses);
      dirtyProcessIdsRef.current.clear();
      deletedProcessIdsRef.current.clear();

      store.setIsSaving(false);
      store.setIsDirty(false);
      store.setShowSaveSuccess(true);
      setTimeout(() => store.setShowSaveSuccess(false), 3000);
      store.setBackendError(null);
    } catch (error: any) {
      store.setIsSaving(false);
      store.setBackendError(error.message || "保存失败");
    }
  }, [isAuthenticated, store]);

  const saveStateDirectly = async (newState: any) => {
    if (!isAuthenticated) return;
    store.setState(newState);
    store.setIsDirty(true);
    executeAtomicOperation(async () => {
      await saveWorkspace(newState);
      store.setIsDirty(false);
    });
  };

  const handleSetDepartments = (newDepts: any[], autoSave = true) => {
    store.setDepartments(newDepts);
    if (autoSave) {
      store.setIsSaving(true);
      store.setIsDirty(true);
      debouncedSaveDepartments(newDepts);
    }
  };

  const handleSetUsers = (newUsers: any[]) => {
    store.setUsers(newUsers);
    executeAtomicOperation(async () => {
      const oldUsers = store.lastSavedUsers;
      const currentIds = new Set(newUsers.map(u => u.id));
      const toDelete = oldUsers.filter(u => !currentIds.has(u.id));
      for (const u of toDelete) await deleteDbUser(u.id);
      for (const newUser of newUsers) {
        const oldUser = oldUsers.find(u => u.id === newUser.id);
        if (!oldUser) await addDbUser(newUser);
        else if (JSON.stringify(oldUser) !== JSON.stringify(newUser)) await updateDbUser(newUser.id, newUser);
      }
      store.setLastSavedUsers(newUsers);
    });
  };

  const handleSetSystemRoles = (newRoles: any[]) => {
    store.setSystemRoles(newRoles);
    executeAtomicOperation(async () => {
      const oldRoles = store.lastSavedSystemRoles;
      const currentIds = new Set(newRoles.map(r => r.id));
      const toDelete = oldRoles.filter(r => !currentIds.has(r.id));
      for (const r of toDelete) await deleteSystemRole(r.id);
      for (const newRole of newRoles) {
        const oldRole = oldRoles.find(r => r.id === newRole.id);
        if (!oldRole) await addSystemRole(newRole);
        else if (JSON.stringify(oldRole) !== JSON.stringify(newRole)) await updateSystemRole(newRole.id, newRole);
      }
      store.setLastSavedSystemRoles(newRoles);
    });
  };

  const handleSetAISettings = (newAISettings: any) => {
    store.setAISettings(newAISettings);
    executeAtomicOperation(async () => {
      await saveWorkspace(stateRef.current);
      store.setIsDirty(false);
    });
  };

  const handleSetBusinesses = (businesses: any[]) => {
    store.setBusinesses(businesses);
    executeAtomicOperation(async () => {
      const oldBusinesses = store.lastSavedBusinesses;
      const currentIds = new Set(businesses.map(b => b.id));
      const toDelete = oldBusinesses.filter(b => !currentIds.has(b.id));
      for (const d of toDelete) await deleteBusiness(d.id);
      for (const newBiz of businesses) {
        const oldBiz = oldBusinesses.find(b => b.id === newBiz.id);
        if (!oldBiz) await addBusiness(newBiz);
        else if (JSON.stringify(oldBiz) !== JSON.stringify(newBiz)) await updateBusiness(newBiz.id, newBiz);
      }
      store.setLastSavedBusinesses(businesses);
    });
  };

  const setProcessData = (id: string, nodes: any[], links: any[]) => {
    store.updateProcess(id, { nodes, links });
    store.setIsDirty(true);
    dirtyProcessIdsRef.current.add(id);
    const process = { ...stateRef.current.processes.find(p => p.id === id)!, nodes, links };
    debouncedSaveProcess(id, process);
  };

  const updateProcessProps = (id: string, props: Partial<ProcessDefinition>) => {
    store.updateProcess(id, props);
    store.setIsDirty(true);
    dirtyProcessIdsRef.current.add(id);
    const process = { ...stateRef.current.processes.find(p => p.id === id)!, ...props };
    debouncedSaveProcess(id, process);
  };

  const addProcess = (category: any, level: 1 | 2, name: string) => {
    const newProcess: ProcessDefinition = {
      id: `proc-${Date.now()}`, name, category, level, version: 'Draft', isActive: false, type: category === '辅助体系' ? 'auxiliary' : 'main',
      owner: '', coOwner: '', objective: '', nodes: [], links: [], history: [], updatedAt: Date.now()
    };
    store.addProcess(newProcess);
    dirtyProcessIdsRef.current.add(newProcess.id);
    executeAtomicOperation(async () => {
      await addDbProcess(newProcess);
      store.setLastSavedProcesses(stateRef.current.processes);
    });
  };

  const deleteProcessFn = (id: string) => {
    store.deleteProcess(id);
    deletedProcessIdsRef.current.add(id);
    dirtyProcessIdsRef.current.delete(id);
    executeAtomicOperation(async () => {
      await deleteDbProcess(id);
      store.setLastSavedProcesses(stateRef.current.processes);
    });
  };

  const publishProcess = (id: string, version: string) => {
    const processToPublish = stateRef.current.processes.find(p => p.id === id);
    if (!processToPublish) return;
    
    const newRecord: ProcessHistory = { id: `hist-${Date.now()}`, version, nodes: JSON.parse(JSON.stringify(processToPublish.nodes)), links: JSON.parse(JSON.stringify(processToPublish.links)), publishedAt: Date.now(), publishedBy: currentUser?.name || 'System' };
    const newHistory = [newRecord, ...processToPublish.history];
    
    store.updateProcess(id, { version, isActive: true, history: newHistory });
    dirtyProcessIdsRef.current.add(id);
    
    executeAtomicOperation(async () => {
      await updateDbProcess(id, { version, isActive: true, history: newHistory });
    });
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
    
    executeAtomicOperation(async () => {
      await updateDbProcess(procId, { nodes: newNodes, links: newLinks, updatedAt: Date.now() });
    });
  };

  const handleSetTasks = (newTasks: any[]) => {
    store.setTasks(newTasks);
    executeAtomicOperation(async () => {
      await saveWorkspace(stateRef.current);
      store.setIsDirty(false);
    });
  };

  const handleSetStrategy = (strategyPartial: any, autoSave = true) => {
    store.setStrategy(strategyPartial);
    if (autoSave) {
      store.setIsDirty(true);
      // Use the latest strategy from stateRef to ensure we save the full merged state
      const updatedStrategy = { ...stateRef.current.strategy, ...strategyPartial };
      debouncedSaveStrategy(updatedStrategy);
    }
  };

  return {
    handleSave,
    saveStateDirectly,
    executeAtomicOperation,
    handleSetDepartments,
    handleSetUsers,
    handleSetSystemRoles,
    handleSetAISettings,
    handleSetBusinesses,
    setProcessData,
    updateProcessProps,
    addProcess,
    deleteProcessFn,
    publishProcess,
    rollbackProcess,
    handleSetTasks,
    handleSetStrategy
  };
};
