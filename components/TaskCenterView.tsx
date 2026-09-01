import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, WeeklyPAD, PADEntry, User, Department, TaskLog, MenuPermission } from '../types';
import { 
  LayoutList, Clock, User as UserIcon, 
  Building2, Filter, Search, Calendar, Tag, ChevronDown, ChevronRight,
  Plus
} from 'lucide-react';
import PageToast from './PageToast';
import TaskModal from './TaskModal';
import { usePageToast } from '../hooks/usePageToast';
import { getUserFacingError } from '../utils/userFacingError';
import { canAssignTaskOwner, canManageTask, canViewTask, getAssignableTaskOwners, getVisibleDepartments, isAdminUser } from '../utils/permissions';
import { ensureTaskTargetWeeks } from '../utils/taskPeriods.js';
import { createTaskOkrGroups, getWeekDateRange } from '../utils/taskOkrOptions';
import { getTaskById, getTaskCenterPage, getTaskUsersForTasks, TaskCenterCursor } from '../data';



const TaskCenterView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('task-center');
  const { 
    handleSetDepartments: setDepartments, handleSetUsers: setUsers, 
    handleSetSystemRoles: setSystemRoles, handleSetAISettings: setAISettings, 
    handleSetBusinesses: setBusinesses, setProcessData, updateProcessProps, 
    addProcess, deleteProcessFn: deleteProcess, publishProcess, rollbackProcess, 
    handleSetTasks: setTasks, handleSetStrategy: setStrategy,
    persistTaskEntries, persistTaskDeletion
  } = actions;
  const setBackendError = state.setBackendError;
  const setAppState = state.setState;
  const setLastSavedTasks = state.setLastSavedTasks;
  const setLastSavedUsers = state.setLastSavedUsers;

  const flatAllDepartments = useMemo(() => {
    const list: Department[] = [];
    const collect = (items: Department[]) => {
      items.forEach((department) => {
        list.push(department);
        collect(department.subDepartments || []);
      });
    };
    collect(departments);
    return list;
  }, [departments]);
  const usersById = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);
  const deptsById = useMemo(() => new Map(flatAllDepartments.map(d => [d.id, d])), [flatAllDepartments]);
  const assignableTaskOwners = useMemo(
    () => getAssignableTaskOwners(currentUser, users, state.systemRoles || [], state.departments),
    [currentUser, users, state.systemRoles, state.departments]
  );

  const today = useMemo(() => new Date(), []);
  const currentWeekId = useMemo(() => {
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const year = d.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${year}-W${week.toString().padStart(2, '0')}`;
  }, [today]);

  const [filterType, setFilterType] = useState<'my' | 'org'>('my');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedOrgDeptId, setSelectedOrgDeptId] = useState<string | null>(null);
  const [orgTasks, setOrgTasks] = useState<PADEntry[]>([]);
  const [orgTotal, setOrgTotal] = useState(0);
  const [orgHasMore, setOrgHasMore] = useState(false);
  const [orgCursor, setOrgCursor] = useState<TaskCenterCursor | null>(null);
  const [taskModal, setTaskModal] = useState<{ isOpen: boolean, weekId: string | null, padId: string | null, mode: 'create' | 'edit', data: Partial<PADEntry> }>({ isOpen: false, weekId: null, padId: null, mode: 'create', data: {} });
  const [isOrgTasksLoading, setIsOrgTasksLoading] = useState(false);
  const orgRequestIdRef = useRef(0);
  const orgLoadingRef = useRef(false);
  const orgCursorRef = useRef<TaskCenterCursor | null>(null);
  const orgHasMoreRef = useRef(false);
  const { toastState, showToast, clearToast } = usePageToast();

  useEffect(() => {
    clearToast();
  }, [clearToast, filterType, statusFilter, priorityFilter]);

  const loadOrgTasks = useCallback(async (reset = true, requestedCursor?: TaskCenterCursor | null) => {
    if (!currentUser?.id) return;
    if (!reset && (orgLoadingRef.current || !orgHasMoreRef.current)) return;

    const requestId = orgRequestIdRef.current + 1;
    orgRequestIdRef.current = requestId;
    orgLoadingRef.current = true;
    setIsOrgTasksLoading(true);
    if (reset) {
      orgCursorRef.current = null;
      orgHasMoreRef.current = false;
      setOrgTasks([]);
      setOrgTotal(0);
      setOrgCursor(null);
      setOrgHasMore(false);
    }

    try {
      const page = await getTaskCenterPage({
        departmentId: selectedOrgDeptId,
        scope: selectedOrgDeptId ? 'subtree' : 'all',
        status: statusFilter,
        priority: priorityFilter,
        search: searchQuery,
        limit: 100,
        cursor: reset ? null : (requestedCursor ?? orgCursorRef.current),
      });
      if (requestId !== orgRequestIdRef.current) return;

      setOrgTasks((previous) => {
        if (reset) return page.tasks;
        const byId = new Map(previous.map((task) => [task.id, task]));
        page.tasks.forEach((task) => byId.set(task.id, task));
        return Array.from(byId.values());
      });
      setOrgTotal(page.total);
      orgHasMoreRef.current = page.hasMore;
      orgCursorRef.current = page.nextCursor;
      setOrgHasMore(page.hasMore);
      setOrgCursor(page.nextCursor);

      const currentUsers = useAppStore.getState().users || [];
      const knownUserIds = new Set(currentUsers.map(user => user.id));
      const taskIdsNeedingUsers = page.tasks
        .filter((task) => [task.createdBy, task.ownerId, ...(task.participantIds || []), ...(task.approverIds || [])]
          .some((userId) => userId && !knownUserIds.has(userId)))
        .map(task => task.id);
      if (taskIdsNeedingUsers.length > 0) {
        void getTaskUsersForTasks(taskIdsNeedingUsers).then((taskUsers) => {
          if (requestId !== orgRequestIdRef.current) return;
          const latestUsers = useAppStore.getState().users || currentUsers;
          const mergedUsersById = new Map(latestUsers.map(user => [user.id, user]));
          taskUsers.forEach(user => mergedUsersById.set(user.id, user));
          const mergedUsers = Array.from(mergedUsersById.values());
          setAppState({ users: mergedUsers });
          setLastSavedUsers(mergedUsers);
        }).catch((error) => console.warn('Task user enrichment failed; continuing with task data', error));
      }
    } catch (error: any) {
      if (requestId !== orgRequestIdRef.current) return;
      setBackendError(null);
      showToast(getUserFacingError(error, '组织任务加载失败，请稍后重试'), 'error');
    } finally {
      if (requestId === orgRequestIdRef.current) {
        orgLoadingRef.current = false;
        setIsOrgTasksLoading(false);
      }
    }
  }, [currentUser?.id, selectedOrgDeptId, statusFilter, priorityFilter, searchQuery, setBackendError, showToast, setAppState, setLastSavedUsers]);

  useEffect(() => {
    if (filterType !== 'org') return;
    void loadOrgTasks(true);
  }, [filterType, loadOrgTasks]);

  const handleFilterTypeChange = (nextFilterType: 'my' | 'org') => {
    setFilterType(nextFilterType);
  };

  const handleTaskClick = async (task: PADEntry, padId: string) => {
    const owner = usersById.get(task.ownerId);

    if (!canViewTask(task, currentUser, state.users, state.systemRoles || [], state.departments)) {
      showToast(`无任务查看权限，如果需要查看任务，请联系任务创建人【${owner?.name || ''}】`, 'info');
      return;
    }

    try {
      const fullTask = await getTaskById(task.id);
      const currentTasks = useAppStore.getState().tasks || [];
      const nextTasks = currentTasks.some(item => item.id === fullTask.id)
        ? currentTasks.map(item => item.id === fullTask.id ? fullTask : item)
        : [fullTask, ...currentTasks];
      setAppState({ tasks: nextTasks });
      setLastSavedTasks(nextTasks);

      const weekId = fullTask.targetWeeks?.[0] || null;
      setTaskModal({
        isOpen: true,
        weekId,
        padId: padId,
        mode: 'edit',
        data: fullTask
      });
    } catch (error: any) {
      setBackendError(null);
      showToast(getUserFacingError(error, '任务详情加载失败，请稍后重试'), 'error');
    }
  };

  const saveTask = async (status: string = 'draft', keepOpen: boolean = false) => {
    const newTask = ensureTaskTargetWeeks(
      { ...taskModal.data, status } as PADEntry,
      taskModal.weekId
    ) as PADEntry;
    const isNewTask = !state.tasks.some(e => e.id === newTask.id);
    const oldTask = state.tasks.find(e => e.id === newTask.id);
    const currentUserIsAdmin = isAdminUser(currentUser, state.systemRoles || []);

    if (!isNewTask) {
      if (!oldTask || !permissions.update || !canManageTask(oldTask, currentUser, state.systemRoles || [], state.departments)) {
        showToast('无权限修改该任务', 'error');
        return;
      }
      if (!currentUserIsAdmin) {
        newTask.ownerId = oldTask.ownerId;
      }
    } else if (!currentUserIsAdmin) {
      if (!canAssignTaskOwner(currentUser, state.users, newTask.ownerId, state.systemRoles || [], state.departments)) {
        newTask.ownerId = currentUser.id;
      }
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
    const entriesToAdd: PADEntry[] = [newTask];
    
    if (isNewTask) {
      nextTasks = [...entriesToAdd, ...nextTasks];
    } else {
      nextTasks = nextTasks.map(t => t.id === newTask.id ? newTask : t);
    }

    try {
      await persistTaskEntries(nextTasks, entriesToAdd, isNewTask ? 'create' : 'update');
      if (filterType === 'org') {
        void loadOrgTasks(true);
      }

      if (keepOpen) {
        const weekRange = getWeekDateRange(taskModal.weekId);
        setTaskModal({ 
          isOpen: true, 
          weekId: taskModal.weekId, 
          padId: taskModal.padId,
          mode: 'create',
          data: { 
            id: `task-${Date.now()}`,
            title: '', 
            status: 'draft',
            priority: 'medium',
            ownerId: currentUser.id,
                      departmentId: selectedOrgDeptId || currentUser.departmentId,
            startDate: weekRange?.startDate ?? Date.now(),
            dueDate: weekRange?.dueDate ?? (Date.now() + 86400000),
            action: '',
            deliverable: '',
            taskReview: '',
            taskReviewScore: undefined,
            tags: [],
            participantIds: [],
            approverIds: []
          } 
        });
      } else {
        setTaskModal({ isOpen: false, weekId: null, padId: null, mode: 'create', data: {} });
      }
      showToast('任务已保存', 'success');
    } catch (error: any) {
      setBackendError(null);
      showToast(getUserFacingError(error, '任务保存失败，请稍后重试'), 'error');
    }
  };

  const deleteTask = async () => {
    if (!taskModal.data.id) return;
    const taskId = taskModal.data.id;
    const taskToDelete = state.tasks.find(t => t.id === taskId);
    if (!taskToDelete || !permissions.update || !canManageTask(taskToDelete, currentUser, state.systemRoles || [], state.departments)) {
      showToast('无权限删除该任务', 'error');
      return;
    }
    const nextTasks = state.tasks.filter(t => t.id !== taskId);

    try {
      await persistTaskDeletion(nextTasks, [taskId]);
      if (filterType === 'org') {
        void loadOrgTasks(true);
      }
      setTaskModal({ isOpen: false, weekId: null, padId: null, mode: 'create', data: {} });
      showToast('任务已删除', 'info');
    } catch (error: any) {
      setBackendError(null);
      showToast(getUserFacingError(error, '任务删除失败，请稍后重试'), 'error');
    }
  };

  const groupedAvailableKRs = useMemo(() => {
    return createTaskOkrGroups({
      companyOKRs: state.strategy.companyOKRs,
      departments: state.departments,
      currentUser,
      ownerId: taskModal.data.ownerId,
      users,
      isAdmin: isAdminUser(currentUser, state.systemRoles || []),
      startDate: taskModal.data.startDate,
      dueDate: taskModal.data.dueDate,
      fallbackWeekId: taskModal.weekId
    });
  }, [
    state.strategy.companyOKRs,
    state.departments,
    state.systemRoles,
    currentUser,
    taskModal.data.ownerId,
    taskModal.data.startDate,
    taskModal.data.dueDate,
    taskModal.weekId,
    users
  ]);

  const allTasks = useMemo(() => {
    const tasks: { padId: string, entry: PADEntry, owner: User | undefined, dept: Department | undefined }[] = [];

    const sourceTasks = filterType === 'org' ? orgTasks : state.tasks;
    sourceTasks.forEach(entry => {
      if (!canViewTask(entry, currentUser, users, state.systemRoles || [], departments)) return;

      const owner = usersById.get(entry.ownerId);
      const dept = deptsById.get(entry.departmentId || owner?.departmentId || '');
      
      tasks.push({
        padId: 'flat', // No longer using padId
        entry,
        owner,
        dept
      });
    });
    return tasks;
  }, [filterType, orgTasks, state.tasks, users, departments, currentUser, state.systemRoles, usersById, deptsById]);

  const visibleDepartments = useMemo(() => getVisibleDepartments(currentUser, departments, state.systemRoles || []), [currentUser, departments, state.systemRoles]);

  const flatDepts = useMemo(() => {
    const list: Department[] = [];
    const collect = (depts: Department[]) => {
      depts.forEach(d => {
        list.push(d);
        if (d.subDepartments) collect(d.subDepartments);
      });
    };
    collect(visibleDepartments);
    return list;
  }, [visibleDepartments]);

  const renderDeptTree = (depts: Department[], depth = 0) => {
    return depts.map(d => (
      <div key={d.id} className="mb-1">
        <div 
          onClick={() => setSelectedOrgDeptId(d.id)}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition-colors ${selectedOrgDeptId === d.id ? 'bg-indigo-50 text-indigo-600 font-bold' : 'text-slate-600 hover:bg-slate-50'}`}
          style={{ paddingLeft: `${depth * 12 + 12}px` }}
        >
          <Building2 size={14} className={selectedOrgDeptId === d.id ? 'text-indigo-600' : 'text-slate-400'}/>
          <span className="text-xs truncate">{d.name}</span>
        </div>
        {d.subDepartments && renderDeptTree(d.subDepartments, depth + 1)}
      </div>
    ));
  };

  const isDeptInHierarchy = (targetDeptId: string, currentDeptId: string): boolean => {
    if (targetDeptId === currentDeptId) return true;
    const findDept = (depts: Department[], id: string): Department | undefined => {
      for (const d of depts) {
        if (d.id === id) return d;
        if (d.subDepartments) {
          const found = findDept(d.subDepartments, id);
          if (found) return found;
        }
      }
      return undefined;
    };
    const currentDept = findDept(departments, currentDeptId);
    if (!currentDept || !currentDept.subDepartments) return false;
    return !!findDept(currentDept.subDepartments, targetDeptId);
  };

  // Extract creation timestamp from task id (format: task-TIMESTAMP or task-TIMESTAMP-N)
  const getTaskCreatedAt = (id: string): number => {
    const match = id.match(/task-(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  };

  const filteredTasks = useMemo(() => {
    const result = allTasks.filter(item => {
      const { entry, owner } = item;
      
      // Type Filter
      if (filterType === 'my') {
        const isOwner = owner?.id === currentUser.id;
        const isParticipant = entry.participantIds?.includes(currentUser.id);
        const isApprover = entry.approverIds?.includes(currentUser.id);
        if (!isOwner && !isParticipant && !isApprover) return false;
      } else if (filterType === 'org') {
        // Org tasks filtering
        const isSelf = owner?.id === currentUser.id;
        const taskDeptId = entry.departmentId || owner?.departmentId;
        
        if (selectedOrgDeptId) {
          if (!taskDeptId) return false;
          if (!isDeptInHierarchy(taskDeptId, selectedOrgDeptId)) {
            return false;
          }
        } else {
          // If no specific department selected, only show tasks from visible departments or self
          const isVisibleDept = taskDeptId ? flatDepts.some(d => d.id === taskDeptId) : false;
          if (!isSelf && !isVisibleDept) return false;
        }
      }

      // Status Filter
      if (statusFilter !== 'all' && entry.status !== statusFilter) return false;

      // Priority Filter
      if (priorityFilter !== 'all' && entry.priority !== priorityFilter) return false;

      // Search
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          entry.title?.toLowerCase().includes(query) ||
          entry.plan?.toLowerCase().includes(query) ||
          owner?.name.toLowerCase().includes(query)
        );
      }

      return true;
    });

    if (filterType === 'org') return result;
    return result.sort((a, b) => {
      const timeA = getTaskCreatedAt(a.entry.id);
      const timeB = getTaskCreatedAt(b.entry.id);
      if (timeB !== timeA) return timeB - timeA;
      return (b.entry.startDate ?? 0) - (a.entry.startDate ?? 0);
    });
  }, [allTasks, filterType, statusFilter, priorityFilter, searchQuery, currentUser, selectedOrgDeptId, departments]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'draft': return 'bg-slate-100 text-slate-500';
      case 'submitted': return 'bg-blue-50 text-blue-600';
      case 'in-progress': return 'bg-indigo-50 text-indigo-600';
      case 'paused': return 'bg-amber-50 text-amber-600';
      case 'terminated': return 'bg-red-50 text-red-600';
      case 'completed': return 'bg-emerald-50 text-emerald-600';
      default: return 'bg-slate-50 text-slate-400';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'text-red-500 bg-red-50';
      case 'medium': return 'text-amber-500 bg-amber-50';
      case 'low': return 'text-blue-500 bg-blue-50';
      default: return 'text-slate-400 bg-slate-50';
    }
  };

  return (
    <div className="h-full flex flex-col gap-4 md:gap-6 p-4 md:p-6 bg-slate-50 relative overflow-hidden">
      <div className="bg-white p-4 md:p-6 rounded-[2.5rem] border shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center shrink-0 gap-4">
        <div className="flex items-center gap-4 md:gap-6">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 shadow-inner">
            <LayoutList size={20} className="md:w-6 md:h-6" />
          </div>
          <div>
            <h2 className="text-lg md:text-xl font-black text-slate-800 tracking-tighter">任务中心</h2>
            <p className="text-[10px] font-black text-slate-400 uppercase mt-0.5">Task Center</p>
          </div>
        </div>

        <div className="flex items-center gap-4 w-full md:w-auto">
          <div className="flex bg-slate-100 p-1 rounded-2xl w-full md:w-auto">
            <button 
              onClick={() => handleFilterTypeChange('my')}
              className={`flex-1 md:flex-none px-4 md:px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterType === 'my' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
            >
              我的任务
            </button>
            <button 
              onClick={() => handleFilterTypeChange('org')}
              disabled={isOrgTasksLoading}
              className={`flex-1 md:flex-none px-4 md:px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterType === 'org' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
            >
              {isOrgTasksLoading ? '加载中...' : '组织任务'}
            </button>
          </div>
          {permissions.update && (
            <div className="flex gap-2">
              <button 
                onClick={() => {
                  const weekRange = getWeekDateRange(currentWeekId);
                  setTaskModal({ 
                    isOpen: true, 
                    weekId: currentWeekId, 
                    padId: null,
                    mode: 'create',
                    data: {
                      id: `task-${Date.now()}`,
                      title: '',
                      status: 'draft',
                      priority: 'medium',
                      ownerId: currentUser.id,
            departmentId: selectedOrgDeptId || currentUser.departmentId,
                      startDate: weekRange?.startDate ?? Date.now(),
                      dueDate: weekRange?.dueDate ?? (Date.now() + 86400000),
                      action: '',
                      deliverable: '',
                      taskReview: '',
                      taskReviewScore: undefined,
                      tags: [],
                      participantIds: [],
                      approverIds: []
                    } 
                  });
                }}
                className="px-6 py-2.5 bg-brand-600 text-white rounded-xl text-xs font-black uppercase flex items-center gap-2 hover:bg-brand-700 transition-all shadow-md shadow-brand-100"
              >
                <Plus size={16} /> 新增任务
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row gap-4 md:gap-6 overflow-hidden relative pb-10">
        {filterType === 'org' && (
          <aside className="w-full md:w-64 bg-white border rounded-[2.5rem] shadow-sm flex flex-col overflow-hidden shrink-0 max-h-48 md:max-h-full">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">按组织架构筛选</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
              <div 
                onClick={() => setSelectedOrgDeptId(null)}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition-colors mb-1 ${selectedOrgDeptId === null ? 'bg-indigo-50 text-indigo-600 font-bold' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                <Building2 size={14} className={selectedOrgDeptId === null ? 'text-indigo-600' : 'text-slate-400'}/>
                <span className="text-xs truncate">全部组织任务</span>
              </div>
              {renderDeptTree(visibleDepartments)}
            </div>
          </aside>
        )}

        <div className="flex-1 bg-white border rounded-[2.5rem] flex flex-col overflow-hidden shadow-sm p-4 md:p-6">
          {/* Filters */}
          <div className="flex flex-col md:flex-row flex-wrap gap-3 md:gap-4 mb-4 md:mb-6 items-stretch md:items-center">
          <div className="relative w-full md:w-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input 
              type="text" 
              placeholder="搜索任务..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-indigo-500 w-full md:w-64"
            />
          </div>
          
          <div className="flex gap-3 w-full md:w-auto">
            <select 
              value={statusFilter} 
              onChange={e => setStatusFilter(e.target.value)}
              className="flex-1 md:flex-none px-4 py-2 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-indigo-500"
            >
              <option value="all">所有状态</option>
              <option value="draft">草稿</option>
              <option value="submitted">已提交</option>
              <option value="in-progress">处理中</option>
              <option value="paused">暂停</option>
              <option value="terminated">终止</option>
              <option value="completed">已完成</option>
            </select>

            <select 
              value={priorityFilter} 
              onChange={e => setPriorityFilter(e.target.value)}
              className="flex-1 md:flex-none px-4 py-2 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-indigo-500"
            >
              <option value="all">所有优先级</option>
              <option value="high">高优先级</option>
              <option value="medium">中优先级</option>
              <option value="low">低优先级</option>
            </select>
          </div>
        </div>

        {/* Task List */}
        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4">
          {filteredTasks.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400">
              <LayoutList size={48} className="mb-4 opacity-20" />
              <p className="text-sm font-bold">暂无任务</p>
            </div>
          ) : (
            filteredTasks.map(({ padId, entry, owner, dept }) => (
              <div key={entry.id} onClick={() => handleTaskClick(entry, padId)} className="bg-white border rounded-2xl p-4 hover:shadow-md transition-shadow flex items-start gap-4 group cursor-pointer">
                <div className={`w-2 h-full rounded-full self-stretch ${getPriorityColor(entry.priority || 'low').replace('text-', 'bg-').replace('bg-', 'bg-opacity-20 ')}`}></div>
                
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="min-w-0 flex-1 text-sm font-bold text-slate-800 line-clamp-2 break-words [overflow-wrap:anywhere]">{entry.title || entry.plan || '无标题任务'}</h3>
                    <span className={`shrink-0 ml-3 text-[10px] font-black px-2 py-1 rounded-lg uppercase ${getStatusColor(entry.status || 'draft')}`}>
                      {entry.status === 'draft' ? '草稿' : 
                       entry.status === 'submitted' ? '已提交' : 
                       entry.status === 'in-progress' ? '处理中' : 
                       entry.status === 'paused' ? '暂停' : 
                       entry.status === 'terminated' ? '终止' : 
                       entry.status === 'completed' ? '已完成' : '未知'}
                    </span>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-4 text-[10px] font-bold text-slate-500 mb-3">
                    <div className="flex items-center gap-1">
                      <UserIcon size={12} />
                      <span>{owner?.name || '未知用户'}</span>
                    </div>
                    {dept && (
                      <div className="flex items-center gap-1">
                        <Building2 size={12} />
                        <span>{dept.name}</span>
                      </div>
                    )}
                    {entry.dueDate && (
                      <div className="flex items-center gap-1">
                        <Calendar size={12} />
                        <span>{new Date(entry.dueDate).toLocaleDateString()}</span>
                      </div>
                    )}
                    <div className={`shrink-0 px-2 py-0.5 rounded ${getPriorityColor(entry.priority || 'low')}`}>
                      {entry.priority === 'high' ? '高' : entry.priority === 'medium' ? '中' : '低'}
                    </div>
                  </div>

                  {entry.tags && entry.tags.length > 0 && (
                    <div className="flex gap-2">
                      {entry.tags.map(tag => (
                        <span key={tag} className="text-[9px] font-bold px-2 py-0.5 bg-slate-100 text-slate-500 rounded-md flex items-center gap-1">
                          <Tag size={10} /> {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {filterType === 'org' && orgHasMore && (
            <button
              type="button"
              onClick={() => void loadOrgTasks(false, orgCursor)}
              disabled={isOrgTasksLoading}
              className="w-full py-3 border border-slate-200 rounded-xl text-xs font-black text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              {isOrgTasksLoading ? '加载中...' : `加载更多（已加载 ${orgTasks.length} / ${orgTotal}）`}
            </button>
          )}
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
        isSaving={state.isSaving}
        onDelete={deleteTask}
        users={users}
        departments={departments}
        groupedAvailableKRs={groupedAvailableKRs}
        mode={taskModal.mode}
        readOnly={
          taskModal.mode === 'create'
            ? !permissions.create
            : (!permissions.update || !canManageTask(taskModal.data as PADEntry, currentUser, state.systemRoles || [], state.departments))
        }
        aiSettings={state.aiSettings}
        currentUser={currentUser}
        isAdmin={isAdminUser(currentUser, state.systemRoles || [])}
        assignableOwners={assignableTaskOwners}
      />
    </div>
  );
};

export default TaskCenterView;
