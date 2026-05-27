import { useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { 
  getWorkspace, updateStrategy, saveDepartmentsAtomically, saveProcessesAtomically,
  saveUsersAtomically, saveSystemRolesAtomically, saveBusinessesAtomically, saveAISettings
} from '@/data';
import { ProcessDefinition, ProcessHistory } from '@/types';
import { useTaskActions } from '@/hooks/useTaskActions';
import { getUserFacingError } from '@/utils/userFacingError';
import { getPrimaryManagedDepartmentId, isAdminUser, isManagerUser } from '@/utils/permissions';

type SaveDomain = 'strategy' | 'aiSettings' | 'processes' | 'departments' | 'users' | 'systemRoles' | 'businesses';

const ALL_SAVE_DOMAINS: SaveDomain[] = [
  'strategy',
  'aiSettings',
  'processes',
  'departments',
  'users',
  'systemRoles',
  'businesses'
];

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
      store.setShowSaveSuccess(true);
      setTimeout(() => store.setShowSaveSuccess(false), 3000);
      store.setBackendError(null);
    } catch (error: any) {
      store.setIsSaving(false);
      store.setBackendError(getUserFacingError(error, '操作失败，请稍后重试'));
    }
  }, [isAuthenticated, store]);

  const showSaveSuccessFeedback = (clearedDomains: Array<'tasks' | SaveDomain>) => {
    store.setIsSaving(false);
    store.clearDirtyDomains(clearedDomains);
    store.setShowSaveSuccess(true);
    if (saveSuccessTimeoutRef.current) clearTimeout(saveSuccessTimeoutRef.current);
    saveSuccessTimeoutRef.current = setTimeout(() => {
      store.setShowSaveSuccess(false);
      saveSuccessTimeoutRef.current = null;
    }, 3000);
    store.setBackendError(null);
  };

  const { persistTaskEntries, persistTaskDeletion } = useTaskActions({
    store,
    isAuthenticated,
    currentUser,
    stateRef,
    syncStateRef,
    showSaveSuccessFeedback
  });

  const saveStrategyDomain = async () => {
    const savedStrategy = await updateStrategy(stateRef.current.strategy);
    store.setState({ strategy: savedStrategy });
    store.setLastSavedStrategy(savedStrategy);
  };

  const saveAISettingsDomain = async () => {
    if (!stateRef.current.aiSettings) return;
    const savedSettings = await saveAISettings(stateRef.current.aiSettings);
    store.setState({ aiSettings: savedSettings });
  };

  const saveProcessesDomain = async () => {
    const nextProcesses = stateRef.current.processes || [];
    const previousProcesses = store.lastSavedProcesses || [];
    const savedProcesses = await saveProcessesAtomically(nextProcesses, previousProcesses);

    store.setState({ processes: savedProcesses });
    store.setLastSavedProcesses(savedProcesses);
    dirtyProcessIdsRef.current.clear();
    deletedProcessIdsRef.current.clear();
  };

  const saveDepartmentsDomain = async () => {
    const newDepts = stateRef.current.departments || [];
    const oldDepts = store.lastSavedDepartments;
    const savedDepartments = await saveDepartmentsAtomically(newDepts, oldDepts);

    store.setState({ departments: savedDepartments });
    store.setLastSavedDepartments(savedDepartments);
  };

  const saveUsersDomain = async () => {
    const newUsers = stateRef.current.users || [];
    const oldUsers = store.lastSavedUsers;
    const savedUsers = await saveUsersAtomically(newUsers, oldUsers);

    store.setState({ users: savedUsers });
    store.setLastSavedUsers(savedUsers);
  };

  const saveSystemRolesDomain = async () => {
    const newRoles = stateRef.current.systemRoles || [];
    const oldRoles = store.lastSavedSystemRoles;
    const savedRoles = await saveSystemRolesAtomically(newRoles, oldRoles);

    store.setState({ systemRoles: savedRoles });
    store.setLastSavedSystemRoles(savedRoles);
  };

  const saveBusinessesDomain = async () => {
    const newBusinesses = stateRef.current.businesses || [];
    const oldBusinesses = store.lastSavedBusinesses;
    const savedBusinesses = await saveBusinessesAtomically(newBusinesses, oldBusinesses);

    store.setState({ businesses: savedBusinesses });
    store.setLastSavedBusinesses(savedBusinesses);
  };

  const handleSave = useCallback(async (domains: SaveDomain[] = ALL_SAVE_DOMAINS) => {
    if (!isAuthenticated) return;
    stateRef.current = useAppStore.getState() as any;
    
    store.setIsSaving(true);
    try {
      for (const domain of domains) {
        if (domain === 'strategy') await saveStrategyDomain();
        if (domain === 'aiSettings') await saveAISettingsDomain();
        if (domain === 'processes') await saveProcessesDomain();
        if (domain === 'departments') await saveDepartmentsDomain();
        if (domain === 'users') await saveUsersDomain();
        if (domain === 'systemRoles') await saveSystemRolesDomain();
        if (domain === 'businesses') await saveBusinessesDomain();
      }

      showSaveSuccessFeedback(domains);
    } catch (error: any) {
      store.setIsSaving(false);
      store.setBackendError(getUserFacingError(error, '保存失败，请稍后重试'));
    }
  }, [isAuthenticated, store]);

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
      const savedSettings = await saveAISettings(nextSettings);
      store.setState({ aiSettings: savedSettings });
      store.setBackendError(null);
      store.clearDirtyDomains(['aiSettings']);
      store.setShowSaveSuccess(true);
      setTimeout(() => store.setShowSaveSuccess(false), 3000);
    } catch (error: any) {
      store.setBackendError(getUserFacingError(error, '保存系统设置失败，请稍后重试'));
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
    const trimmedName = name.trim();
    if (!trimmedName) {
      store.setBackendError('请输入流程名称');
      return false;
    }

    if (!currentUser) {
      store.setBackendError('当前未登录，无法创建流程');
      return false;
    }

    const currentDepartments = stateRef.current.departments || [];
    const departmentId = isAdminUser(currentUser, store.systemRoles || [])
      ? currentUser.departmentId
      : isManagerUser(currentUser)
        ? getPrimaryManagedDepartmentId(currentUser, currentDepartments)
        : undefined;

    if (!departmentId) {
      store.setBackendError('当前账号未绑定可管理部门，无法创建流程，请联系管理员配置部门负责人');
      return false;
    }

    store.setBackendError(null);
    const newProcess: ProcessDefinition = {
      id: `proc-${Date.now()}`,
      departmentId,
      createdBy: currentUser.id,
      name: trimmedName,
      category,
      level,
      version: 'Draft',
      isActive: false,
      type: category === '辅助体系' ? 'auxiliary' : 'main',
      owner: '',
      coOwner: '',
      objective: '',
      nodes: [],
      links: [],
      history: [],
      updatedAt: Date.now()
    };
    store.addProcess(newProcess);
    dirtyProcessIdsRef.current.add(newProcess.id);
    store.setIsDirty(true);
    syncStateRef();
    return true;
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
