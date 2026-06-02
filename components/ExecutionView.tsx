import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, Department, User, WeeklyPAD, PADEntry, OKR, TaskLog, MenuPermission } from '../types';
import PageToast from './PageToast';
import PeriodAlignmentView from './PeriodAlignmentView';
import TaskModal from './TaskModal';
import { Building2, ChevronDown, ChevronRight, LayoutGrid, Plus, X, Calendar, User as UserIcon, Clock } from 'lucide-react';
import { usePageToast } from '../hooks/usePageToast';
import { getUserFacingError } from '../utils/userFacingError';
import { canAssignTaskOwner, canManageDepartment, canManageTask, canViewTask, getAssignableTaskOwners, getVisibleDepartments, isAdminUser } from '../utils/permissions';
import { ensureTaskTargetWeeks } from '../utils/taskPeriods.js';



const getCurrentWeekInfo = () => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  
  let q = 'Q1';
  if (week > 13 && week <= 26) q = 'Q2';
  else if (week > 26 && week <= 39) q = 'Q3';
  else if (week > 39) q = 'Q4';

  return { year: d.getUTCFullYear(), week, q };
};

const ExecutionView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('execution');
  const { 
    handleSetDepartments: setDepartments, handleSetUsers: setUsers, 
    handleSetSystemRoles: setSystemRoles, handleSetAISettings: setAISettings, 
    handleSetBusinesses: setBusinesses, setProcessData, updateProcessProps, 
    addProcess, deleteProcessFn: deleteProcess, publishProcess, rollbackProcess, 
    handleSetTasks: setTasks, handleSetStrategy: setStrategy,
    persistTaskEntries, persistTaskDeletion
  } = actions;
  const setIsDirty = state.setIsDirty;
  const backendError = state.backendError;
  const currentProcessId = state.currentProcessId;
  const setCurrentProcessId = state.setCurrentProcessId;

  const currentInfo = useMemo(() => getCurrentWeekInfo(), []);
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(currentUser.departmentId || null);
  const [selectedYear, setSelectedYear] = useState<number>(currentInfo.year);
  const [selectedPeriod, setSelectedPeriod] = useState<string>(currentInfo.q);
  const [taskModal, setTaskModal] = useState<{ isOpen: boolean, weekId: string | null, mode: 'create' | 'edit', data: Partial<PADEntry> }>({ isOpen: false, weekId: null, mode: 'create', data: {} });
  const { toastState, showToast, clearToast } = usePageToast();

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const periodWeeks = useMemo(() => {
    let start = 1;
    let end = 52;
    if (selectedPeriod === 'Q1') { start = 1; end = 13; }
    else if (selectedPeriod === 'Q2') { start = 14; end = 26; }
    else if (selectedPeriod === 'Q3') { start = 27; end = 39; }
    else if (selectedPeriod === 'Q4') { start = 40; end = 52; }
    
    const weeks = [];
    for (let i = start; i <= end; i++) {
      weeks.push({
        id: `${selectedYear}-W${i.toString().padStart(2, '0')}`,
        label: `第${i}周`
      });
    }
    return weeks;
  }, [selectedYear, selectedPeriod]);

  useEffect(() => {
    clearToast();
  }, [clearToast, selectedDeptId, selectedYear, selectedPeriod]);

  const visibleDepartments = useMemo(() => getVisibleDepartments(currentUser, state.departments, state.systemRoles || []), [currentUser, state.departments, state.systemRoles]);

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
  const currentUserIsAdmin = useMemo(
    () => isAdminUser(currentUser, state.systemRoles || []),
    [currentUser, state.systemRoles]
  );
  const assignableTaskOwners = useMemo(
    () => getAssignableTaskOwners(currentUser, state.users, state.systemRoles || []),
    [currentUser, state.users, state.systemRoles]
  );

  const selectedDepartment = useMemo(
    () => flatDepts.find(d => d.id === selectedDeptId) || null,
    [flatDepts, selectedDeptId]
  );
  const canManageSelectedDepartment = selectedDepartment
    ? canManageDepartment(selectedDepartment, currentUser, state.systemRoles || [], state.departments)
    : false;
  const canCreateExecutionTask = permissions.create && (
    currentUserIsAdmin
      ? canManageSelectedDepartment
      : selectedDeptId === currentUser.departmentId
  );
  const canEditExecutionTask = permissions.update;

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
    flatDepts.forEach(d => {
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
  }, [state.strategy.companyOKRs, flatDepts, taskModal.weekId]);

  const renderDeptTree = (depts: Department[], depth = 0) => {
    const handleDeptClick = (id: string) => {
      setSelectedDeptId(id);
      setIsSidebarOpen(false);
    };

    return depts.map(d => (
      <div key={d.id} className="mb-1">
        <div 
          onClick={() => handleDeptClick(d.id)}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition-colors ${selectedDeptId === d.id ? 'bg-brand-50 text-brand-600 font-bold' : 'text-slate-600 hover:bg-slate-50'}`}
          style={{ paddingLeft: `${depth * 12 + 12}px` }}
        >
          <Building2 size={14} className={selectedDeptId === d.id ? 'text-brand-600' : 'text-slate-400'}/>
          <span className="text-xs truncate">{d.name}</span>
        </div>
        {d.subDepartments && renderDeptTree(d.subDepartments, depth + 1)}
      </div>
    ));
  };

  const handleAddTask = (weekId: string, alignedKrId: string) => {
    if (!canCreateExecutionTask) return;
    setTaskModal({
      isOpen: true,
      weekId,
      mode: 'create',
      data: {
        id: `task-${Date.now()}`,
        title: '',
        status: 'draft',
        priority: 'medium',
        ownerId: currentUser.id,
        departmentId: currentUserIsAdmin ? (selectedDeptId || currentUser.departmentId) : currentUser.departmentId,
        alignedKrId: alignedKrId,
        targetWeeks: [weekId],
        startDate: Date.now(),
        dueDate: Date.now() + 86400000,
        tags: [],
        participantIds: [],
        approverIds: []
      }
    });
  };

  const handleTaskClick = (weekId: string, task: PADEntry) => {
    const owner = state.users.find(u => u.id === task.ownerId);

    if (!canViewTask(task, currentUser, state.users, state.systemRoles || [], state.departments)) {
      showToast(`无任务查看权限，如果需要查看任务，请联系任务创建人【${owner?.name || ''}】`, 'info');
      return;
    }

    setTaskModal({
      isOpen: true,
      weekId,
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
    const targetOwnerId = newTask.ownerId || currentUser.id;

    const isNewTask = !state.tasks.some(e => e.id === newTask.id);
    const oldTask = state.tasks.find(e => e.id === newTask.id);
    if (isNewTask && !canCreateExecutionTask) return;
    if (!isNewTask && (!oldTask || !permissions.update || !canManageTask(oldTask, currentUser, state.systemRoles || [], state.departments))) return;
    if (!isNewTask && !currentUserIsAdmin && oldTask) {
      newTask.ownerId = oldTask.ownerId;
    } else if (isNewTask && !currentUserIsAdmin) {
      if (!canAssignTaskOwner(currentUser, state.users, newTask.ownerId, state.systemRoles || [])) {
        newTask.ownerId = currentUser.id;
      }
      newTask.departmentId = currentUser.departmentId;
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
    } catch (error: any) {
      showToast(getUserFacingError(error, '任务保存失败，请稍后重试'), 'error');
      return;
    }

    // Show success message with location and week info
    const ownerName = state.users.find(u => u.id === targetOwnerId)?.name || '个人';
    const weekNum = taskModal.weekId?.split('-W')[1] || '';
    const actionText = status === 'submitted' ? '提交' : '保存';
    showToast(`第 ${weekNum} 周任务已成功${actionText}至 [${ownerName}] 的个人计划中`);

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
          departmentId: currentUserIsAdmin ? (selectedDeptId || currentUser.departmentId) : currentUser.departmentId,
          alignedKrId: taskModal.data.alignedKrId,
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

  const handleDeleteTask = async () => {
    if (!taskModal.data.id) return;
    const taskId = taskModal.data.id;
    const taskToDelete = state.tasks.find(t => t.id === taskId);
    if (!taskToDelete || !permissions.update || !canManageTask(taskToDelete, currentUser, state.systemRoles || [], state.departments)) {
      showToast('无权限删除该任务', 'error');
      return;
    }
    const updatedTasks = state.tasks.filter(t => t.id !== taskId);

    try {
      await persistTaskDeletion(updatedTasks, [taskId]);
      setTaskModal({ ...taskModal, isOpen: false });
      showToast('任务已删除', 'info');
    } catch (error: any) {
      showToast(getUserFacingError(error, '任务删除失败，请稍后重试'), 'error');
    }
  };

  return (
    <div className="h-full flex flex-col md:flex-row gap-4 md:gap-6 overflow-hidden relative">
      {/* Mobile Sidebar Toggle */}
      <div className="md:hidden flex justify-between items-center bg-white p-4 rounded-2xl border shadow-sm shrink-0">
        <div className="flex items-center gap-2 font-black text-slate-800">
          <Building2 size={20} className="text-brand-600"/>
          <span>{selectedDeptId ? flatDepts.find(d => d.id === selectedDeptId)?.name : '选择部门'}</span>
        </div>
        <button 
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="p-2 bg-slate-100 text-slate-600 rounded-xl"
        >
          <ChevronDown className={`transition-transform ${isSidebarOpen ? 'rotate-180' : ''}`}/>
        </button>
      </div>

      {/* Left Sidebar: Org Tree */}
      <div className={`
        absolute md:relative z-10 md:z-0
        w-full md:w-64 bg-white border rounded-2xl md:rounded-[2.5rem] p-4 md:p-6 flex flex-col shadow-xl md:shadow-sm shrink-0
        transition-all duration-300 origin-top
        ${isSidebarOpen ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0 md:scale-y-100 md:opacity-100'}
        top-[72px] md:top-0 left-0
      `}>
        <div className="mb-4 md:mb-6">
          <h3 className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest mb-3 md:mb-4">
            组织架构
          </h3>
          <div className="space-y-1 overflow-y-auto custom-scrollbar max-h-[40vh] md:max-h-[calc(100vh-200px)]">
            {renderDeptTree(visibleDepartments)}
          </div>
        </div>
      </div>

      {/* Right Content: Period Alignment View */}
      <div className="flex-1 flex flex-col overflow-hidden bg-white border rounded-2xl md:rounded-[2.5rem] shadow-sm relative">
        <div className="p-4 md:p-6 border-b flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
             <div className="flex items-center gap-3 md:gap-4">
                <div className="p-2 md:p-3 bg-brand-50 text-brand-600 rounded-xl md:rounded-2xl"><LayoutGrid size={20} className="md:w-6 md:h-6"/></div>
                <div>
                  <h3 className="text-lg md:text-xl font-black text-slate-800">OKR 执行</h3>
                  <p className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-widest">目标执行看板</p>
                </div>
             </div>
             <div className="flex flex-wrap items-center gap-2 md:gap-4 w-full md:w-auto">
                <select 
                  className="flex-1 md:flex-none bg-slate-50 border rounded-xl px-2 md:px-3 py-2 text-[10px] md:text-xs font-bold outline-none text-slate-600"
                  value={selectedYear}
                  onChange={e => setSelectedYear(Number(e.target.value))}
                >
                  {[new Date().getFullYear(), new Date().getFullYear() + 1].map(y => <option key={y} value={y}>{y} 年</option>)}
                </select>
                <select 
                  className="flex-1 md:flex-none bg-slate-50 border rounded-xl px-2 md:px-3 py-2 text-[10px] md:text-xs font-bold outline-none text-slate-600"
                  value={selectedPeriod}
                  onChange={e => setSelectedPeriod(e.target.value)}
                >
                  <option value="Q1">第一季度</option>
                  <option value="Q2">第二季度</option>
                  <option value="Q3">第三季度</option>
                  <option value="Q4">第四季度</option>
                </select>
             </div>
        </div>

        <div className="flex-1 overflow-hidden p-2 md:p-6">
          {selectedDeptId ? (
            <PeriodAlignmentView
              selectedYear={selectedYear}
              selectedPeriod={selectedPeriod}
              selectedDeptId={selectedDeptId}
              canCreateTask={canCreateExecutionTask}
              canEditTask={canEditExecutionTask}
              onAddTask={handleAddTask}
              onTaskClick={handleTaskClick}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4">
              <Building2 size={48} className="opacity-20"/>
              <p className="font-bold">请选择一个部门以查看执行情况</p>
            </div>
          )}
        </div>
      </div>

      <PageToast
        visible={!!toastState}
        message={toastState?.message || ''}
        type={toastState?.type}
        onClose={clearToast}
      />

      {/* Task Modal */}
      <TaskModal
        isOpen={taskModal.isOpen}
        onClose={() => {
          clearToast();
          setTaskModal({ ...taskModal, isOpen: false });
        }}
        data={taskModal.data}
        setData={(newData) => setTaskModal({ ...taskModal, data: newData })}
        onSave={saveTask}
        onDelete={handleDeleteTask}
        users={state.users}
        departments={state.departments}
        groupedAvailableKRs={groupedAvailableKRs}
        mode={taskModal.mode}
        readOnly={
          taskModal.mode === 'create'
            ? !canCreateExecutionTask
            : (!permissions.update || !canManageTask(taskModal.data as PADEntry, currentUser, state.systemRoles || [], state.departments))
        }
        periodWeeks={periodWeeks}
        currentUser={currentUser}
        isAdmin={currentUserIsAdmin}
        assignableOwners={assignableTaskOwners}
      />
    </div>
  );
};

export default ExecutionView;
