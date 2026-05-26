import React, { useState, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, WeeklyPAD, PADEntry, User, Department, OKR, TaskLog, MenuPermission } from '../types';
import { 
  LayoutList, CheckCircle, Clock, AlertCircle, User as UserIcon, 
  Building2, Filter, Search, Calendar, Tag, ChevronDown, ChevronRight,
  Plus
} from 'lucide-react';
import TaskModal from './TaskModal';
import { getVisibleDepartments, canManageTask, canViewTask } from '../utils/permissions';
import { ensureTaskTargetWeeks } from '../utils/taskPeriods.js';



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
  const setIsDirty = state.setIsDirty;
  const backendError = state.backendError;
  const currentProcessId = state.currentProcessId;
  const setCurrentProcessId = state.setCurrentProcessId;

  const today = useMemo(() => new Date(), []);
  const currentWeekId = useMemo(() => {
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const year = d.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${year}-W${week.toString().padStart(2, '0')}`;
  }, [today]);

  const [filterType, setFilterType] = useState<'my' | 'org' | 'all'>('my');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [taskModal, setTaskModal] = useState<{ isOpen: boolean, weekId: string | null, padId: string | null, mode: 'create' | 'edit', data: Partial<PADEntry> }>({ isOpen: false, weekId: null, padId: null, mode: 'create', data: {} });
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);

  const showNotification = (message: string, type: 'success' | 'info' | 'error' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const handleTaskClick = (task: PADEntry, padId: string) => {
    const isOwner = task.ownerId === currentUser.id;
    const isParticipant = task.participantIds?.includes(currentUser.id);
    const isApprover = task.approverIds?.includes(currentUser.id);
    const owner = state.users.find(u => u.id === task.ownerId);

    let hasPermission = true;
    if (!isOwner && !isParticipant && !isApprover) {
      if (task.visibility === 'private') {
        hasPermission = false;
      } else if (task.visibility === 'department') {
        const targetDeptId = task.departmentId || owner?.departmentId;
        if (targetDeptId !== currentUser.departmentId && !currentUser.padPermissions?.includes(targetDeptId || '')) {
          hasPermission = false;
        }
      } else if (task.visibility === 'members') {
        hasPermission = false;
      }
    }

    if (!hasPermission) {
      showNotification(`无任务查看权限，如果需要查看任务，请联系任务创建人【${owner?.name || ''}】`, 'info');
      return;
    }

    const weekId = task.targetWeeks?.[0] || null;
    setTaskModal({
      isOpen: true,
      weekId,
      padId: padId,
      mode: 'edit',
      data: task
    });
  };

  const saveTask = async (status: string = 'draft', keepOpen: boolean = false) => {
    const newTask = ensureTaskTargetWeeks(
      { ...taskModal.data, status } as PADEntry,
      taskModal.weekId
    ) as PADEntry;
    const isNewTask = !state.tasks.some(e => e.id === newTask.id);

    if (!isNewTask) {
      const oldTask = state.tasks.find(e => e.id === newTask.id);

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
      nextTasks = [...nextTasks, ...entriesToAdd];
    } else {
      nextTasks = nextTasks.map(t => t.id === newTask.id ? newTask : t);
    }

    try {
      await persistTaskEntries(nextTasks, entriesToAdd, isNewTask ? 'create' : 'update');

      if (keepOpen) {
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
            departmentId: currentUser.departmentId,
            visibility: 'public',
            startDate: Date.now(),
            dueDate: Date.now() + 86400000,
            tags: [],
            participantIds: [],
            approverIds: []
          } 
        });
      } else {
        setTaskModal({ isOpen: false, weekId: null, padId: null, mode: 'create', data: {} });
      }
      showNotification('任务已保存', 'success');
    } catch (error: any) {
      showNotification(error.message || '任务保存失败', 'error');
    }
  };

  const deleteTask = async () => {
    if (!taskModal.data.id) return;
    const taskId = taskModal.data.id;
    const nextTasks = state.tasks.filter(t => t.id !== taskId);

    try {
      await persistTaskDeletion(nextTasks, [taskId]);
      setTaskModal({ isOpen: false, weekId: null, padId: null, mode: 'create', data: {} });
      showNotification('任务已删除', 'info');
    } catch (error: any) {
      showNotification(error.message || '任务删除失败', 'error');
    }
  };

  const groupedAvailableKRs = useMemo(() => {
    if (!taskModal.weekId) return [];
    const year = parseInt(taskModal.weekId.split('-')[0]);
    const groups: { label: string, options: { id: string, name: string }[] }[] = [];
    
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

    departments.forEach(d => {
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
  }, [state.strategy.companyOKRs, departments, taskModal.weekId]);

  const allTasks = useMemo(() => {
    const tasks: { padId: string, entry: PADEntry, owner: User | undefined, dept: Department | undefined }[] = [];
    
    state.tasks.forEach(entry => {
      if (!canViewTask(entry, currentUser, users, state.systemRoles || [])) return;

      const owner = users.find(u => u.id === entry.ownerId);
      const dept = departments.find(d => d.id === (entry.departmentId || owner?.departmentId));
      
      tasks.push({
        padId: 'flat', // No longer using padId
        entry,
        owner,
        dept
      });
    });
    return tasks;
  }, [state.tasks, users, departments, currentUser]);

  const [selectedOrgDeptId, setSelectedOrgDeptId] = useState<string | null>(null);

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

  const filteredTasks = useMemo(() => {
    return allTasks.filter(item => {
      const { entry, owner } = item;
      
      // Type Filter
      if (filterType === 'my') {
        const isOwner = owner?.id === currentUser.id;
        const isParticipant = entry.participantIds?.includes(currentUser.id);
        if (!isOwner && !isParticipant) return false;
      } else if (filterType === 'org') {
        // Org tasks filtering
        const isSelf = owner?.id === currentUser.id;
        
        if (selectedOrgDeptId) {
          if (!owner?.departmentId) return false;
          if (!isDeptInHierarchy(owner.departmentId, selectedOrgDeptId)) {
            return false;
          }
        } else {
          // If no specific department selected, only show tasks from visible departments or self
          const isVisibleDept = owner?.departmentId ? flatDepts.some(d => d.id === owner.departmentId) : false;
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
              onClick={() => setFilterType('my')}
              className={`flex-1 md:flex-none px-4 md:px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterType === 'my' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
            >
              我的任务
            </button>
            <button 
              onClick={() => setFilterType('org')}
              className={`flex-1 md:flex-none px-4 md:px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterType === 'org' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
            >
              组织任务
            </button>
          </div>
          {permissions.update && (
            <div className="flex gap-2">
              <button 
                onClick={() => setTaskModal({ 
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
                    departmentId: currentUser.departmentId,
                    visibility: 'private',
                    startDate: Date.now(),
                    dueDate: Date.now() + 86400000,
                    tags: [],
                    participantIds: [],
                    approverIds: []
                  } 
                })}
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
            filteredTasks.map(({ padId, entry, owner, dept }, idx) => (
              <div key={idx} onClick={() => handleTaskClick(entry, padId)} className="bg-white border rounded-2xl p-4 hover:shadow-md transition-shadow flex items-start gap-4 group cursor-pointer">
                <div className={`w-2 h-full rounded-full self-stretch ${getPriorityColor(entry.priority || 'low').replace('text-', 'bg-').replace('bg-', 'bg-opacity-20 ')}`}></div>
                
                <div className="flex-1">
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="text-sm font-bold text-slate-800 line-clamp-1">{entry.title || entry.plan || '无标题任务'}</h3>
                    <span className={`text-[10px] font-black px-2 py-1 rounded-lg uppercase ${getStatusColor(entry.status || 'draft')}`}>
                      {entry.status === 'draft' ? '草稿' : 
                       entry.status === 'submitted' ? '已提交' : 
                       entry.status === 'in-progress' ? '处理中' : 
                       entry.status === 'paused' ? '暂停' : 
                       entry.status === 'terminated' ? '终止' : 
                       entry.status === 'completed' ? '已完成' : '未知'}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-4 text-[10px] font-bold text-slate-500 mb-3">
                    <div className="flex items-center gap-1">
                      <UserIcon size={12} />
                      <span>{owner?.name || 'Unknown'}</span>
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
                    <div className={`px-2 py-0.5 rounded ${getPriorityColor(entry.priority || 'low')}`}>
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
        </div>
      </div>
      </div>

      {/* Notification Toast */}
      {notification && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="bg-slate-800 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border border-slate-700">
            {notification.type === 'success' ? (
              <CheckCircle size={18} className="text-emerald-400" />
            ) : (
              <AlertCircle size={18} className="text-amber-400" />
            )}
            <span className="text-sm font-bold">{notification.message}</span>
          </div>
        </div>
      )}

      <TaskModal
        isOpen={taskModal.isOpen}
        onClose={() => setTaskModal({ ...taskModal, isOpen: false })}
        data={taskModal.data}
        setData={(newData) => setTaskModal({ ...taskModal, data: newData })}
        onSave={saveTask}
        onDelete={deleteTask}
        users={users}
        departments={departments}
        groupedAvailableKRs={groupedAvailableKRs}
        mode={taskModal.mode}
        readOnly={
          taskModal.mode === 'create'
            ? !permissions.create
            : (!permissions.update || !canManageTask(taskModal.data as PADEntry, currentUser, state.systemRoles || []))
        }
        aiSettings={state.aiSettings}
      />
    </div>
  );
};

export default TaskCenterView;
