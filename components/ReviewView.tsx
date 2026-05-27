import React, { useState, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePageToast } from '../hooks/usePageToast';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, Department, ReviewEntry, ObjectiveReview, User, PADEntry, MenuPermission, OKR } from '../types';
import { Calendar, Building2, ClipboardCheck, Save, CheckCircle, Loader2, Target, TrendingUp, MessageSquare, FileText, Lock, Download, RefreshCw } from 'lucide-react';
import PageToast from './PageToast';
import TaskModal from './TaskModal';
import { getUserFacingError } from '../utils/userFacingError';
import { canManageTask, getVisibleDepartments, canViewTask } from '../utils/permissions';
import { isTaskInMonthlyPeriod, isTaskInWeeklyPeriod } from '../utils/taskPeriods.js';
import { readTaskReviewState, updateTaskReviewState } from '../utils/reviewTaskState.js';



const ReviewView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('okr-review');
  const { 
    handleSave, 
    handleSetDepartments: setDepartments, handleSetUsers: setUsers, 
    handleSetSystemRoles: setSystemRoles, handleSetAISettings: setAISettings, 
    handleSetBusinesses: setBusinesses, setProcessData, updateProcessProps, 
    addProcess, deleteProcessFn: deleteProcess, publishProcess, rollbackProcess, 
    handleSetTasks: setTasks, handleSetStrategy: setStrategy,
    persistTaskEntries, persistTaskDeletion
  } = actions;
  const isSaving = state.isSaving;
  const showSaveSuccess = state.showSaveSuccess;
  const isDirty = state.isDirty;
  const setIsDirty = state.setIsDirty;
  const backendError = state.backendError;
  const currentProcessId = state.currentProcessId;
  const setCurrentProcessId = state.setCurrentProcessId;

  const location = useLocation();
  const navigate = useNavigate();
  const { initialTab, initialDeptId, initialPeriod } = (location.state as any) || {};

  const [activeTab, setActiveTab] = useState<'weekly' | 'monthly'>(initialTab || 'monthly');
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(initialDeptId || null);
  
  // Weekly State
  const [selectedWeek, setSelectedWeek] = useState<string>(() => {
    if (initialTab === 'weekly' && initialPeriod) return initialPeriod;
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`;
  });

  // Monthly State
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    if (initialTab === 'monthly' && initialPeriod) return initialPeriod;
    const now = new Date();
    return `${now.getFullYear()}-M${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  });

  const [reviewContent, setReviewContent] = useState('');
  const [reviewScore, setReviewScore] = useState(0);
  const [okrReviews, setOkrReviews] = useState<Record<string, ObjectiveReview>>({});
  const [reviewSubTab, setReviewSubTab] = useState<'tasks' | 'okrs'>('tasks');

  const [taskModal, setTaskModal] = useState<{ isOpen: boolean, weekId: string | null, mode: 'create' | 'edit', data: Partial<PADEntry> }>({ isOpen: false, weekId: null, mode: 'edit', data: {} });
  const { toastState, showToast, clearToast } = usePageToast();

  useEffect(() => {
    clearToast();
  }, [clearToast, activeTab, selectedDeptId, selectedWeek, selectedMonth, reviewSubTab]);

  const updateReviewScore = (score: number) => {
    setReviewScore(score);
    setIsDirty(true);
  };

  const updateReviewContent = (content: string) => {
    setReviewContent(content);
    setIsDirty(true);
  };

  const updateOkrReviews = (reviews: Record<string, ObjectiveReview>) => {
    setOkrReviews(reviews);
    setIsDirty(true);
  };

  const handleDeleteTask = async () => {
    if (!taskModal.data.id) return;
    try {
      const updatedTasks = state.tasks.filter(t => t.id !== taskModal.data.id);
      await persistTaskDeletion(updatedTasks, [taskModal.data.id]);
      showToast('任务已删除', 'info');
      setTaskModal({ ...taskModal, isOpen: false });
    } catch (e: any) {
      showToast(getUserFacingError(e, '删除失败，请稍后重试'), 'error');
    }
  };

  const saveTask = async (status: string, keepOpen: boolean = false) => {
    const task = { ...taskModal.data, status } as PADEntry;
    try {
      const updatedTasks = state.tasks.map(t => t.id === task.id ? task : t);
      await persistTaskEntries(updatedTasks, [task], 'update');
      showToast('任务已保存', 'success');
      if (!keepOpen) {
        setTaskModal({ ...taskModal, isOpen: false });
      }
    } catch (e: any) {
      showToast(getUserFacingError(e, '保存失败，请稍后重试'), 'error');
    }
  };

  const handleTaskClick = (task: PADEntry) => {
    if (!canViewTask(task, currentUser, state.users, state.systemRoles || [])) {
      const owner = state.users.find(u => u.id === task.ownerId);
      showToast(`无任务查看权限，如果需要查看任务，请联系任务创建人【${owner?.name || ''}】`, 'info');
      return;
    }

    // Find the weekId for this task
    const weekId = task.targetWeeks?.[0] || null;
    setTaskModal({
      isOpen: true,
      weekId,
      mode: 'edit',
      data: task
    });
  };

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

  const groupedAvailableKRs = useMemo(() => {
    const groups: { label: string, options: { id: string, name: string }[] }[] = [];
    const year = new Date().getFullYear();
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
  }, [state.strategy, flatDepts]);

  // Load existing review when selection changes
  useEffect(() => {
    if (!selectedDeptId) return;
    const dept = flatDepts.find(d => d.id === selectedDeptId);
    if (!dept) return;

    const periodKey = activeTab === 'weekly' ? selectedWeek : selectedMonth;
    const reviews = dept.reviews?.[periodKey] || [];
    const latestReview = reviews.length > 0 ? reviews[reviews.length - 1] : null;

    if (latestReview) {
      setReviewContent(latestReview.content || '');
      setReviewScore(latestReview.score || 0);
      setOkrReviews(latestReview.okrDetails || {});
    } else {
      setReviewContent('');
      setReviewScore(0);
      setOkrReviews({});
    }
  }, [selectedDeptId, activeTab, selectedWeek, selectedMonth, flatDepts]);

  const submitReview = () => {
    if (!selectedDeptId) return;
    
    const newEntry: ReviewEntry = {
        id: `rev-${Date.now()}`,
        date: Date.now(),
        content: reviewContent,
        score: reviewScore,
        reviewer: 'Admin', // Should be current user name ideally
        okrDetails: okrReviews
    };

    const updateDeptRecursive = (depts: Department[]): Department[] => {
      return depts.map(d => {
        if (d.id === selectedDeptId) {
          const currentReviews = d.reviews || {};
          const periodKey = activeTab === 'weekly' ? selectedWeek : selectedMonth;
          return { ...d, reviews: { ...currentReviews, [periodKey]: [newEntry] } };
        }
        if (d.subDepartments) {
          return { ...d, subDepartments: updateDeptRecursive(d.subDepartments) };
        }
        return d;
      });
    };

    const updatedDepts = updateDeptRecursive(state.departments);
    setDepartments(updatedDepts);
    setIsDirty(true);
  };

  const handleNumberInput = (val: string, setter: (n: number) => void, max: number = 100) => {
    // Remove leading zeros unless the value is just "0"
    // Also prevent negative numbers and cap at max
    let cleaned = val.replace(/^0+(?=\d)/, '');
    if (cleaned === '') cleaned = '0';
    const num = Math.min(max, Math.max(0, Number(cleaned)));
    setter(num);
  };

  // Load tasks automatically when selection changes
  useEffect(() => {
    loadDeptTasks();
  }, [selectedDeptId, selectedWeek, selectedMonth, activeTab]);

  const currentPeriodLabel = activeTab === 'weekly' ? selectedWeek : selectedMonth;

  const [deptTasks, setDeptTasks] = useState<PADEntry[]>([]);

  const loadDeptTasks = () => {
    if (!selectedDeptId) {
      setDeptTasks([]);
      return;
    }
    const tasks: PADEntry[] = [];
    const seen = new Set<string>();
    
    (state.tasks || []).forEach(task => {
      const inPeriod = activeTab === 'weekly'
        ? isTaskInWeeklyPeriod(task.targetWeeks, selectedWeek)
        : isTaskInMonthlyPeriod(task.targetWeeks, selectedMonth);
      
      if (!inPeriod) return;
      if (!canViewTask(task, currentUser, state.users, state.systemRoles || [])) return;
      
      const taskDeptId = task.departmentId || state.users.find(u => u.id === task.ownerId)?.departmentId;
      if (taskDeptId === selectedDeptId && !seen.has(task.id)) {
        seen.add(task.id);
        tasks.push(task);
      }
    });
    
    setDeptTasks(tasks);
  };
  const currentOkrs = useMemo(() => {
    if (!selectedDeptId) return [];
    const dept = flatDepts.find(d => d.id === selectedDeptId);
    if (!dept) return [];
    
    const year = parseInt(currentPeriodLabel.split('-')[0]);
    
    let quarter = 'Q1';
    if (activeTab === 'monthly') {
      const month = parseInt(currentPeriodLabel.split('-M')[1]);
      if (month >= 4 && month <= 6) quarter = 'Q2';
      else if (month >= 7 && month <= 9) quarter = 'Q3';
      else if (month >= 10) quarter = 'Q4';
    } else {
      const week = parseInt(currentPeriodLabel.split('-W')[1]);
      if (week >= 14 && week <= 26) quarter = 'Q2';
      else if (week >= 27 && week <= 39) quarter = 'Q3';
      else if (week >= 40) quarter = 'Q4';
    }

    const okrs: any[] = [];
    if (dept.okrs?.[year]) {
      Object.entries(dept.okrs[year]).forEach(([period, list]: [string, any[]]) => {
        if (period === quarter) {
          (list || []).forEach(o => okrs.push({ ...o, period }));
        }
      });
    }
    return okrs;
  }, [selectedDeptId, currentPeriodLabel, flatDepts, activeTab]);

  return (
    <div className="h-full flex flex-col gap-6 overflow-hidden">
      <div className="bg-white p-6 rounded-[2.5rem] border shadow-sm flex flex-col md:flex-row justify-between items-center shrink-0">
        <div className="flex items-center gap-4">
          {location.state?.from && (
            <button 
              onClick={() => navigate(-1)}
              className="p-3 bg-slate-50 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-2xl transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
          )}
          <div className="p-3 bg-brand-50 text-brand-600 rounded-2xl"><ClipboardCheck size={24}/></div>
          <div>
            <h3 className="text-xl font-black text-slate-800">复盘中心</h3>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">工作复盘中心</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex bg-slate-100 p-1 rounded-2xl">
             <button 
               onClick={() => setActiveTab('weekly')}
               className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === 'weekly' ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500'}`}
             >
               周度复盘
             </button>
             <button 
               onClick={() => setActiveTab('monthly')}
               className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === 'monthly' ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500'}`}
             >
               月度复盘
             </button>
          </div>
          {permissions.create && (
            <button 
              onClick={submitReview} 
              disabled={isSaving} 
              className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase flex items-center gap-2 transition-all shadow-md ${showSaveSuccess ? 'bg-emerald-50 text-emerald-600' : isDirty ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-brand-100' : 'bg-slate-100 text-slate-400 cursor-default'}`}
            >
              {isSaving ? <Loader2 className="animate-spin" size={16}/> : showSaveSuccess ? <CheckCircle size={16}/> : <Save size={16} />} 
              {showSaveSuccess ? '已存档' : isDirty ? '提交复盘' : '已是最新'}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar pb-12">
        <div className="max-w-5xl mx-auto space-y-8 py-6">
          <div className="bg-white p-8 rounded-[3rem] border shadow-sm">
            <div className="flex flex-col md:flex-row gap-6 items-center justify-between mb-8">
               <div className="flex gap-3">
                  <div className="flex items-center bg-slate-50 border rounded-xl px-4 py-2 gap-2">
                    <Building2 size={14} className="text-slate-400"/>
                    <select className="bg-transparent text-xs font-bold outline-none text-slate-600" value={selectedDeptId || ''} onChange={e => setSelectedDeptId(e.target.value)}>
                      <option value="">选择复盘部门...</option>
                      {flatDepts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  
                  {activeTab === 'monthly' ? (
                    <div className="flex items-center bg-slate-50 border rounded-xl px-4 py-2 gap-2">
                      <Calendar size={14} className="text-slate-400"/>
                      <select 
                        className="bg-transparent text-xs font-bold outline-none text-slate-600"
                        value={selectedMonth.split('-')[0]}
                        onChange={e => setSelectedMonth(`${e.target.value}-M${selectedMonth.split('-M')[1]}`)}
                      >
                        {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}年</option>)}
                      </select>
                      <span className="text-slate-300">/</span>
                      <select 
                        className="bg-transparent text-xs font-bold outline-none text-slate-600"
                        value={parseInt(selectedMonth.split('-M')[1])}
                        onChange={e => setSelectedMonth(`${selectedMonth.split('-')[0]}-M${e.target.value.toString().padStart(2, '0')}`)}
                      >
                        {Array.from({length: 12}, (_, i) => i + 1).map(m => (
                          <option key={m} value={m}>{m}月</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="flex items-center bg-slate-50 border rounded-xl px-4 py-2 gap-2">
                      <Calendar size={14} className="text-slate-400"/>
                      <input 
                        type="week"
                        className="bg-transparent text-xs font-bold outline-none text-slate-600"
                        value={selectedWeek}
                        onChange={e => setSelectedWeek(e.target.value)}
                      />
                    </div>
                  )}
               </div>
            </div>

            {selectedDeptId ? (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
                 {/* Overall Review */}
                 <div className="space-y-4">
                    <div className="flex justify-between items-center">
                       <div className="flex items-center gap-4">
                         <h4 className="text-sm font-black text-slate-700 uppercase tracking-widest flex items-center gap-2"><Target size={16}/> 整体复盘总结</h4>
                       </div>
                       <div className="flex items-center gap-2 bg-slate-50 px-3 py-1 rounded-xl border">
                          <span className="text-[10px] font-black text-slate-400 uppercase">综合评分</span>
                          <input 
                            type="number" 
                            min="0" max="100" 
                            className="w-12 bg-transparent text-sm font-black text-brand-600 outline-none text-right"
                            value={reviewScore}
                            onChange={e => handleNumberInput(e.target.value, updateReviewScore, 100)}
                            onFocus={e => e.target.select()}
                          />
                          <span className="text-xs font-bold text-slate-300">/ 100</span>
                       </div>
                    </div>
                    <textarea 
                      className="w-full h-40 p-6 bg-slate-50 border border-slate-100 rounded-[2rem] text-sm font-bold text-slate-700 outline-none focus:border-brand-300 focus:bg-white transition-all resize-none leading-relaxed"
                      placeholder="输入本周期整体复盘总结..."
                      value={reviewContent}
                      onChange={e => updateReviewContent(e.target.value)}
                    />
                 </div>

                 {/* OKR & Task Specific Review */}
                 <div className="space-y-6">
                    <div className="flex items-center justify-between border-b border-slate-200">
                      <div className="flex items-center gap-4">
                        <button
                          className={`pb-2 text-sm font-black uppercase tracking-widest transition-colors ${reviewSubTab === 'tasks' ? 'text-brand-600 border-b-2 border-brand-600' : 'text-slate-400 hover:text-slate-600'}`}
                          onClick={() => setReviewSubTab('tasks')}
                        >
                          任务复盘
                        </button>
                        <button
                          className={`pb-2 text-sm font-black uppercase tracking-widest transition-colors ${reviewSubTab === 'okrs' ? 'text-brand-600 border-b-2 border-brand-600' : 'text-slate-400 hover:text-slate-600'}`}
                          onClick={() => setReviewSubTab('okrs')}
                        >
                          季度OKR复盘
                        </button>
                      </div>
                    </div>

                    {reviewSubTab === 'tasks' && (
                      <div className="space-y-4">
                        <div className="flex justify-end gap-2 mb-2">
                          <button
                            onClick={loadDeptTasks}
                            className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors flex items-center gap-1"
                          >
                            <RefreshCw size={14} />
                            读取任务
                          </button>
                          <button
                            onClick={() => {
                              const statusMap: Record<string, string> = {
                                'draft': '草稿',
                                'submitted': '已提交',
                                'in-progress': '进行中',
                                'paused': '已暂停',
                                'terminated': '已终止',
                                'completed': '已完成'
                              };
                              const formatDate = (ts: number) => {
                                const d = new Date(ts);
                                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                              };
                              const taskSummary = deptTasks.length > 0 
                                ? deptTasks.map(t => `- ${t.title} [${statusMap[t.status] || t.status}] (${formatDate(t.startDate)} 至 ${formatDate(t.dueDate)})`).join('\n')
                                : '暂无关联任务';
                              const prefix = reviewContent ? reviewContent + '\n\n' : '';
                              updateReviewContent(`${prefix}本期任务汇总：\n${taskSummary}`);
                              showToast('已将任务读取到总结中', 'success');
                            }}
                            className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-bold hover:bg-indigo-100 transition-colors flex items-center gap-1"
                          >
                            <Download size={14} />
                            读取任务到总结
                          </button>
                        </div>
                        {deptTasks.length === 0 ? (
                          <div className="text-center py-8 text-slate-400 text-sm italic font-medium">暂无关联任务</div>
                        ) : (
                          deptTasks.map(task => {
                            const {
                              evaluation,
                              score,
                            } = readTaskReviewState(okrReviews, task);
                            const owner = state.users.find(u => u.id === task.ownerId);

                            return (
                              <div key={task.id} className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
                                <div className="flex items-center justify-between mb-4">
                                  <div className="flex items-center gap-3 cursor-pointer hover:opacity-80" onClick={() => handleTaskClick(task)}>
                                    <span className="text-sm font-bold text-indigo-600 hover:underline">{task.title}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-black ${
                                      task.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                                      task.status === 'in-progress' ? 'bg-blue-100 text-blue-700' :
                                      task.status === 'paused' ? 'bg-orange-100 text-orange-700' :
                                      task.status === 'terminated' ? 'bg-red-100 text-red-700' :
                                      'bg-slate-200 text-slate-700'
                                    }`}>
                                      {task.status === 'completed' ? '已完成' :
                                       task.status === 'in-progress' ? '处理中' :
                                       task.status === 'paused' ? '暂停' :
                                       task.status === 'terminated' ? '终止' :
                                       task.status === 'submitted' ? '已提交' : '草稿'}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <div className="text-xs text-slate-500 font-medium">
                                      {task.startDate ? new Date(task.startDate).toLocaleDateString() : '-'} 至 {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '-'}
                                    </div>
                                    {owner && (
                                      <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-full border border-slate-100">
                                        <div className="w-5 h-5 rounded-full bg-brand-100 flex items-center justify-center text-[10px] font-black text-brand-600">
                                          {owner.name.charAt(0)}
                                        </div>
                                        <span className="text-[10px] font-bold text-slate-600">{owner.name}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                                
                                <div className="flex gap-4 items-center">
                                  <div className="flex-1">
                                    <input 
                                      type="text"
                                      placeholder="输入对该任务的评价..."
                                      className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-2.5 text-xs font-medium text-slate-700 outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all"
                                      value={evaluation}
                                      onChange={e => {
                                        updateOkrReviews(
                                          updateTaskReviewState(okrReviews, task, {
                                            evaluation: e.target.value,
                                          })
                                        );
                                      }}
                                    />
                                  </div>
                                  <div className="w-32 flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-xl border border-slate-100">
                                    <span className="text-[10px] font-black text-slate-400 uppercase">评分</span>
                                    <input 
                                      type="number"
                                      min="0" max="100"
                                      className="w-full bg-transparent text-sm font-black text-brand-600 outline-none text-right"
                                      value={score}
                                      onChange={e => handleNumberInput(e.target.value, (val) => {
                                        updateOkrReviews(
                                          updateTaskReviewState(okrReviews, task, {
                                            score: val,
                                          })
                                        );
                                      }, 100)}
                                      onFocus={e => e.target.select()}
                                    />
                                    <span className="text-[10px] font-black text-slate-400">/ 100</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}

                    {reviewSubTab === 'okrs' && (
                      <div className="space-y-6">
                        {currentOkrs.map((okr: any) => {
                      const currentReview = okrReviews[okr.id] || { progress: 0, krReviews: [], lessonsLearned: '', methodology: '', nextSteps: '' };
                      
                      return (
                      <div key={okr.id} className="bg-slate-50/50 rounded-[2.5rem] p-8 border border-slate-100">
                         <div className="flex items-center gap-3 mb-6">
                            <span className="bg-white border text-slate-500 text-[10px] font-black px-2 py-1 rounded uppercase">{okr.period}</span>
                            <h5 className="font-bold text-slate-800 flex-1">{okr.objective}</h5>
                            <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-xl border">
                               <span className="text-[10px] font-black text-slate-400 uppercase">进度</span>
                               <input 
                                 type="number" 
                                 min="0" max="100" 
                                 className="w-12 bg-transparent text-sm font-black text-brand-600 outline-none text-right"
                                 value={currentReview.progress || 0}
                                 onChange={e => handleNumberInput(e.target.value, (val) => updateOkrReviews({ 
                                   ...okrReviews, 
                                   [okr.id]: { ...currentReview, progress: val } 
                                 }))}
                                 onFocus={e => e.target.select()}
                               />
                               <span className="text-xs font-bold text-slate-300">%</span>
                            </div>
                         </div>

                         {/* KR Reviews */}
                         <div className="space-y-4 mb-6">
                           {okr.keyResults.map((kr: string, idx: number) => {
                             const krReview = currentReview.krReviews?.[idx] || { comment: '', progress: 0, status: 'on-track' };
                             const krId = `${okr.id}-kr-${idx}`;
                             return (
                               <div key={idx} className="bg-white p-4 rounded-xl border border-slate-100">
                                 <div className="flex justify-between items-start mb-2">
                                   <p className="text-xs font-bold text-slate-600 mb-2 flex-1 mr-4">{kr}</p>
                                   <select 
                                     className={`text-[10px] font-black uppercase px-2 py-1 rounded border outline-none ${
                                       krReview.status === 'at-risk' ? 'bg-red-50 text-red-600 border-red-100' :
                                       krReview.status === 'behind' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                                       'bg-emerald-50 text-emerald-600 border-emerald-100'
                                     }`}
                                     value={krReview.status || 'on-track'}
                                     onChange={e => {
                                       const newKrReviews = [...(currentReview.krReviews || [])];
                                       while(newKrReviews.length <= idx) newKrReviews.push({ comment: '', progress: 0, status: 'on-track' });
                                       newKrReviews[idx] = { ...newKrReviews[idx], status: e.target.value as any };
                                       updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, krReviews: newKrReviews } });
                                     }}
                                   >
                                     <option value="on-track">正常推进</option>
                                     <option value="at-risk">有风险</option>
                                     <option value="behind">滞后</option>
                                   </select>
                                 </div>
                                 <div className="flex gap-4 items-center">
                                    <div className="flex-1">
                                      <input 
                                        type="text"
                                        placeholder="输入 KR 执行情况..."
                                        className="w-full bg-slate-50 border-none rounded-lg px-3 py-2 text-xs font-medium text-slate-600 outline-none focus:ring-1 focus:ring-brand-200"
                                        value={krReview.comment || ''}
                                        onChange={e => {
                                          const newKrReviews = [...(currentReview.krReviews || [])];
                                          while(newKrReviews.length <= idx) newKrReviews.push({ comment: '', progress: 0, status: 'on-track' });
                                          newKrReviews[idx] = { ...newKrReviews[idx], comment: e.target.value };
                                          updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, krReviews: newKrReviews } });
                                        }}
                                      />
                                    </div>
                                    <div className="w-24 flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-lg">
                                      <span className="text-[10px] text-slate-400">进度</span>
                                      <input 
                                        type="number"
                                        min="0" max="100"
                                        className="w-full bg-transparent text-xs font-bold text-slate-600 outline-none text-right"
                                        value={krReview.progress || 0}
                                        onChange={e => handleNumberInput(e.target.value, (val) => {
                                          const newKrReviews = [...(currentReview.krReviews || [])];
                                          while(newKrReviews.length <= idx) newKrReviews.push({ comment: '', progress: 0, status: 'on-track' });
                                          newKrReviews[idx] = { ...newKrReviews[idx], progress: val };
                                          updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, krReviews: newKrReviews } });
                                        })}
                                        onFocus={e => e.target.select()}
                                      />
                                      <span className="text-[10px] text-slate-400">%</span>
                                    </div>
                                  </div>
                               </div>
                             );
                           })}
                         </div>
                         
                         <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div className="space-y-2">
                               <label className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-1"><MessageSquare size={12}/> 经验教训</label>
                               <textarea 
                                 className="w-full h-24 p-4 bg-white border border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-brand-300 resize-none"
                                 value={currentReview.lessonsLearned || ''}
                                 onChange={e => updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, lessonsLearned: e.target.value } })}
                               />
                            </div>
                            <div className="space-y-2">
                               <label className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-1"><FileText size={12}/> 方法论沉淀</label>
                               <textarea 
                                 className="w-full h-24 p-4 bg-white border border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-brand-300 resize-none"
                                 value={currentReview.methodology || ''}
                                 onChange={e => updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, methodology: e.target.value } })}
                               />
                            </div>
                            <div className="space-y-2">
                               <label className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-1"><TrendingUp size={12}/> 下一步计划</label>
                               <textarea 
                                 className="w-full h-24 p-4 bg-white border border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-brand-300 resize-none"
                                 value={currentReview.nextSteps || ''}
                                 onChange={e => updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, nextSteps: e.target.value } })}
                               />
                            </div>
                         </div>
                      </div>
                      );
                    })}
                    {currentOkrs.length === 0 && (
                      <div className="text-center py-10 text-slate-400 italic">该部门在所选周期内暂无 OKR 数据</div>
                    )}
                 </div>
                 )}
                 </div>

                 <div className="flex items-center gap-4 pt-6 border-t border-slate-100">
                    {showSaveSuccess && (
                      <div className="flex-1 flex items-center gap-2 text-emerald-600 font-bold text-xs animate-in fade-in slide-in-from-left-2">
                        <CheckCircle size={16}/>
                        复盘报告已提交并保存成功
                      </div>
                    )}
                 </div>
              </div>
            ) : (
              <div className="text-center py-20 text-slate-400 flex flex-col items-center gap-4">
                 <Building2 size={48} className="opacity-20"/>
                 <p className="font-bold">请选择一个部门开始复盘</p>
              </div>
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

      {/* Task Modal (Read Only) */}
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
        readOnly={!canManageTask(taskModal.data as PADEntry, currentUser, state.systemRoles || [], state.departments)}
      />
    </div>
  );
};

export default ReviewView;
