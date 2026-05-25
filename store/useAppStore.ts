import { create } from 'zustand';
import { AppState, ProcessDefinition, Department, CompanyStrategy, User, SystemRole, AISettings, PADEntry, BusinessDefinition } from '../types';

interface AppStoreState extends AppState {
  isDirty: boolean;
  isSaving: boolean;
  showSaveSuccess: boolean;
  backendError: string | null;
  currentProcessId: string | null;
  isInitialLoadComplete: boolean;
  
  lastSavedProcesses: ProcessDefinition[];
  lastSavedDepartments: Department[];
  lastSavedBusinesses: BusinessDefinition[];
  lastSavedUsers: User[];
  lastSavedSystemRoles: SystemRole[];
  lastSavedStrategy: CompanyStrategy | null;
  
  setState: (state: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
  setIsDirty: (isDirty: boolean) => void;
  setIsSaving: (isSaving: boolean) => void;
  setShowSaveSuccess: (show: boolean) => void;
  setBackendError: (error: string | null) => void;
  setCurrentProcessId: (id: string | null) => void;
  setIsInitialLoadComplete: (isComplete: boolean) => void;
  
  setLastSavedProcesses: (processes: ProcessDefinition[]) => void;
  setLastSavedDepartments: (departments: Department[]) => void;
  setLastSavedBusinesses: (businesses: BusinessDefinition[]) => void;
  setLastSavedUsers: (users: User[]) => void;
  setLastSavedSystemRoles: (roles: SystemRole[]) => void;
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
      { id: 'gemini', name: 'Gemini 3 Flash Preview', type: 'gemini', apiKey: 'ENV_KEY' }
    ] 
  },
  
  isDirty: false,
  isSaving: false,
  showSaveSuccess: false,
  backendError: null,
  currentProcessId: null,
  isInitialLoadComplete: false,
  
  lastSavedProcesses: [],
  lastSavedDepartments: [],
  lastSavedBusinesses: [],
  lastSavedUsers: [],
  lastSavedSystemRoles: [],
  lastSavedStrategy: null,
  
  setState: (newState) => set((state) => {
    if (typeof newState === 'function') {
      const result = newState(state);
      return { ...state, ...result };
    }
    return { ...state, ...newState };
  }),
  setIsDirty: (isDirty) => set({ isDirty }),
  setIsSaving: (isSaving) => set({ isSaving }),
  setShowSaveSuccess: (showSaveSuccess) => set({ showSaveSuccess }),
  setBackendError: (backendError) => set({ backendError }),
  setCurrentProcessId: (currentProcessId) => set({ currentProcessId }),
  setIsInitialLoadComplete: (isInitialLoadComplete) => set({ isInitialLoadComplete }),
  
  setLastSavedProcesses: (lastSavedProcesses) => set({ lastSavedProcesses }),
  setLastSavedDepartments: (lastSavedDepartments) => set({ lastSavedDepartments }),
  setLastSavedBusinesses: (lastSavedBusinesses) => set({ lastSavedBusinesses }),
  setLastSavedUsers: (lastSavedUsers) => set({ lastSavedUsers }),
  setLastSavedSystemRoles: (lastSavedSystemRoles) => set({ lastSavedSystemRoles }),
  setLastSavedStrategy: (lastSavedStrategy) => set({ lastSavedStrategy }),
  
  setDepartments: (departments) => set({ departments, isDirty: true }),
  setUsers: (users) => set({ users, isDirty: true }),
  setSystemRoles: (systemRoles) => set({ systemRoles, isDirty: true }),
  setBusinesses: (businesses) => set({ 
    businesses: businesses.map(b => ({ ...b, updatedAt: Date.now() })), 
    isDirty: true 
  }),
  setTasks: (tasks) => set({ tasks, isDirty: true }),
  setStrategy: (strategyPartial) => set((state) => ({ 
    strategy: { ...state.strategy, ...strategyPartial, updatedAt: Date.now() },
    isDirty: true
  })),
  setAISettings: (aiSettings) => set((state) => ({
    aiSettings: { ...state.aiSettings, ...aiSettings, updatedAt: Date.now() },
    isDirty: true
  })),
  
  addProcess: (process) => set((state) => ({
    processes: [...state.processes, process],
    isDirty: true,
    currentProcessId: process.id
  })),
  updateProcess: (id, processProps) => set((state) => ({
    processes: state.processes.map(p => p.id === id ? { ...p, ...processProps, updatedAt: Date.now() } : p),
    isDirty: true
  })),
  deleteProcess: (id) => set((state) => ({
    processes: state.processes.filter(p => p.id !== id),
    isDirty: true
  }))
}));
