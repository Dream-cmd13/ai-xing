import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, Department, User } from '../types';
import { Building2, Calendar, Target, ChevronRight, Plus, FileText } from 'lucide-react';
import { getVisibleDepartments } from '../utils/permissions';



const OkrReviewDashboard: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('okr-review');
  const navigate = useNavigate();

  const navigateToReview = (tab: 'weekly' | 'monthly' | 'quarterly', deptId: string, period?: string) => {
    navigate('/review', {
      state: {
        initialTab: tab,
        initialDeptId: deptId,
        initialPeriod: period,
        from: '/okr-review'
      }
    });
  };
  const { 
    handleSave, 
    handleSetDepartments: setDepartments, handleSetUsers: setUsers, 
    handleSetSystemRoles: setSystemRoles, handleSetAISettings: setAISettings, 
    handleSetBusinesses: setBusinesses, setProcessData, updateProcessProps, 
    addProcess, deleteProcessFn: deleteProcess, publishProcess, rollbackProcess, 
    handleSetTasks: setTasks, handleSetStrategy: setStrategy 
  } = actions;
  const isSaving = state.isSaving;
  const showSaveSuccess = state.showSaveSuccess;
  const isDirty = state.isDirty;
  const setIsDirty = state.setIsDirty;
  const backendError = state.backendError;
  const currentProcessId = state.currentProcessId;
  const setCurrentProcessId = state.setCurrentProcessId;

  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [visibleWeeksCount, setVisibleWeeksCount] = useState(6);
  const [visibleMonthsCount, setVisibleMonthsCount] = useState(6);
  const [visibleQuartersCount, setVisibleQuartersCount] = useState(6);

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

  const selectedDept = useMemo(() => {
    return flatDepts.find(d => d.id === selectedDeptId) || flatDepts[0];
  }, [flatDepts, selectedDeptId]);

  const renderDeptTree = (depts: Department[], depth = 0) => {
    return depts.map(d => (
      <div key={d.id} className="mb-1">
        <div 
          onClick={() => setSelectedDeptId(d.id)}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition-colors ${selectedDept?.id === d.id ? 'bg-brand-50 text-brand-600 font-bold' : 'text-slate-600 hover:bg-slate-50'}`}
          style={{ paddingLeft: `${depth * 12 + 12}px` }}
        >
          <Building2 size={14} className={selectedDept?.id === d.id ? 'text-brand-600' : 'text-slate-400'}/>
          <span className="text-xs truncate">{d.name}</span>
        </div>
        {d.subDepartments && renderDeptTree(d.subDepartments, depth + 1)}
      </div>
    ));
  };

  const getRecentPeriods = (type: 'weekly' | 'monthly' | 'quarterly', count = 6) => {
    const periods: string[] = [];
    const now = new Date();
    if (type === 'weekly') {
      let year = now.getFullYear();
      let week = Math.ceil((((now.getTime() - new Date(year, 0, 1).getTime()) / 86400000) + new Date(year, 0, 1).getDay() + 1) / 7);
      for (let i = 0; i < count; i++) {
        periods.push(`${year}-W${week.toString().padStart(2, '0')}`);
        week--;
        if (week <= 0) {
          year--;
          week = 52;
        }
      }
    } else if (type === 'monthly') {
      let year = now.getFullYear();
      let month = now.getMonth() + 1;
      for (let i = 0; i < count; i++) {
        periods.push(`${year}-M${month.toString().padStart(2, '0')}`);
        month--;
        if (month <= 0) {
          month = 12;
          year--;
        }
      }
    } else {
      let year = now.getFullYear();
      let quarter = Math.floor(now.getMonth() / 3) + 1;
      for (let i = 0; i < count; i++) {
        periods.push(`${year}-Q${quarter}`);
        quarter--;
        if (quarter <= 0) {
          quarter = 4;
          year--;
        }
      }
    }
    return periods;
  };

  const recentWeeks = getRecentPeriods('weekly', visibleWeeksCount);
  const recentMonths = getRecentPeriods('monthly', visibleMonthsCount);
  const recentQuarters = getRecentPeriods('quarterly', visibleQuartersCount);

  return (
    <div className="h-full flex flex-col bg-slate-50">
      <div className="p-6 border-b border-slate-200 bg-white flex justify-between items-center shrink-0">
        <div>
          <h2 className="text-2xl font-black text-slate-800 tracking-tight flex items-center gap-2">
            <Target className="text-brand-600" />
            OKR 复盘
          </h2>
          <p className="text-sm text-slate-500 mt-1">查看和管理各部门的周复盘、月度复盘和季度复盘记录</p>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Org Tree */}
        <div className="w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-100">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">组织架构</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
            {renderDeptTree(visibleDepartments)}
          </div>
        </div>

        {/* Right Content - Review Grid */}
        <div className="flex-1 overflow-y-auto p-8 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:24px_24px]">
          {selectedDept ? (
            <div className="max-w-5xl mx-auto space-y-8">
              {/* Weekly Reviews */}
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-black text-slate-800 flex items-center gap-2">
                    <Calendar className="text-brand-500" size={20} />
                    周复盘记录
                  </h3>
                  <button 
                    onClick={() => navigateToReview('weekly', selectedDept.id)}
                    className="flex items-center gap-1 text-sm font-bold text-brand-600 hover:text-brand-700 bg-brand-50 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <Plus size={16} />
                    发起周复盘
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {recentWeeks.map(week => {
                    const review = selectedDept.reviews?.[week]?.[0];
                    return (
                      <div 
                        key={week} 
                        onClick={() => navigateToReview('weekly', selectedDept.id, week)}
                        className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-brand-300 transition-all cursor-pointer group"
                      >
                        <div className="flex justify-between items-start mb-3">
                          <span className="text-sm font-black text-slate-700">{week}</span>
                          {review ? (
                            <span className="text-[10px] font-bold px-2 py-1 rounded-md bg-emerald-50 text-emerald-600">已复盘</span>
                          ) : (
                            <span className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-100 text-slate-500">未复盘</span>
                          )}
                        </div>
                        {review ? (
                          <>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-2xl font-black text-brand-600">{review.score}</span>
                              <span className="text-xs text-slate-400 font-bold">/ 100 分</span>
                            </div>
                            <p className="text-xs text-slate-500 line-clamp-2">{review.content}</p>
                          </>
                        ) : (
                          <div className="h-16 flex items-center justify-center text-slate-300">
                            <FileText size={24} className="opacity-20" />
                          </div>
                        )}
                        <div className="mt-4 flex items-center justify-end text-brand-600 opacity-0 group-hover:opacity-100 transition-opacity">
                          <span className="text-xs font-bold mr-1">{review ? '查看详情' : '去复盘'}</span>
                          <ChevronRight size={14} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex justify-center">
                  <button 
                    onClick={() => setVisibleWeeksCount(prev => prev + 6)}
                    className="text-xs font-bold text-slate-400 hover:text-brand-600 transition-colors bg-white border border-slate-200 px-4 py-2 rounded-full hover:border-brand-300 hover:shadow-sm"
                  >
                    查看更多
                  </button>
                </div>
              </section>

              {/* Monthly Reviews */}
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-black text-slate-800 flex items-center gap-2">
                    <Calendar className="text-indigo-500" size={20} />
                    月度复盘记录
                  </h3>
                  <button 
                    onClick={() => navigateToReview('monthly', selectedDept.id)}
                    className="flex items-center gap-1 text-sm font-bold text-indigo-600 hover:text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <Plus size={16} />
                    发起月度复盘
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {recentMonths.map(month => {
                    const review = selectedDept.reviews?.[month]?.[0];
                    return (
                      <div 
                        key={month} 
                        onClick={() => navigateToReview('monthly', selectedDept.id, month)}
                        className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all cursor-pointer group"
                      >
                        <div className="flex justify-between items-start mb-3">
                          <span className="text-sm font-black text-slate-700">{month}</span>
                          {review ? (
                            <span className="text-[10px] font-bold px-2 py-1 rounded-md bg-emerald-50 text-emerald-600">已复盘</span>
                          ) : (
                            <span className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-100 text-slate-500">未复盘</span>
                          )}
                        </div>
                        {review ? (
                          <>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-2xl font-black text-indigo-600">{review.score}</span>
                              <span className="text-xs text-slate-400 font-bold">/ 100 分</span>
                            </div>
                            <p className="text-xs text-slate-500 line-clamp-2">{review.content}</p>
                          </>
                        ) : (
                          <div className="h-16 flex items-center justify-center text-slate-300">
                            <FileText size={24} className="opacity-20" />
                          </div>
                        )}
                        <div className="mt-4 flex items-center justify-end text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity">
                          <span className="text-xs font-bold mr-1">{review ? '查看详情' : '去复盘'}</span>
                          <ChevronRight size={14} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex justify-center">
                  <button 
                    onClick={() => setVisibleMonthsCount(prev => prev + 6)}
                    className="text-xs font-bold text-slate-400 hover:text-indigo-600 transition-colors bg-white border border-slate-200 px-4 py-2 rounded-full hover:border-indigo-300 hover:shadow-sm"
                  >
                    查看更多
                  </button>
                </div>
              </section>

              {/* Quarterly Reviews */}
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-black text-slate-800 flex items-center gap-2">
                    <Target className="text-violet-500" size={20} />
                    季度复盘记录
                  </h3>
                  <button 
                    onClick={() => navigateToReview('quarterly', selectedDept.id)}
                    className="flex items-center gap-1 text-sm font-bold text-violet-600 hover:text-violet-700 bg-violet-50 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <Plus size={16} />
                    发起季度复盘
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {recentQuarters.map(quarter => {
                    const review = selectedDept.reviews?.[quarter]?.[0];
                    return (
                      <div 
                        key={quarter} 
                        onClick={() => navigateToReview('quarterly', selectedDept.id, quarter)}
                        className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-violet-300 transition-all cursor-pointer group"
                      >
                        <div className="flex justify-between items-start mb-3">
                          <span className="text-sm font-black text-slate-700">{quarter}</span>
                          {review ? (
                            <span className="text-[10px] font-bold px-2 py-1 rounded-md bg-emerald-50 text-emerald-600">已复盘</span>
                          ) : (
                            <span className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-100 text-slate-500">未复盘</span>
                          )}
                        </div>
                        {review ? (
                          <>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-2xl font-black text-violet-600">{review.score}</span>
                              <span className="text-xs text-slate-400 font-bold">/ 100 分</span>
                            </div>
                            <p className="text-xs text-slate-500 line-clamp-2">{review.content}</p>
                          </>
                        ) : (
                          <div className="h-16 flex items-center justify-center text-slate-300">
                            <FileText size={24} className="opacity-20" />
                          </div>
                        )}
                        <div className="mt-4 flex items-center justify-end text-violet-600 opacity-0 group-hover:opacity-100 transition-opacity">
                          <span className="text-xs font-bold mr-1">{review ? '查看详情' : '去复盘'}</span>
                          <ChevronRight size={14} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex justify-center">
                  <button 
                    onClick={() => setVisibleQuartersCount(prev => prev + 6)}
                    className="text-xs font-bold text-slate-400 hover:text-violet-600 transition-colors bg-white border border-slate-200 px-4 py-2 rounded-full hover:border-violet-300 hover:shadow-sm"
                  >
                    查看更多
                  </button>
                </div>
              </section>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-slate-400">
              请在左侧选择一个部门
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OkrReviewDashboard;
