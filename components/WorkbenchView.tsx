import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppActions } from '@/hooks/useAppActions';
import { usePageToast } from '@/hooks/usePageToast';
import { usePermissions } from '@/hooks/usePermissions';
import { getDepartments, getStrategy, getUsers, getWorkbenchTasks } from '@/data';

import { AppState, PADEntry, OKR, WeeklyPAD, TaskLog } from '@/types';
import { Calendar, CheckCircle, Clock, Target, ArrowRight, LayoutDashboard, ListTodo, Briefcase, Flag, Loader2 } from 'lucide-react';
import PageToast from './PageToast';
import TaskModal from './TaskModal';
import { ensureTaskTargetWeeks } from '@/utils/taskPeriods.js';
import { getUserFacingError } from '@/utils/userFacingError';
import { canManageTask, canViewTask, isAdminUser } from '@/utils/permissions';

const WorkbenchView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('workbench');
  const taskPermissions = usePermissions('task-center');
  const { 
    handleSetDepartments: setDepartments, handleSetUsers: setUsers, 
    handleSetSystemRoles: setSystemRoles, handleSetAISettings: setAISettings, 
    handleSetBusinesses: setBusinesses, setProcessData, updateProcessProps, 
    addProcess, deleteProcessFn: deleteProcess, publishProcess, rollbackProcess, 
    handleSetTasks: setTasks, handleSetStrategy: setStrategy,
    persistTaskEntries, persistTaskDeletion
  } = actions;
  const domainLoadStatus = state.domainLoadStatus;
  const setState = state.setState;
  const setDomainLoadState = state.setDomainLoadState;
  const setLastSavedDepartments = state.setLastSavedDepartments;
  const setLastSavedStrategy = state.setLastSavedStrategy;
  const setLastSavedTasks = state.setLastSavedTasks;
  const setLastSavedUsers = state.setLastSavedUsers;
  const setBackendError = state.setBackendError;
  const setIsDirty = state.setIsDirty;
  const backendError = state.backendError;
  const currentProcessId = state.currentProcessId;
  const setCurrentProcessId = state.setCurrentProcessId;

  const today = new Date();
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const currentYear = d.getUTCFullYear();
  const currentWeek = getWeekNumber(today);
  const weekId = `${currentYear}-W${currentWeek.toString().padStart(2, '0')}`;
  const nextWeekId = `${currentYear}-W${(currentWeek + 1).toString().padStart(2, '0')}`;

  const [taskModal, setTaskModal] = useState<{ isOpen: boolean, weekId: string | null, mode: 'create' | 'edit', data: Partial<PADEntry> }>({ isOpen: false, weekId: null, mode: 'create', data: {} });
  const { toastState, showToast, clearToast } = usePageToast();
  const [isWorkbenchTasksLoading, setIsWorkbenchTasksLoading] = useState(false);
  const backgroundPrefetchVersionRef = useRef(0);
  const missingTaskUserFetchKeyRef = useRef('');

  useEffect(() => {
    if (!currentUser?.id || domainLoadStatus.tasks.loaded) {
      return;
    }

    let cancelled = false;
    setIsWorkbenchTasksLoading(true);

    getWorkbenchTasks(currentUser.id)
      .then((loadedTasks) => {
        if (cancelled) return;
        setState({ tasks: loadedTasks });
        setLastSavedTasks(loadedTasks);
      })
      .catch((error: any) => {
        if (cancelled) return;
        const message = getUserFacingError(error, '工作台任务加载失败，请稍后重试');
        setBackendError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setIsWorkbenchTasksLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser?.id, domainLoadStatus.tasks.loaded, setBackendError, setLastSavedTasks, setState]);

  useEffect(() => {
    if (domainLoadStatus.users.loaded || domainLoadStatus.users.loading) {
      return;
    }

    let cancelled = false;
    setDomainLoadState('users', { loading: true });

    getUsers()
      .then((loadedUsers) => {
        if (cancelled) return;
        setState({ users: loadedUsers });
        setLastSavedUsers(loadedUsers);
        setDomainLoadState('users', { loaded: true, loading: false });
      })
      .catch((error: any) => {
        if (cancelled) return;
        setDomainLoadState('users', { loaded: false, loading: false });
        setBackendError(getUserFacingError(error, '用户数据加载失败，请稍后重试'));
      });

    return () => {
      cancelled = true;
    };
  }, [
    domainLoadStatus.users.loaded,
    domainLoadStatus.users.loading,
    setBackendError,
    setDomainLoadState,
    setLastSavedUsers,
    setState
  ]);

  useEffect(() => {
    const relatedUserIds = new Set<string>();
    state.tasks.forEach((task) => {
      if (task.ownerId) relatedUserIds.add(task.ownerId);
      if (task.createdBy) relatedUserIds.add(task.createdBy);
      (task.participantIds || []).forEach(id => relatedUserIds.add(id));
      (task.approverIds || []).forEach(id => relatedUserIds.add(id));
      (task.logs || []).forEach(log => relatedUserIds.add(log.userId));
    });

    const existingUserIds = new Set(state.users.map(user => user.id));
    const missingUserIds = Array.from(relatedUserIds).filter(id => id && !existingUserIds.has(id)).sort();
    if (missingUserIds.length === 0) {
      missingTaskUserFetchKeyRef.current = '';
      return;
    }

    const fetchKey = missingUserIds.join('|');
    if (missingTaskUserFetchKeyRef.current === fetchKey) {
      return;
    }
    missingTaskUserFetchKeyRef.current = fetchKey;

    let cancelled = false;
    getUsers()
      .then((loadedUsers) => {
        if (cancelled) return;
        const mergedUsersById = new Map(state.users.map(user => [user.id, user]));
        loadedUsers.forEach(user => mergedUsersById.set(user.id, user));
        const mergedUsers = Array.from(mergedUsersById.values());
        setState({ users: mergedUsers });
        setLastSavedUsers(mergedUsers);
      })
      .catch(() => {
        // The modal still renders stable ID fallbacks when RLS cannot return a user row.
      });

    return () => {
      cancelled = true;
    };
  }, [state.tasks, state.users, setLastSavedUsers, setState]);

  useEffect(() => {
    const shouldLoadDepartments = !domainLoadStatus.departments.loaded && !domainLoadStatus.departments.loading;
    const shouldLoadStrategy = !domainLoadStatus.strategy.loaded && !domainLoadStatus.strategy.loading;

    if (!shouldLoadDepartments && !shouldLoadStrategy) {
      return;
    }

    const currentPrefetchVersion = backgroundPrefetchVersionRef.current + 1;
    backgroundPrefetchVersionRef.current = currentPrefetchVersion;

    Promise.all([
      shouldLoadDepartments ? getDepartments() : Promise.resolve(null),
      shouldLoadStrategy ? getStrategy() : Promise.resolve(null)
    ])
      .then(([loadedDepartments, loadedStrategy]) => {
        if (backgroundPrefetchVersionRef.current !== currentPrefetchVersion) return;

        if (loadedDepartments) {
          setState({ departments: loadedDepartments });
          setLastSavedDepartments(loadedDepartments);
          setDomainLoadState('departments', { loaded: true });
        }

        if (loadedStrategy) {
          setState({ strategy: loadedStrategy });
          setLastSavedStrategy(loadedStrategy);
          setDomainLoadState('strategy', { loaded: true });
        }
      })
      .catch((error: any) => {
        if (backgroundPrefetchVersionRef.current !== currentPrefetchVersion) return;
        const message = getUserFacingError(error, '工作台背景数据加载失败，请稍后重试');
        setBackendError(message);
      });
  }, [
    domainLoadStatus.departments.loaded,
    domainLoadStatus.departments.loading,
    domainLoadStatus.strategy.loaded,
    domainLoadStatus.strategy.loading,
    setBackendError,
    setDomainLoadState,
    setLastSavedDepartments,
    setLastSavedStrategy,
    setState
  ]);

  // Extract creation timestamp from task id (format: task-TIMESTAMP or task-TIMESTAMP-N)
  const getTaskCreatedAt = (id: string): number => {
    const match = id.match(/task-(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  };

  // Helper to get tasks from all PADs
  const allMyTasks = useMemo(() => {
    return state.tasks
      .filter(e => e.ownerId === currentUser.id || e.participantIds?.includes(currentUser.id) || e.approverIds?.includes(currentUser.id))
      .sort((a, b) => {
        const timeA = getTaskCreatedAt(a.id);
        const timeB = getTaskCreatedAt(b.id);
        if (timeB !== timeA) return timeB - timeA;
        return (b.startDate ?? 0) - (a.startDate ?? 0);
      });
  }, [state.tasks, currentUser.id]);

  const todayTasks = useMemo(() => {
    return allMyTasks.filter(t => {
      if (!t.startDate || !t.dueDate) return false;
      const start = new Date(t.startDate);
      const due = new Date(t.dueDate);
      return today >= start && today <= due;
    });
  }, [allMyTasks, today]);

  const thisWeekTasks = useMemo(() => {
    return allMyTasks.filter(t => t.targetWeeks?.includes(weekId));
  }, [allMyTasks, weekId]);

  const nextWeekTasks = useMemo(() => {
    return allMyTasks.filter(t => t.targetWeeks?.includes(nextWeekId));
  }, [allMyTasks, nextWeekId]);

  const groupedAvailableKRs = useMemo(() => {
    if (!taskModal.weekId) return [];
    const year = parseInt(taskModal.weekId.split('-')[0]);
    const groups: { label: string, options: { id: string, name: string }[] }[] = [];
    
    // Company OKRs
    const companyOkrs = state.strategy.companyOKRs[year] || [];
    const companyOptions: { id: string, name: string }[] = [];
    companyOkrs.forEach(o => {
      (o.keyResults || []).forEach((kr, idx) => {
        companyOptions.push({ id: `${o.id}-kr-${idx}`, name: kr });
      });
    });
    if (companyOptions.length > 0) {
      groups.push({ label: '公司战略指标', options: companyOptions });
    }

    // Department OKRs
    state.departments.forEach(d => {
      const deptOkrs = d.okrs?.[year] || {};
      const deptOptions: { id: string, name: string }[] = [];
      Object.entries(deptOkrs).forEach(([period, okrs]: [string, OKR[]]) => {
        (okrs || []).forEach(o => {
          (o.keyResults || []).forEach((kr, idx) => {
            deptOptions.push({ id: `${o.id}-kr-${idx}`, name: `${kr} (${period})` });
          });
        });
      });
      if (deptOptions.length > 0) {
        groups.push({ label: `${d.name} 指标`, options: deptOptions });
      }
    });

    return groups;
  }, [state.strategy.companyOKRs, state.departments, taskModal.weekId]);

  const handleTaskClick = (task: PADEntry) => {
    const owner = state.users.find(u => u.id === task.ownerId);

    if (!canViewTask(task, currentUser, state.users, state.systemRoles || [], state.departments)) {
      showToast(`无任务查看权限，如果需要查看任务，请联系任务创建人【${owner?.name || ''}】`, 'info');
      return;
    }

    // Find the weekId for this task
    const weekIdFromTask = task.targetWeeks?.[0] || weekId;
    setTaskModal({
      isOpen: true,
      weekId: weekIdFromTask,
      mode: 'edit',
      data: task
    });
  };

  const saveTask = async (status: string = 'draft', keepOpen: boolean = false) => {
    if (!taskModal.weekId) return;

    const newTask = ensureTaskTargetWeeks(
      { ...taskModal.data, status } as PADEntry,
      taskModal.weekId
    ) as PADEntry;

    const isNewTask = !state.tasks.some(e => e.id === newTask.id);
    const oldTask = state.tasks.find(e => e.id === newTask.id);
    const currentUserIsAdmin = isAdminUser(currentUser, state.systemRoles || []);

    if (!isNewTask) {
      if (!oldTask || !taskPermissions.update || !canManageTask(oldTask, currentUser, state.systemRoles || [], state.departments)) {
        showToast('无权限修改该任务', 'error');
        return;
      }
      if (!currentUserIsAdmin) {
        newTask.ownerId = oldTask.ownerId;
      }
    } else if (!currentUserIsAdmin) {
      newTask.ownerId = currentUser.id;
    }

    if (!isNewTask) {
      if (oldTask) {
        const loggableStatuses = ['submitted', 'in-progress', 'paused', 'terminated', 'completed'];
        if (loggableStatuses.includes(oldTask.status)) {
          const changes = [];
          if (oldTask.title !== newTask.title) changes.push('标题');
          if (oldTask.status !== newTask.status) changes.push(`状态(${oldTask.status}->${newTask.status})`);
          if (oldTask.priority !== newTask.priority) changes.push('优先级');
          if (oldTask.startDate !== newTask.startDate || oldTask.dueDate !== newTask.dueDate) changes.push('时间');
          if (oldTask.ownerId !== newTask.ownerId) changes.push('负责人');
          if (oldTask.visibility !== newTask.visibility) changes.push('可见性');
          
          if (changes.length > 0) {
            const log: TaskLog = {
              id: `log-${Date.now()}`,
              timestamp: Date.now(),
              userId: currentUser.id,
              action: '修改任务',
              details: `修改了: ${changes.join(', ')}`
            };
            newTask.logs = [...(oldTask.logs || []), log];
          } else {
            newTask.logs = oldTask.logs || [];
          }
        } else {
          newTask.logs = oldTask.logs || [];
        }
      }
    }

    let nextTasks = [...state.tasks];
    
    // Prepare entries to add (handle multi-line title for new tasks)
    const entriesToAdd: PADEntry[] = [];
    
    if (isNewTask && newTask.title.includes('\n')) {
      const titles = newTask.title.split('\n').filter(t => t.trim());
      titles.forEach((t, i) => {
         entriesToAdd.push({ ...newTask, id: `task-${Date.now()}-${i}`, title: t.trim() });
      });
    } else {
      entriesToAdd.push(newTask);
    }
    
    if (isNewTask) {
      nextTasks = [...entriesToAdd, ...nextTasks];
    } else {
      nextTasks = nextTasks.map(t => t.id === newTask.id ? newTask : t);
    }

    try {
      await persistTaskEntries(nextTasks, entriesToAdd, isNewTask ? 'create' : 'update');
      showToast('任务已保存', 'success');
    } catch (error: any) {
      showToast(getUserFacingError(error, '任务保存失败，请稍后重试'), 'error');
      return;
    }
    
    if (keepOpen) {
      setTaskModal({ 
        isOpen: true, 
        weekId: taskModal.weekId, 
          mode: 'create',
        data: { 
          id: `task-${Date.now()}`,
          title: '', 
          status: 'draft',
          priority: 'medium',
          ownerId: currentUser.id,
          departmentId: currentUser.departmentId,
          visibility: 'public',
          targetWeeks: taskModal.weekId ? [taskModal.weekId] : [],
          startDate: Date.now(),
          dueDate: Date.now() + 86400000,
          tags: [],
          participantIds: [],
          approverIds: []
        } 
      });
    } else {
        setTaskModal({ isOpen: false, weekId: null, mode: 'create', data: {} });
    }
  };

  const deleteTask = async () => {
    if (!taskModal.data.id) return;
    const taskId = taskModal.data.id;
    const taskToDelete = state.tasks.find(t => t.id === taskId);
    if (!taskToDelete || !taskPermissions.update || !canManageTask(taskToDelete, currentUser, state.systemRoles || [], state.departments)) {
      showToast('无权限删除该任务', 'error');
      return;
    }
    const nextTasks = state.tasks.filter(t => t.id !== taskId);

    try {
      await persistTaskDeletion(nextTasks, [taskId]);
      setTaskModal({ isOpen: false, weekId: null, mode: 'create', data: {} });
      showToast('任务已删除', 'info');
    } catch (error: any) {
      showToast(getUserFacingError(error, '任务删除失败，请稍后重试'), 'error');
    }
  };

  return (
    <div className="h-full flex flex-col gap-4 md:gap-6 overflow-hidden p-4 md:p-6 bg-slate-50">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-200">
            <LayoutDashboard size={20} className="md:w-6 md:h-6" />
          </div>
          <div>
            <h2 className="text-xl md:text-2xl font-black tracking-tighter text-slate-800">工作台</h2>
            <p className="text-[10px] md:text-xs font-bold text-slate-400 uppercase tracking-widest">个人工作台</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs md:text-sm font-bold text-slate-500 bg-white px-4 py-2 rounded-2xl border shadow-sm">
            <Calendar size={14} className="md:w-4 md:h-4" />
            <span>{today.toLocaleDateString()}</span>
            <span className="bg-slate-100 px-2 py-0.5 rounded text-[10px] md:text-xs text-slate-600">第 {currentWeek} 周</span>
          </div>
        </div>
      </div>

      {/* Quadrants - Adjusted to 3 columns since My Goals is removed */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 overflow-y-auto md:overflow-hidden pb-10 md:pb-0">
        
        {/* Today's Work */}
        <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] p-6 md:p-8 border shadow-sm flex flex-col relative overflow-hidden group hover:shadow-md transition-all min-h-[300px] md:min-h-0">
          <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500"/>
          <div className="flex justify-between items-center mb-4 md:mb-6">
            <h3 className="text-base md:text-lg font-black text-slate-800 flex items-center gap-2"><CheckCircle className="text-emerald-500" size={18}/> 今日工作</h3>
            <span className="text-[10px] md:text-xs font-bold bg-emerald-50 text-emerald-600 px-3 py-1 rounded-full">{todayTasks.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 pr-1">
            {isWorkbenchTasksLoading ? <ColumnLoadingState label="正在加载今日工作..." /> : todayTasks.length > 0 ? todayTasks.map(t => (
              <TaskCard key={t.id} task={t} onClick={() => handleTaskClick(t)} />
            )) : <EmptyState label="今日暂无待办任务" />}
          </div>
        </div>

        {/* This Week's Work */}
        <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] p-6 md:p-8 border shadow-sm flex flex-col relative overflow-hidden group hover:shadow-md transition-all min-h-[300px] md:min-h-0">
          <div className="absolute top-0 left-0 w-full h-1 bg-indigo-500"/>
          <div className="flex justify-between items-center mb-4 md:mb-6">
            <h3 className="text-base md:text-lg font-black text-slate-800 flex items-center gap-2"><Briefcase className="text-indigo-500" size={18}/> 本周工作</h3>
            <span className="text-[10px] md:text-xs font-bold bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">{thisWeekTasks.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 pr-1">
            {isWorkbenchTasksLoading ? <ColumnLoadingState label="正在加载本周工作..." /> : thisWeekTasks.length > 0 ? thisWeekTasks.map(t => (
              <TaskCard key={t.id} task={t} onClick={() => handleTaskClick(t)} />
            )) : <EmptyState label="本周工作计划为空" />}
          </div>
        </div>

        {/* Next Week's Work */}
        <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] p-6 md:p-8 border shadow-sm flex flex-col relative overflow-hidden group hover:shadow-md transition-all min-h-[300px] md:min-h-0">
          <div className="absolute top-0 left-0 w-full h-1 bg-amber-500"/>
          <div className="flex justify-between items-center mb-4 md:mb-6">
            <h3 className="text-base md:text-lg font-black text-slate-800 flex items-center gap-2"><Calendar className="text-amber-500" size={18}/> 下周工作</h3>
            <span className="text-[10px] md:text-xs font-bold bg-amber-50 text-amber-600 px-3 py-1 rounded-full">{nextWeekTasks.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 pr-1">
            {isWorkbenchTasksLoading ? <ColumnLoadingState label="正在加载下周工作..." /> : nextWeekTasks.length > 0 ? nextWeekTasks.map(t => (
              <TaskCard key={t.id} task={t} onClick={() => handleTaskClick(t)} />
            )) : <EmptyState label="下周暂无计划" />}
          </div>
        </div>

      </div>

      <PageToast
        visible={!!toastState}
        message={toastState?.message || ''}
        type={toastState?.type}
        onClose={clearToast}
      />

      <TaskModal
        isOpen={taskModal.isOpen}
        onClose={() => {
          clearToast();
          setTaskModal({ ...taskModal, isOpen: false });
        }}
        data={taskModal.data}
        setData={(newData) => setTaskModal({ ...taskModal, data: newData })}
        onSave={saveTask}
        onDelete={deleteTask}
        users={state.users}
        departments={state.departments}
        groupedAvailableKRs={groupedAvailableKRs}
        mode={taskModal.mode}
        readOnly={
          taskModal.mode === 'create'
            ? !taskPermissions.create
            : (!taskPermissions.update || !canManageTask(taskModal.data as PADEntry, currentUser, state.systemRoles || [], state.departments))
        }
        aiSettings={state.aiSettings}
        currentUser={currentUser}
        isAdmin={isAdminUser(currentUser, state.systemRoles || [])}
      />
    </div>
  );
};

const TaskCard: React.FC<{ task: PADEntry, onClick: () => void }> = ({ task, onClick }) => (
  <div onClick={onClick} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 hover:border-indigo-200 hover:bg-white transition-all cursor-pointer group">
    <div className="flex justify-between items-start mb-2">
      <h4 className="font-bold text-sm text-slate-700 line-clamp-2">{task.title}</h4>
      <span className={`text-[9px] font-black px-2 py-0.5 rounded uppercase ${
        task.priority === 'high' ? 'bg-red-50 text-red-600' : 
        task.priority === 'medium' ? 'bg-amber-50 text-amber-600' : 
        'bg-slate-200 text-slate-500'
      }`}>
        {task.priority === 'high' ? '高优先级' : task.priority === 'medium' ? '中优先级' : '低优先级'}
      </span>
    </div>
    <div className="flex items-center gap-3 text-[10px] font-bold text-slate-400">
      <span className="flex items-center gap-1"><Clock size={10}/> {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '无截止日期'}</span>
      <span className={`flex items-center gap-1 ${task.status === 'completed' ? 'text-emerald-500' : ''}`}>
        {task.status === 'completed' ? <CheckCircle size={10}/> : <Flag size={10}/>}
        {task.status === 'draft' ? '草稿' : 
         task.status === 'submitted' ? '已提交' : 
         task.status === 'in-progress' ? '处理中' : 
         task.status === 'paused' ? '暂停' : 
         task.status === 'terminated' ? '终止' : 
         task.status === 'completed' ? '已完成' : task.status}
      </span>
    </div>
  </div>
);

const EmptyState = ({ label }: { label: string }) => (
  <div className="h-full flex flex-col items-center justify-center text-slate-300 gap-2">
    <ListTodo size={32} className="opacity-20"/>
    <span className="text-xs font-bold">{label}</span>
  </div>
);

const ColumnLoadingState = ({ label }: { label: string }) => (
  <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
    <Loader2 size={28} className="animate-spin opacity-60" />
    <span className="text-xs font-bold">{label}</span>
  </div>
);

function getWeekNumber(d: Date) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return weekNo;
}

export default WorkbenchView;
