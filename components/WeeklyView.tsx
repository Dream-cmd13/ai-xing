
import React, { useState, useMemo, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, WeeklyPAD, PADEntry, Department, User, OKR, TaskLog, MenuPermission } from '../types';
import PageToast from './PageToast';
import TaskModal from './TaskModal';
import { 
  Calendar as CalendarIcon, Plus, Trash2, Loader2, 
  Building2, ChevronDown, Link2, User as UserIcon, 
  ChevronLeft, ChevronRight, LayoutGrid, Target, Clock, WifiOff, List, X, Lock, MessageSquare, Edit2
} from 'lucide-react';
import { usePageToast } from '../hooks/usePageToast';
import { getUserFacingError } from '../utils/userFacingError';
import { canManageTask, getVisibleDepartments, canViewTask } from '../utils/permissions';
import { ensureTaskTargetWeeks } from '../utils/taskPeriods.js';



const WeeklyView: React.FC = () => {
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

  // State
  const [selectedWeek, setSelectedWeek] = useState<string>(() => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`;
  });
  const [activeTab, setActiveTab] = useState<'user'>('user');
  const [selectedOwnerId, setSelectedOwnerId] = useState<string>(currentUser.id);
  const [viewMode, setViewMode] = useState<'pad' | 'review'>('pad');
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState<number | null>(null);

  // Derived State
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
  const { toastState, showToast, clearToast } = usePageToast();

  useEffect(() => {
    clearToast();
  }, [clearToast, selectedWeek, selectedOwnerId, activeTab, viewMode]);

  const currentTasks = useMemo(() => {
    return state.tasks.filter(t => t.ownerId === selectedOwnerId && t.targetWeeks?.includes(selectedWeek));
  }, [state.tasks, selectedOwnerId, selectedWeek]);

  const groupedAvailableKRs = useMemo(() => {
    const groups: { label: string, options: { id: string, name: string }[] }[] = [];
    
    // Company OKRs
    const companyOkrs = state.strategy.companyOKRs[parseInt(selectedWeek.split('-')[0])] || [];
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
      const year = parseInt(selectedWeek.split('-')[0]);
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
  }, [state.strategy.companyOKRs, flatDepts, selectedWeek]);

  const confirmDeleteEntry = async () => {
    if (deleteConfirmIndex === null) return;
    const taskToDelete = currentTasks[deleteConfirmIndex];
    if (taskToDelete) {
      const newTasks = state.tasks.filter(t => t.id !== taskToDelete.id);
      try {
        await persistTaskDeletion(newTasks, [taskToDelete.id]);
        showToast('任务已删除');
      } catch (error: any) {
        showToast(getUserFacingError(error, '任务删除失败，请稍后重试'), 'error');
      }
    }
    setDeleteConfirmIndex(null);
  };

  const [taskModal, setTaskModal] = useState<{ isOpen: boolean, index: number | null, mode: 'create' | 'edit', data: Partial<PADEntry> }>({ isOpen: false, index: null, mode: 'create', data: {} });

  const handleAddTask = () => {
    setTaskModal({ 
      isOpen: true, 
      index: null, 
      mode: 'create',
      data: { 
        id: `task-${Date.now()}`,
        title: '', 
        status: 'draft',
        priority: 'medium',
        ownerId: selectedOwnerId,
        departmentId: state.users.find(u => u.id === selectedOwnerId)?.departmentId || currentUser.departmentId,
        visibility: 'public',
        targetWeeks: [selectedWeek],
        startDate: Date.now(),
        dueDate: Date.now() + 86400000,
        tags: [],
        participantIds: [],
        approverIds: []
      } 
    });
  };

  const editTask = (index: number) => {
    if (currentTasks[index]) {
      const task = currentTasks[index];
      setTaskModal({ 
        isOpen: true, 
        index, 
        mode: 'edit',
        data: { ...task } 
      });
    }
  };

  const deleteTask = async (index: number) => {
    if (currentTasks[index]) {
      const taskToDelete = currentTasks[index];
      const newTasks = state.tasks.filter(t => t.id !== taskToDelete.id);
      try {
        await persistTaskDeletion(newTasks, [taskToDelete.id]);
        setDeleteConfirmIndex(null);
        showToast('任务已从您的计划中移除');
      } catch (error: any) {
        showToast(getUserFacingError(error, '任务删除失败，请稍后重试'), 'error');
      }
    }
  };

  const handleDeleteTask = async () => {
    if (taskModal.index !== null && currentTasks[taskModal.index]) {
      const taskToDelete = currentTasks[taskModal.index];
      const newTasks = state.tasks.filter(t => t.id !== taskToDelete.id);
      try {
        await persistTaskDeletion(newTasks, [taskToDelete.id]);
        showToast('任务已删除', 'info');
      } catch (error: any) {
        showToast(getUserFacingError(error, '任务删除失败，请稍后重试'), 'error');
        return;
      }
    }
    setTaskModal({ ...taskModal, isOpen: false });
  };

  const saveTask = async (status: string = 'draft', keepOpen: boolean = false) => {
    const newData = ensureTaskTargetWeeks(
      { ...taskModal.data, status } as PADEntry,
      selectedWeek
    ) as PADEntry;
    
    if (taskModal.index !== null) {
      const oldTask = currentTasks[taskModal.index];
      if (oldTask) {
        const loggableStatuses = ['submitted', 'in-progress', 'paused', 'terminated', 'completed'];
        if (loggableStatuses.includes(oldTask.status)) {
          const changes = [];
          if (oldTask.title !== newData.title) changes.push('标题');
          if (oldTask.status !== newData.status) changes.push(`状态(${oldTask.status}->${newData.status})`);
          if (oldTask.priority !== newData.priority) changes.push('优先级');
          if (oldTask.startDate !== newData.startDate || oldTask.dueDate !== newData.dueDate) changes.push('时间');
          if (oldTask.ownerId !== newData.ownerId) changes.push('负责人');
          if (oldTask.visibility !== newData.visibility) changes.push('可见性');
          
          if (changes.length > 0) {
            const log: TaskLog = {
              id: `log-${Date.now()}`,
              timestamp: Date.now(),
              userId: currentUser.id,
              action: '修改任务',
              details: `修改了: ${changes.join(', ')}`
            };
            newData.logs = [...(oldTask.logs || []), log];
          } else {
            newData.logs = oldTask.logs || [];
          }
        } else {
          newData.logs = oldTask.logs || [];
        }
      }
    }
    
    // Prepare entries to add (handle multi-line title for new tasks)
    const entriesToAdd: PADEntry[] = [];
    if (taskModal.index === null && newData.title.includes('\n')) {
      const titles = newData.title.split('\n').filter(t => t.trim());
      titles.forEach((t, i) => {
         entriesToAdd.push({ ...newData, id: `task-${Date.now()}-${i}`, title: t.trim() });
      });
    } else {
      entriesToAdd.push(newData);
    }
    
    let nextTasks = [...state.tasks];
    if (taskModal.index !== null) {
      nextTasks = nextTasks.map(t => t.id === newData.id ? newData : t);
    } else {
      nextTasks = [...nextTasks, ...entriesToAdd];
    }

    try {
      await persistTaskEntries(nextTasks, entriesToAdd, taskModal.index !== null ? 'update' : 'create');
      showToast('任务已成功保存');
    } catch (error: any) {
      showToast(getUserFacingError(error, '任务保存失败，请稍后重试'), 'error');
      return;
    }

    if (keepOpen) {
      setTaskModal({ 
        isOpen: true, 
        index: null, 
        data: { 
          id: `task-${Date.now()}`,
          title: '', 
          status: 'draft',
          priority: 'medium',
          ownerId: selectedOwnerId,
          departmentId: state.users.find(u => u.id === selectedOwnerId)?.departmentId || currentUser.departmentId,
          visibility: 'public',
          targetWeeks: [selectedWeek],
          startDate: Date.now(),
          dueDate: Date.now() + 86400000,
          tags: [],
          participantIds: [],
          approverIds: []
        } 
      });
    } else {
      setTaskModal({ isOpen: false, index: null, data: {} });
    }
  };



  const renderDeptTree = (depts: Department[], depth = 0) => {
    return depts.map(d => (
      <div key={d.id} className="mb-1">
        <div 
          onClick={() => {
            if (activeTab === 'dept') setSelectedOwnerId(d.id);
          }}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition-colors ${activeTab === 'dept' && selectedOwnerId === d.id ? 'bg-brand-50 text-brand-600 font-bold' : 'text-slate-600 hover:bg-slate-50'}`}
          style={{ paddingLeft: `${depth * 12 + 12}px` }}
        >
          <Building2 size={14} className={activeTab === 'dept' && selectedOwnerId === d.id ? 'text-brand-600' : 'text-slate-400'}/>
          <span className="text-xs truncate">{d.name}</span>
        </div>
        {d.subDepartments && renderDeptTree(d.subDepartments, depth + 1)}
      </div>
    ));
  };

  const usersByDept = useMemo(() => {
    const map: Record<string, User[]> = {};
    state.users.forEach(u => {
      if (u.departmentId) {
        if (!map[u.departmentId]) map[u.departmentId] = [];
        map[u.departmentId].push(u);
      }
    });
    return map;
  }, [state.users]);

  const renderDeptUserTree = (depts: Department[], depth = 0) => {
    return depts.map(d => {
      const deptUsers = usersByDept[d.id] || [];
      const hasChildren = (d.subDepartments && d.subDepartments.length > 0) || deptUsers.length > 0;
      if (!hasChildren) return null;

      return (
        <div key={d.id} className="mb-1">
          <div 
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-slate-800 font-bold"
            style={{ paddingLeft: `${depth * 12 + 12}px` }}
          >
            <Building2 size={14} className="text-slate-400"/>
            <span className="text-xs truncate">{d.name}</span>
          </div>
          {deptUsers.map(u => (
            <div 
              key={u.id}
              onClick={() => {
                if (activeTab === 'user') setSelectedOwnerId(u.id);
              }}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition-colors ${activeTab === 'user' && selectedOwnerId === u.id ? 'bg-brand-50 text-brand-600 font-bold' : 'text-slate-600 hover:bg-slate-50'}`}
              style={{ paddingLeft: `${(depth + 1) * 12 + 12}px` }}
            >
              <div className={`w-5 h-5 rounded-lg flex items-center justify-center text-[10px] font-black ${activeTab === 'user' && selectedOwnerId === u.id ? 'bg-brand-200 text-brand-700' : 'bg-slate-100 text-slate-400'}`}>
                {u.name.charAt(0)}
              </div>
              <span className="text-xs truncate">{u.name}</span>
            </div>
          ))}
          {d.subDepartments && renderDeptUserTree(d.subDepartments, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="h-full flex flex-col gap-4 md:gap-6 overflow-y-auto md:overflow-hidden p-4 md:p-6 bg-slate-50 relative">
      <div className="bg-white p-4 md:p-6 rounded-[2.5rem] border shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div className="flex items-center gap-4 md:gap-6">
          <div className="w-12 h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 shadow-inner shrink-0">
            <CalendarIcon />
          </div>
          <div>
            <h2 className="text-xl font-black text-slate-800 tracking-tighter">个人计划</h2>
            <p className="text-[10px] font-black text-slate-400 uppercase mt-0.5">个人计划看板</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 w-full md:w-auto">
          {/* Removed Dept/User Switcher as requested */}

          <div className="flex items-center gap-2 bg-slate-50 px-4 py-2 rounded-xl border border-slate-200 flex-1 md:flex-none justify-center">
            <button onClick={() => {
              const [y, w] = selectedWeek.split('-W');
              let year = parseInt(y);
              let week = parseInt(w) - 1;
              if (week < 1) { year--; week = 52; }
              setSelectedWeek(`${year}-W${week.toString().padStart(2, '0')}`);
            }} className="p-1 hover:bg-slate-200 rounded-lg transition-colors">
              <ChevronLeft size={16} className="text-slate-400" />
            </button>
            <span className="text-xs font-black text-slate-600 w-24 text-center">{selectedWeek}</span>
            <button onClick={() => {
              const [y, w] = selectedWeek.split('-W');
              let year = parseInt(y);
              let week = parseInt(w) + 1;
              if (week > 52) { year++; week = 1; }
              setSelectedWeek(`${year}-W${week.toString().padStart(2, '0')}`);
            }} className="p-1 hover:bg-slate-200 rounded-lg transition-colors">
              <ChevronRight size={16} className="text-slate-400" />
            </button>
          </div>

        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row gap-6 overflow-visible md:overflow-hidden">
        <div className="w-full md:w-64 bg-white border rounded-[2.5rem] p-6 flex flex-col shadow-sm shrink-0">
          <div className="mb-6">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">
              成员列表
            </h3>
            <div className="space-y-1 overflow-y-auto custom-scrollbar max-h-64 md:max-h-[calc(100vh-300px)]">
              {renderDeptUserTree(visibleDepartments)}
            </div>
          </div>
        </div>

      <div className="flex-1 bg-white border rounded-[2.5rem] flex flex-col overflow-visible md:overflow-hidden shadow-sm relative">
          {currentTasks.length === 0 && (
            <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
              <Lock className="text-slate-300 mb-4" size={48} />
              <p className="text-slate-500 font-bold">该周暂无计划</p>
              <button 
                onClick={handleAddTask}
                className="mt-4 px-6 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
              >
                创建计划
              </button>
            </div>
          )}

          <div className="p-4 md:p-8 border-b bg-slate-50/50 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
             <div className="flex items-center gap-4">
               <div className="p-3 bg-brand-50 text-brand-600 rounded-2xl"><Target size={24}/></div>
               <div>
                  <h3 className="text-xl md:text-2xl font-black">{state.users.find(u => u.id === selectedOwnerId)?.name || '未知用户'}</h3>
                  <p className="text-[10px] font-black text-slate-400 uppercase mt-1">
                    归属治理：<span className="text-brand-600">个人岗位指标</span>
                  </p>
               </div>
             </div>
             <div className="flex items-center gap-3 w-full md:w-auto">
               {permissions.create && selectedOwnerId === currentUser.id && (
                 <button onClick={handleAddTask} className="w-full md:w-auto px-6 py-3 bg-slate-900 text-white rounded-2xl text-xs font-black uppercase shadow-xl hover:bg-brand-600 transition-all flex items-center justify-center gap-2"><Plus size={16}/> 新增任务项</button>
               )}
             </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4 custom-scrollbar bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:24px_24px]">
              {(() => {
                const visibleEntries = currentTasks.map((entry, idx) => ({ entry, idx })).filter(({ entry }) => {
                  return canViewTask(entry, currentUser, state.users, state.systemRoles || []);
                });

                if (visibleEntries.length === 0) {
                  return <div className="h-full flex flex-col items-center justify-center text-slate-300 italic py-20"><Target size={48} className="mb-4 opacity-10"/><p className="text-sm font-bold uppercase tracking-widest">本周暂无治理条目</p></div>;
                }

                return visibleEntries.map(({ entry, idx }) => (
                    <div key={idx} onClick={() => editTask(idx)} className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md hover:border-brand-200 transition-all cursor-pointer group relative">
                       <div className="flex justify-between items-start mb-4">
                          <div>
                            <h4 className="text-sm font-bold text-slate-800 mb-2 line-clamp-2">{entry.title || entry.plan || '无标题任务'}</h4>
                            <div className="flex items-center gap-2">
                               <span className={`text-[9px] font-black px-2 py-0.5 rounded uppercase ${
                                 entry.status === 'submitted' ? 'bg-blue-50 text-blue-600' : 
                                 entry.status === 'in-progress' ? 'bg-indigo-50 text-indigo-600' :
                                 entry.status === 'paused' ? 'bg-amber-50 text-amber-600' :
                                 entry.status === 'terminated' ? 'bg-red-50 text-red-600' :
                                 entry.status === 'completed' ? 'bg-emerald-50 text-emerald-600' :
                                 'bg-slate-100 text-slate-500'
                               }`}>
                                 {entry.status === 'submitted' ? '已提交' : 
                                  entry.status === 'in-progress' ? '处理中' :
                                  entry.status === 'paused' ? '暂停' :
                                  entry.status === 'terminated' ? '终止' :
                                  entry.status === 'completed' ? '已完成' : '草稿'}
                               </span>
                               <span className={`text-[9px] font-black px-2 py-0.5 rounded uppercase ${entry.priority === 'high' ? 'bg-red-50 text-red-600' : entry.priority === 'medium' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                                 {entry.priority === 'high' ? '高优先级' : entry.priority === 'medium' ? '中优先级' : '低优先级'}
                               </span>
                            </div>
                          </div>
                          {permissions.update && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); setDeleteConfirmIndex(idx); }}
                              className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 size={16}/>
                            </button>
                          )}
                       </div>
                       
                       <div className="flex items-center gap-4 text-[10px] font-bold text-slate-400">
                          <div className="flex items-center gap-1"><UserIcon size={12}/> {state.users.find(u => u.id === entry.ownerId)?.name || '未知用户'}</div>
                          {entry.dueDate && <div className="flex items-center gap-1"><Clock size={12}/> {new Date(entry.dueDate).toLocaleDateString()}</div>}
                          {entry.alignedKrId && <div className="flex items-center gap-1 text-brand-600"><Link2 size={12}/> 已对齐 KR</div>}
                       </div>
                    </div>
                  ));
              })()}
          </div>
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
            ? !permissions.create
            : (!permissions.update || !canManageTask(taskModal.data as PADEntry, currentUser, state.systemRoles || [], state.departments))
        }
        aiSettings={state.aiSettings}
      />

      {/* Delete Confirmation Modal */}
      {deleteConfirmIndex !== null && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-6 animate-in fade-in duration-200">
          {/* ... (existing delete modal content) */}
          <div className="bg-white p-8 rounded-[2.5rem] shadow-2xl max-w-sm w-full animate-in zoom-in-95 duration-200">
             <div className="w-16 h-16 bg-red-50 text-red-500 rounded-3xl flex items-center justify-center mb-6 mx-auto">
               <Trash2 size={32}/>
             </div>
             <div className="text-center mb-8">
               <h3 className="text-xl font-black text-slate-800 mb-2">确认删除此任务？</h3>
               <p className="text-xs text-slate-500 font-bold leading-relaxed">此操作将永久移除该治理条目且无法撤销。<br/>请确认是否继续。</p>
             </div>
             <div className="flex gap-4">
               <button onClick={() => setDeleteConfirmIndex(null)} className="flex-1 py-4 bg-slate-100 text-slate-600 rounded-2xl text-xs font-black uppercase hover:bg-slate-200 transition-colors">取消</button>
               <button onClick={confirmDeleteEntry} className="flex-1 py-4 bg-red-500 text-white rounded-2xl text-xs font-black uppercase hover:bg-red-600 transition-colors shadow-xl shadow-red-200">确认删除</button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WeeklyView;
