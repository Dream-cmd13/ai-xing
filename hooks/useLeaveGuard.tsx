import { useState, useCallback, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';

const cloneSnapshot = <T,>(value: T): T => {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

type LeaveGuardOptions = {
  onDiscard?: () => void;
};

export function useLeaveGuard(isDirty: boolean, options?: LeaveGuardOptions) {
  const [pendingLeaveAction, setPendingLeaveAction] = useState<(() => void) | null>(null);

  const attemptLeave = useCallback((action: () => void) => {
    if (!isDirty) {
      action();
      return;
    }
    setPendingLeaveAction(() => action);
  }, [isDirty]);

  const confirmLeave = useCallback(() => {
    const action = pendingLeaveAction;
    setPendingLeaveAction(null);

    if (options?.onDiscard) {
      options.onDiscard();
    } else {
      const state = useAppStore.getState();
      const nextState: Record<string, unknown> = {};

      if (state.dirtyDomains.includes('processes')) {
        const rolledBackProcesses = cloneSnapshot(state.lastSavedProcesses || []);
        nextState.processes = rolledBackProcesses;
        if (!rolledBackProcesses.some((process) => process.id === state.currentProcessId)) {
          nextState.currentProcessId = rolledBackProcesses[0]?.id || null;
        }
      }
      if (state.dirtyDomains.includes('departments')) {
        nextState.departments = cloneSnapshot(state.lastSavedDepartments || []);
      }
      if (state.dirtyDomains.includes('businesses')) {
        nextState.businesses = cloneSnapshot(state.lastSavedBusinesses || []);
      }
      if (state.dirtyDomains.includes('tasks')) {
        nextState.tasks = cloneSnapshot(state.lastSavedTasks || []);
      }
      if (state.dirtyDomains.includes('users')) {
        nextState.users = cloneSnapshot(state.lastSavedUsers || []);
      }
      if (state.dirtyDomains.includes('systemRoles')) {
        nextState.systemRoles = cloneSnapshot(state.lastSavedSystemRoles || []);
      }
      if (state.dirtyDomains.includes('strategy') && state.lastSavedStrategy) {
        nextState.strategy = cloneSnapshot(state.lastSavedStrategy);
      }
      if (state.dirtyDomains.includes('aiSettings') && state.lastSavedAISettings) {
        nextState.aiSettings = cloneSnapshot(state.lastSavedAISettings);
      }

      useAppStore.setState({
        ...nextState,
        dirtyDomains: [],
        isDirty: false,
        backendError: null,
        showSaveSuccess: false,
        isSaving: false
      });
    }

    action?.();
  }, [options, pendingLeaveAction]);

  const cancelLeave = useCallback(() => {
    setPendingLeaveAction(null);
  }, []);

  useEffect(() => {
    const handleAppNavigationAttempt = (nativeEvent: Event) => {
      const event = nativeEvent as CustomEvent<{ path?: string; retry?: () => void }>;
      if (!isDirty || !event.detail?.retry) return;
      event.preventDefault();
      setPendingLeaveAction(() => event.detail.retry!);
    };

    window.addEventListener('app:navigation-attempt', handleAppNavigationAttempt as EventListener);
    return () => {
      window.removeEventListener('app:navigation-attempt', handleAppNavigationAttempt as EventListener);
    };
  }, [isDirty]);

  const LeaveModal = pendingLeaveAction ? (
    <div className="fixed inset-0 z-[1200] flex items-start justify-center bg-slate-900/35 p-6 pt-32 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-[2rem] border border-slate-100 bg-white p-8 shadow-2xl">
        <div className="mb-6">
          <h3 className="text-xl font-black text-slate-800">当前页面有未保存的修改，确定要离开吗？</h3>
          <p className="mt-3 text-sm font-medium leading-relaxed text-slate-500">
            确认离开后，本次未提交的修改会直接放弃。
          </p>
        </div>
        <div className="flex justify-end gap-3">
          <button
            onClick={cancelLeave}
            className="rounded-xl bg-slate-100 px-6 py-2.5 text-xs font-black uppercase text-slate-600 transition-colors hover:bg-slate-200"
          >
            取消
          </button>
          <button
            onClick={confirmLeave}
            className="rounded-xl bg-red-500 px-6 py-2.5 text-xs font-black uppercase text-white shadow-md shadow-red-500/20 transition-colors hover:bg-red-600"
          >
            确定离开
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { attemptLeave, LeaveModal };
}
