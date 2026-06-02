import { create } from 'zustand';
import { AppState, ProcessDefinition, Department, CompanyStrategy, User, SystemRole, AISettings, PADEntry, BusinessDefinition } from '../types';

export type AppDomainKey =
  | 'users'
  | 'systemRoles'
  | 'aiSettings'
  | 'departments'
  | 'processes'
  | 'strategy'
  | 'businesses'
  | 'tasks';

type DomainLoadState = {
  loaded: boolean;
  loading: boolean;
};

const createInitialDomainLoadStatus = (): Record<AppDomainKey, DomainLoadState> => ({
  users: { loaded: false, loading: false },
  systemRoles: { loaded: false, loading: false },
  aiSettings: { loaded: false, loading: false },
  departments: { loaded: false, loading: false },
  processes: { loaded: false, loading: false },
  strategy: { loaded: false, loading: false },
  businesses: { loaded: false, loading: false },
  tasks: { loaded: false, loading: false }
});

export interface AppStoreState extends AppState {
  isDirty: boolean;
  dirtyDomains: AppDomainKey[];
  isSaving: boolean;
  showSaveSuccess: boolean;
  backendError: string | null;
  currentProcessId: string | null;
  isInitialLoadComplete: boolean;
  domainLoadStatus: Record<AppDomainKey, DomainLoadState>;
  
  lastSavedProcesses: ProcessDefinition[];
  lastSavedDepartments: Department[];
  lastSavedBusinesses: BusinessDefinition[];
  lastSavedTasks: PADEntry[];
  lastSavedUsers: User[];
  lastSavedSystemRoles: SystemRole[];
  lastSavedAISettings: AISettings | null;
  lastSavedStrategy: CompanyStrategy | null;
  
  setState: (state: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
  setIsDirty: (isDirty: boolean) => void;
  setIsSaving: (isSaving: boolean) => void;
  setShowSaveSuccess: (show: boolean) => void;
  setBackendError: (error: string | null) => void;
  setCurrentProcessId: (id: string | null) => void;
  setIsInitialLoadComplete: (isComplete: boolean) => void;
  setDirtyDomains: (domains: AppDomainKey[]) => void;
  markDirtyDomains: (domains: AppDomainKey[]) => void;
  clearDirtyDomains: (domains: AppDomainKey[]) => void;
  setDomainLoadState: (domain: AppDomainKey, state: Partial<DomainLoadState>) => void;
  resetDomainLoadState: () => void;
  
  setLastSavedProcesses: (processes: ProcessDefinition[]) => void;
  setLastSavedDepartments: (departments: Department[]) => void;
  setLastSavedBusinesses: (businesses: BusinessDefinition[]) => void;
  setLastSavedTasks: (tasks: PADEntry[]) => void;
  setLastSavedUsers: (users: User[]) => void;
  setLastSavedSystemRoles: (roles: SystemRole[]) => void;
  setLastSavedAISettings: (settings: AISettings) => void;
  setLastSavedStrategy: (strategy: CompanyStrategy) => void;
  
  // Action wrappers
  setDepartments: (departments: Department[]) => void;
  setUsers: (users: User[]) => void;
  setSystemRoles: (roles: SystemRole[]) => void;
  setAISettings: (settings: AISettings) => void;
  setBusinesses: (businesses: BusinessDefinition[]) => void;
  setTasks: (tasks: PADEntry[]) => void;
  setStrategy: (strategy: Partial<CompanyStrategy>) => void;
  
  // Process actions
  addProcess: (process: ProcessDefinition) => void;
  updateProcess: (id: string, process: Partial<ProcessDefinition>) => void;
  deleteProcess: (id: string) => void;
}

export const useAppStore = create<AppStoreState>((set) => ({
  processes: [],
  departments: [],
  strategy: { mission: '', vision: '', customerIssues: '', employeeIssues: '', companyOKRs: {} },
  users: [],
  tasks: [],
  aiSettings: { 
    selectedModelId: 'gemini', 
    configs: [
      { id: 'gemini', name: 'Gemini 2.5 Flash', type: 'gemini', modelName: 'gemini-2.5-flash' },
      { id: 'deepseek', name: 'DeepSeek V4 Flash', type: 'deepseek', modelName: 'deepseek-v4-flash' }
    ] 
  },
  
  isDirty: false,
  dirtyDomains: [],
  isSaving: false,
  showSaveSuccess: false,
  backendError: null,
  currentProcessId: null,
  isInitialLoadComplete: false,
  domainLoadStatus: createInitialDomainLoadStatus(),
  
  lastSavedProcesses: [],
  lastSavedDepartments: [],
  lastSavedBusinesses: [],
  lastSavedTasks: [],
  lastSavedUsers: [],
  lastSavedSystemRoles: [],
  lastSavedAISettings: null,
  lastSavedStrategy: null,
  
  setState: (newState) => set((state) => {
    if (typeof newState === 'function') {
      const result = newState(state);
      return { ...state, ...result };
    }
    return { ...state, ...newState };
  }),
  setIsDirty: (isDirty) => set({ isDirty }),
  setDirtyDomains: (dirtyDomains) => set({ dirtyDomains, isDirty: dirtyDomains.length > 0 }),
  markDirtyDomains: (domains) => set((state) => {
    const dirtyDomains = Array.from(new Set([...state.dirtyDomains, ...domains]));
    return { dirtyDomains, isDirty: dirtyDomains.length > 0 };
  }),
  clearDirtyDomains: (domains) => set((state) => {
    const targetDomains = new Set(domains);
    const dirtyDomains = state.dirtyDomains.filter((domain) => !targetDomains.has(domain));
    return { dirtyDomains, isDirty: dirtyDomains.length > 0 };
  }),
  setIsSaving: (isSaving) => set({ isSaving }),
  setShowSaveSuccess: (showSaveSuccess) => set({ showSaveSuccess }),
  setBackendError: (backendError) => set({ backendError }),
  setCurrentProcessId: (currentProcessId) => set({ currentProcessId }),
  setIsInitialLoadComplete: (isInitialLoadComplete) => set({ isInitialLoadComplete }),
  setDomainLoadState: (domain, nextState) => set((state) => ({
    domainLoadStatus: {
      ...state.domainLoadStatus,
      [domain]: {
        ...state.domainLoadStatus[domain],
        ...nextState
      }
    }
  })),
  resetDomainLoadState: () => set({ domainLoadStatus: createInitialDomainLoadStatus() }),
  
  setLastSavedProcesses: (lastSavedProcesses) => set({ lastSavedProcesses }),
  setLastSavedDepartments: (lastSavedDepartments) => set({ lastSavedDepartments }),
  setLastSavedBusinesses: (lastSavedBusinesses) => set({ lastSavedBusinesses }),
  setLastSavedTasks: (lastSavedTasks) => set({ lastSavedTasks }),
  setLastSavedUsers: (lastSavedUsers) => set({ lastSavedUsers }),
  setLastSavedSystemRoles: (lastSavedSystemRoles) => set({ lastSavedSystemRoles }),
  setLastSavedAISettings: (lastSavedAISettings) => set({ lastSavedAISettings }),
  setLastSavedStrategy: (lastSavedStrategy) => set({ lastSavedStrategy }),
  
  setDepartments: (departments) => set((state) => ({
    departments,
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'departments'])),
    isDirty: true
  })),
  setUsers: (users) => set((state) => ({
    users,
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'users'])),
    isDirty: true
  })),
  setSystemRoles: (systemRoles) => set((state) => ({
    systemRoles,
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'systemRoles'])),
    isDirty: true
  })),
  setBusinesses: (businesses) => set((state) => ({ 
    businesses: businesses.map(b => ({ ...b, updatedAt: Date.now() })),
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'businesses'])),
    isDirty: true 
  })),
  setTasks: (tasks) => set((state) => ({
    tasks,
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'tasks'])),
    isDirty: true
  })),
  setStrategy: (strategyPartial) => set((state) => ({ 
    strategy: { ...state.strategy, ...strategyPartial, updatedAt: Date.now() },
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'strategy'])),
    isDirty: true
  })),
  setAISettings: (aiSettings) => set((state) => ({
    aiSettings: { ...state.aiSettings, ...aiSettings, updatedAt: Date.now() },
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'aiSettings'])),
    isDirty: true
  })),
  
  addProcess: (process) => set((state) => ({
    processes: [...state.processes, process],
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'processes'])),
    isDirty: true,
    currentProcessId: process.id
  })),
  updateProcess: (id, processProps) => set((state) => ({
    processes: state.processes.map(p => p.id === id ? { ...p, ...processProps, updatedAt: Date.now() } : p),
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'processes'])),
    isDirty: true
  })),
  deleteProcess: (id) => set((state) => ({
    processes: state.processes.filter(p => p.id !== id),
    dirtyDomains: Array.from(new Set([...state.dirtyDomains, 'processes'])),
    isDirty: true
  }))
}));
