import React, { useState, useMemo, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppActions } from '@/hooks/useAppActions';
import { usePermissions } from '@/hooks/usePermissions';

import { AppState, Department, OKR, PADEntry, WeeklyPAD, User } from '@/types';
import { ChevronLeft, ChevronRight, Plus, Calendar, Target, CheckCircle, Clock } from 'lucide-react';
import { canViewTask } from '@/utils/permissions';



interface PeriodAlignmentViewProps {
  selectedYear: number;
  selectedPeriod: string;
  selectedDeptId: string | null;
  onAddTask: (deptId: string, krId?: string, weekId?: string) => void;
  onTaskClick: (task: PADEntry) => void;
}

const PeriodAlignmentView: React.FC<PeriodAlignmentViewProps> = ({
  selectedYear,
  selectedPeriod,
  selectedDeptId,
  onAddTask,
  onTaskClick
}) => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('execution');
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

  const [startWeek, setStartWeek] = useState(1);
  const weeksToShow = 4;

  // Calculate weeks for the period
  const periodWeeks = useMemo(() => {
    let start = 1;
    let end = 52;
    if (selectedPeriod === 'Q1') { start = 1; end = 13; }
    else if (selectedPeriod === 'Q2') { start = 14; end = 26; }
    else if (selectedPeriod === 'Q3') { start = 27; end = 39; }
    else if (selectedPeriod === 'Q4') { start = 40; end = 52; }
    
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const currentYear = d.getUTCFullYear();
    const currentWeekNum = getWeekNumber(now);

    const weeks = [];
    for (let i = start; i <= end; i++) {
      weeks.push({
        id: `${selectedYear}-W${i.toString().padStart(2, '0')}`,
        label: `�?${i} 周`,
        isCurrent: selectedYear === currentYear && i === currentWeekNum
      });
    }
    return weeks;
  }, [selectedYear, selectedPeriod]);

  useEffect(() => {
    const currentIndex = periodWeeks.findIndex(w => w.isCurrent);
    if (currentIndex !== -1) {
      let newStart = currentIndex + 1;
      newStart = Math.min(newStart, periodWeeks.length - weeksToShow + 1);
      setStartWeek(Math.max(1, newStart));
    } else {
      setStartWeek(1);
    }
  }, [periodWeeks]);

  // Get OKRs for the selected department and period
  const okrs = useMemo(() => {
    if (!selectedDeptId) return [];
    const dept = state.departments.find(d => d.id === selectedDeptId);
    if (!dept) return [];
    return dept.okrs?.[selectedYear]?.[selectedPeriod] || [];
  }, [state.departments, selectedDeptId, selectedYear, selectedPeriod]);

  // Pre-group tasks for efficiency
  const tasksByWeekAndKr = useMemo(() => {
    const map: Record<string, Record<string, PADEntry[]>> = {};

    state.tasks.forEach(e => {
      if (!canViewTask(e, currentUser, state.users, state.systemRoles || [])) return;

      if (e.alignedKrId) {
        const weeks = e.targetWeeks && e.targetWeeks.length > 0 ? e.targetWeeks : [];
        weeks.forEach(w => {
          if (!map[w]) map[w] = {};
          if (!map[w][e.alignedKrId]) map[w][e.alignedKrId] = [];
          map[w][e.alignedKrId].push(e);
        });
      }
    });
    return map;
  }, [state.tasks, currentUser, state.users]);

  // Get tasks for the weeks
  const getTasksForCell = (weekId: string, krId: string) => {
    return tasksByWeekAndKr[weekId]?.[krId] || [];
  };

  const visibleWeeks = periodWeeks.slice(startWeek - 1, startWeek - 1 + weeksToShow);

  return (
    <div className="bg-white rounded-[2.5rem] border shadow-sm overflow-hidden flex flex-col h-full">
      {/* Header */}
      <div className="p-4 md:p-6 border-b flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-50/50 gap-4">
        <div className="flex items-center gap-3 md:gap-4">
          <div className="p-2 md:p-3 bg-indigo-50 text-indigo-600 rounded-xl md:rounded-2xl"><Calendar size={20} className="md:w-6 md:h-6"/></div>
          <div>
            <h3 className="text-lg md:text-xl font-black text-slate-800">周期对齐视图</h3>
            <p className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-widest">Period Alignment & Execution</p>
          </div>
        </div>
        <div className="flex items-center justify-between w-full md:w-auto gap-2 bg-white md:bg-transparent p-2 md:p-0 rounded-xl md:rounded-none border md:border-none shadow-sm md:shadow-none">
          <button 
            onClick={() => setStartWeek(Math.max(1, startWeek - 1))}
            disabled={startWeek <= 1}
            className="p-2 hover:bg-slate-100 rounded-xl disabled:opacity-30"
          >
            <ChevronLeft size={20}/>
          </button>
          <span className="text-[10px] md:text-xs font-black text-slate-500">
            显示 {visibleWeeks[0]?.label} - {visibleWeeks[visibleWeeks.length-1]?.label}
          </span>
          <button 
            onClick={() => setStartWeek(Math.min(periodWeeks.length - weeksToShow + 1, startWeek + 1))}
            disabled={startWeek >= periodWeeks.length - weeksToShow + 1}
            className="p-2 hover:bg-slate-100 rounded-xl disabled:opacity-30"
          >
            <ChevronRight size={20}/>
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        <div className="min-w-[1000px]">
          {/* Grid Header */}
          <div className="flex border-b sticky top-0 bg-white z-10">
            <div className="w-80 shrink-0 p-4 font-black text-xs text-slate-400 uppercase tracking-widest bg-slate-50 border-r">
              目标与关键结�?(OKR)
            </div>
            {visibleWeeks.map(w => (
              <div key={w.id} className={`flex-1 min-w-0 p-4 font-black text-xs text-center border-r min-w-[200px] ${w.isCurrent ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'}`}>
                {w.label} {w.isCurrent && '(本周)'}
              </div>
            ))}
          </div>

          {/* Grid Body */}
          <div className="divide-y">
            {okrs.map((okr, oIdx) => (
              <React.Fragment key={okr.id}>
                {/* Objective Row */}
                <div className="flex bg-slate-50/30">
                  <div className="w-80 shrink-0 p-4 border-r">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="bg-brand-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded uppercase">OBJ {oIdx + 1}</span>
                    </div>
                    <p className="font-bold text-sm text-slate-800 break-words">{okr.objective}</p>
                  </div>
                  {visibleWeeks.map(w => (
                    <div key={w.id} className="flex-1 min-w-0 border-r bg-slate-50/30 min-w-[200px]"/>
                  ))}
                </div>

                {/* Key Results Rows */}
                {okr.keyResults?.map((kr, kIdx) => {
                  const krId = `${okr.id}-kr-${kIdx}`;
                  return (
                    <div key={krId} className="flex group hover:bg-slate-50 transition-colors">
                      <div className="w-80 shrink-0 p-4 border-r pl-8 relative">
                        <div className="absolute left-4 top-6 w-2 h-2 rounded-full bg-brand-300"/>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[9px] font-black text-slate-400 uppercase">KR {kIdx + 1}</span>
                        </div>
                        <p className="text-xs font-bold text-slate-600 break-words">{kr}</p>
                      </div>
                      
                      {visibleWeeks.map(w => {
                        const tasks = getTasksForCell(w.id, krId);
                        return (
                          <div key={w.id} className="flex-1 min-w-0 p-3 border-r min-w-[200px] flex flex-col gap-2 relative">
                            {tasks.map(t => (
                              <div 
                                key={t.id} 
                                onClick={() => onTaskClick(w.id, t)}
                                className="bg-white p-2 rounded-lg border shadow-sm text-[10px] font-bold text-slate-700 hover:border-brand-300 transition-all cursor-pointer"
                              >
                                <div className="flex items-center gap-1 mb-1">
                                  {t.status === 'completed' ? <CheckCircle size={10} className="text-emerald-500"/> : <Clock size={10} className="text-amber-500"/>}
                                  <span className="truncate">{t.title}</span>
                                </div>
                              </div>
                            ))}
                            <button 
                              onClick={() => onAddTask(w.id, krId)}
                              className="w-full py-2 rounded-lg border border-dashed border-slate-200 text-slate-300 hover:text-brand-600 hover:border-brand-300 hover:bg-brand-50 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100"
                            >
                              <Plus size={14}/>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
            
            {okrs.length === 0 && (
              <div className="p-12 text-center text-slate-400 italic">
                该周期暂�?OKR 数据，请先在“部�?OKR”中制定目标�?              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

function getWeekNumber(d: Date) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return weekNo;
}

export default PeriodAlignmentView;
