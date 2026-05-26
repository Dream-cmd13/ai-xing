import React, { useState, useMemo, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppActions } from '@/hooks/useAppActions';
import { usePermissions } from '@/hooks/usePermissions';

import { AppState, OKR, Department, CompanyStrategy, ReviewEntry, ObjectiveReview, KRReview, WeeklyPAD, PADEntry, User, MenuPermission } from '@/types';
import { checkOKRQuality, checkStrategyQuality } from '@/services/gemini';
import { IMEInput, IMETextarea } from '@/components/IMEInput';
import { 
  Loader2, ChevronDown, Building2, Plus, Trash2, Calendar, 
  Link2, Target, Eye, Globe, Compass, Stars, Wand2, Minus, CheckCircle, Save, WifiOff, Sparkles, X, AlertCircle,
  ClipboardCheck, TrendingUp, MessageSquare, FileText, LayoutList, Clock, Check, ArrowRight, ChevronRight,
  AlignLeft, Lock
} from 'lucide-react';



// Tree Node Component for Modal
const AlignmentTreeNode: React.FC<{ node: any, selectedIds: string[], onToggle: (id: string) => void }> = ({ node, selectedIds, onToggle }) => {
  const [expanded, setExpanded] = useState(true);
  const isLeaf = !node.children || node.children.length === 0;
  const isSelected = selectedIds.includes(node.id);
  const isSelectable = node.type === 'Objective' || node.type === 'Key Result';

  return (
    <div className="ml-4">
      <div className="flex items-center gap-2 py-1">
        {!isLeaf && (
          <button onClick={() => setExpanded(!expanded)} className="p-0.5 hover:bg-slate-100 rounded">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        {isLeaf && <div className="w-4" />}
        
        {isSelectable ? (
          <button 
            onClick={() => onToggle(node.id)}
            className={`flex items-center gap-2 px-2 py-1 rounded-lg text-xs text-left transition-colors ${isSelected ? 'bg-brand-50 text-brand-600 font-bold' : 'hover:bg-slate-50 text-slate-600'}`}
          >
            <div className={`w-4 h-4 rounded border flex items-center justify-center ${isSelected ? 'bg-brand-600 border-brand-600' : 'border-slate-300 bg-white'}`}>
              {isSelected && <Check size={10} className="text-white" />}
            </div>
            <span className={node.type === 'Objective' ? 'font-bold' : ''}>
              {node.type === 'Key Result' && <span className="text-[9px] bg-slate-100 px-1 rounded mr-1">KR</span>}
              {node.label}
            </span>
          </button>
        ) : (
          <span className="text-xs font-black text-slate-400 uppercase tracking-wider">{node.label}</span>
        )}
      </div>
      {expanded && node.children && (
        <div className="border-l border-slate-100 ml-2 pl-2">
          {node.children.map((child: any) => (
            <AlignmentTreeNode key={child.id} node={child} selectedIds={selectedIds} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
};

const StrategyView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('okr');
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

  // State
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [availableYears, setAvailableYears] = useState<number[]>([new Date().getFullYear()]);
  const [activeTab, setActiveTab] = useState<'strategy' | 'okr' | 'company-okr' | 'dept-okr'>('company-okr'); 
  const [checking, setChecking] = useState<string | boolean>(false);

  const [aiResult, setAiResult] = useState<{ score: number, suggestions: string[] } | null>(null);
  const [deptViewMode, setDeptViewMode] = useState<'annual' | 'quarterly'>('annual');
  const [activeQuarter, setActiveQuarter] = useState<string>('Q1');
  const [expandedDept, setExpandedDept] = useState<string | null>(null);
  const [alignmentModal, setAlignmentModal] = useState<any>(null);
  
  // Helper to set dirty when modifying data
  const updateStrategy = (s: Partial<CompanyStrategy>) => {
    setStrategy(s);
    setIsDirty(true);
  };

  const updateDepartments = (d: Department[]) => {
    setDepartments(d);
    setIsDirty(true);
  };

  const updateDeptRecursive = (depts: Department[], id: string, updater: (d: Department) => Department): Department[] => {
    return depts.map(d => {
      if (d.id === id) return updater(d);
      if (d.subDepartments && d.subDepartments.length > 0) {
        return { ...d, subDepartments: updateDeptRecursive(d.subDepartments, id, updater) };
      }
      return d;
    });
  };

  const checkQuality = async (content: string, type: 'strategy' | 'okr') => {
    setChecking(true);
    setAiResult(null);
    // Simulate AI check
    setTimeout(() => {
      setAiResult({ score: 85, suggestions: ['建议更加具体', '增加可衡量的结果'] });
      setChecking(false);
    }, 1000);
  };

  const getAlignmentTree = (deptId: string, period: string, currentQuarter: string) => {
    const tree: any[] = [];

    // 1. Company OKRs (Annual) - Strategic Goals
    // Always available for alignment to ensure "Strategic Goals" are never blank
    const companyOkrs = state.strategy.companyOKRs[selectedYear] || state.strategy.companyOKRs[String(selectedYear)] || [];
    if (companyOkrs.length > 0) {
      tree.push({
        id: 'company-root',
        label: '公司年度战略目标',
        type: 'root',
        children: companyOkrs.map(o => ({
          id: o.id,
          label: `O: ${o.objective}`,
          type: 'Objective',
          children: (o.keyResults || []).map((kr, idx) => ({
            id: `${o.id}-kr-${idx}`,
            label: `KR: ${kr}`,
            type: 'Key Result'
          }))
        }))
      });
    }

    // 2. This Department's Annual OKRs - Available for Quarterly OKRs to align to
    if (period !== 'Annual') {
      const dept = flatDepts.find(d => d.id === deptId);
      if (dept) {
        const deptOkrs = dept.okrs?.[selectedYear] || dept.okrs?.[String(selectedYear)] || {};
        if (deptOkrs['Annual'] && deptOkrs['Annual'].length > 0) {
          tree.push({
            id: `${dept.id}-annual`,
            label: '本部门年度目标',
            type: 'root',
            children: deptOkrs['Annual'].map(o => ({
              id: o.id,
              label: `O: ${o.objective}`,
              type: 'Objective',
              children: (o.keyResults || []).map((kr, idx) => ({
                id: `${o.id}-kr-${idx}`,
                label: `KR: ${kr}`,
                type: 'Key Result'
              }))
            }))
          });
        }
      }
    }

    return tree;
  };


  const getStatusConfig = (status?: string) => {
    switch (status) {
      case 'on-track': return { label: '正常推进', color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' };
      case 'at-risk': return { label: '存在风险', color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' };
      case 'behind': return { label: '严重滞后', color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200' };
      default: return { label: '未设置状态', color: 'text-slate-400', bg: 'bg-slate-50', border: 'border-slate-200' };
    }
  };

  // Custom Confirmation
  const [pendingDeleteOkr, setPendingDeleteOkr] = useState<{deptId: string | null, period: string, okrIdx: number} | null>(null);
  const [pendingDeleteKR, setPendingDeleteKR] = useState<{ type: 'company' | 'dept', deptId?: string, period?: string, okrIdx: number, krIdx: number } | null>(null);

  // ... (existing code)



  // Removed direct deleteReview function in favor of confirmDeleteReview and performDeleteReview

  const flatDepts = useMemo(() => {
    const list: Department[] = [];
    const collect = (depts: Department[]) => {
      depts.forEach(d => {
        list.push(d);
        if (d.subDepartments) collect(d.subDepartments);
      });
    };
    collect(state.departments);
    return list;
  }, [state.departments]);

  // Sync available years from data
  const calculatedYears = useMemo(() => {
    const yearsFromStrategy = Object.keys(state.strategy.companyOKRs).map(Number);
    const yearsFromDepts: number[] = [];
    const list: Department[] = [];
    const collect = (depts: Department[]) => {
      depts.forEach(d => {
        list.push(d);
        if (d.subDepartments) collect(d.subDepartments);
      });
    };
    collect(state.departments);
    
    list.forEach(d => {
      if (d.okrs) {
        Object.keys(d.okrs).forEach(y => yearsFromDepts.push(Number(y)));
      }
    });
    
    return Array.from(new Set([
      new Date().getFullYear(),
      ...yearsFromStrategy,
      ...yearsFromDepts
    ])).filter(y => !isNaN(y)).sort((a, b) => b - a);
  }, [state.strategy.companyOKRs, state.departments]);

  useEffect(() => {
    if (calculatedYears.length > 0) {
      // Only update if the years actually changed to avoid unnecessary re-renders
      if (JSON.stringify(calculatedYears) !== JSON.stringify(availableYears)) {
        setAvailableYears(calculatedYears);
      }
      
      const hasData = (y: number) => {
        const companyOkrs = (state.strategy.companyOKRs[y] || state.strategy.companyOKRs[String(y)]) as any[];
        const hasCompanyData = Array.isArray(companyOkrs) && companyOkrs.length > 0;
        
        const hasDeptData = flatDepts.some(d => {
          const deptOkrs = (d.okrs?.[y] || d.okrs?.[String(y)]) as any;
          return deptOkrs && Object.values(deptOkrs).some(list => Array.isArray(list) && list.length > 0);
        });
        
        return hasCompanyData || hasDeptData;
      };

      const isFirstLoad = availableYears.length === 1 && availableYears[0] === new Date().getFullYear();

      if (!calculatedYears.includes(selectedYear) || (isFirstLoad && !hasData(selectedYear))) {
        const yearWithData = calculatedYears.find(y => hasData(y));
        if (yearWithData) {
          setSelectedYear(yearWithData);
        } else if (!calculatedYears.includes(selectedYear)) {
          setSelectedYear(calculatedYears[0]);
        }
      }
    }
  }, [calculatedYears, state.strategy.companyOKRs, flatDepts, selectedYear, availableYears]);

  const currentCompanyOKRs = useMemo(() => {
    const okrs = state.strategy.companyOKRs[selectedYear] || state.strategy.companyOKRs[String(selectedYear)] || [];
    return okrs;
  }, [state.strategy.companyOKRs, selectedYear]);

  const allAvailableKRs = useMemo(() => {
    const options: { id: string, label: string, owner: string }[] = [];
    currentCompanyOKRs.forEach(o => {
      (o.keyResults || []).forEach((kr, idx) => {
        options.push({ id: `${o.id}-kr-${idx}`, label: kr, owner: '公司战略' });
      });
    });
    flatDepts.forEach(d => {
      const yearOkrs = (d.okrs?.[selectedYear] || d.okrs?.[String(selectedYear)] || {}) as Record<string, OKR[]>;
      Object.entries(yearOkrs).forEach(([period, okrList]) => {
        (okrList || []).forEach(o => {
          (o.keyResults || []).forEach((kr, idx) => {
            options.push({ id: `${o.id}-kr-${idx}`, label: kr, owner: `${d.name} (${period})` });
          });
        });
      });
    });
    return options;
  }, [currentCompanyOKRs, flatDepts, selectedYear]);

  const runAiCheck = async (id: string, obj: string, krs: string[]) => {
    setChecking(id);
    const result = await checkOKRQuality(state.aiSettings, obj, krs);
    setAiResult({ id, text: result });
    setChecking(null);
  };

  const runStrategyAiCheck = async (type: '使命' | '愿景', content: string) => {
    setChecking(type);
    const result = await checkStrategyQuality(state.aiSettings, type, content);
    setAiResult({ id: type, text: result });
    setChecking(null);
  };

  const updateCompanyObjective = (idx: number, objective: string) => {
    const yearOKRs = [...currentCompanyOKRs];
    yearOKRs[idx] = { ...yearOKRs[idx], objective };
    updateStrategy({ companyOKRs: { ...state.strategy.companyOKRs, [selectedYear]: yearOKRs } });
  };

  const updateCompanyKR = (okrIdx: number, krIdx: number, val: string) => {
    const yearOKRs = [...currentCompanyOKRs];
    const krs = [...yearOKRs[okrIdx].keyResults];
    krs[krIdx] = val;
    yearOKRs[okrIdx] = { ...yearOKRs[okrIdx], keyResults: krs };
    updateStrategy({ companyOKRs: { ...state.strategy.companyOKRs, [selectedYear]: yearOKRs } });
  };

  const addCompanyKR = (okrIdx: number) => {
    const yearOKRs = [...currentCompanyOKRs];
    const krs = [...yearOKRs[okrIdx].keyResults, ''];
    yearOKRs[okrIdx] = { ...yearOKRs[okrIdx], keyResults: krs };
    updateStrategy({ companyOKRs: { ...state.strategy.companyOKRs, [selectedYear]: yearOKRs } });
  };

  const deleteCompanyKR = (okrIdx: number, krIdx: number) => {
    setPendingDeleteKR({ type: 'company', okrIdx, krIdx });
  };

  const updateDeptOkrField = (deptId: string, q: string, idx: number, updates: Partial<OKR>) => {
    const depts = updateDeptRecursive(state.departments, deptId, d => {
      const deptOkrs = { ...(d.okrs || {}) };
      const yearOkrs = { ...(deptOkrs[selectedYear] || deptOkrs[String(selectedYear)] || {}) };
      const list = [...(yearOkrs[q] || [])];
      list[idx] = { ...list[idx], ...updates };
      yearOkrs[q] = list;
      deptOkrs[selectedYear] = yearOkrs;
      return { ...d, okrs: deptOkrs };
    });
    updateDepartments(depts);
  };

  const updateDeptKR = (deptId: string, q: string, okrIdx: number, krIdx: number, val: string) => {
    const depts = updateDeptRecursive(state.departments, deptId, d => {
      const deptOkrs = { ...(d.okrs || {}) };
      const yearOkrs = { ...(deptOkrs[selectedYear] || deptOkrs[String(selectedYear)] || {}) };
      const list = [...(yearOkrs[q] || [])];
      const krs = [...list[okrIdx].keyResults];
      krs[krIdx] = val;
      list[okrIdx] = { ...list[okrIdx], keyResults: krs };
      yearOkrs[q] = list;
      deptOkrs[selectedYear] = yearOkrs;
      return { ...d, okrs: deptOkrs };
    });
    updateDepartments(depts);
  };

  const addDeptKR = (deptId: string, q: string, okrIdx: number) => {
    const depts = updateDeptRecursive(state.departments, deptId, d => {
      const deptOkrs = { ...(d.okrs || {}) };
      const yearOkrs = { ...(deptOkrs[selectedYear] || deptOkrs[String(selectedYear)] || {}) };
      const list = [...(yearOkrs[q] || [])];
      const krs = [...list[okrIdx].keyResults, ''];
      list[okrIdx] = { ...list[okrIdx], keyResults: krs };
      yearOkrs[q] = list;
      deptOkrs[selectedYear] = yearOkrs;
      return { ...d, okrs: deptOkrs };
    });
    updateDepartments(depts);
  };

  const deleteDeptKR = (deptId: string, q: string, okrIdx: number, krIdx: number) => {
    setPendingDeleteKR({ type: 'dept', deptId, period: q, okrIdx, krIdx });
  };

  const performDeleteKR = () => {
    if (!pendingDeleteKR) return;
    const { type, deptId, period, okrIdx, krIdx } = pendingDeleteKR;

    if (type === 'company') {
      const yearOKRs = [...currentCompanyOKRs];
      const krs = yearOKRs[okrIdx].keyResults.filter((_, i) => i !== krIdx);
      yearOKRs[okrIdx] = { ...yearOKRs[okrIdx], keyResults: krs };
      updateStrategy({ companyOKRs: { ...state.strategy.companyOKRs, [selectedYear]: yearOKRs } });
    } else if (type === 'dept' && deptId && period) {
      const depts = updateDeptRecursive(state.departments, deptId, d => {
        const deptOkrs = { ...(d.okrs || {}) };
        const yearOkrs = { ...(deptOkrs[selectedYear] || {}) };
        const list = [...(yearOkrs[period] || [])];
        const krs = list[okrIdx].keyResults.filter((_, i) => i !== krIdx);
        list[okrIdx] = { ...list[okrIdx], keyResults: krs };
        yearOkrs[period] = list;
        deptOkrs[selectedYear] = yearOkrs;
        return { ...d, okrs: deptOkrs };
      });
      updateDepartments(depts);
    }
    setPendingDeleteKR(null);
  };

  const performDeleteOkr = () => {
    if (!pendingDeleteOkr) return;
    const { deptId, period, okrIdx } = pendingDeleteOkr;
    if (deptId === null) {
      updateStrategy({ companyOKRs: { ...state.strategy.companyOKRs, [selectedYear]: currentCompanyOKRs.filter((_, idx) => idx !== okrIdx) } });
    } else {
      const depts = updateDeptRecursive(state.departments, deptId, d => {
        const deptOkrs = { ...(d.okrs || {}) };
        const yearOkrs = { ...(deptOkrs[selectedYear] || {}) };
        const list = (yearOkrs[period] || []).filter((_, i) => i !== okrIdx);
        yearOkrs[period] = list;
        deptOkrs[selectedYear] = yearOkrs;
        return { ...d, okrs: deptOkrs };
      });
      updateDepartments(depts);
    }
    setPendingDeleteOkr(null);
  };

  const addDeptOkr = (deptId: string, q: string) => {
    const depts = updateDeptRecursive(state.departments, deptId, d => {
      const deptOkrs = { ...(d.okrs || {}) };
      const yearOkrs = { ...(deptOkrs[selectedYear] || {}) };
      const list = [...(yearOkrs[q] || []), { id: `okr-${Date.now()}`, objective: '', keyResults: [''] }];
      yearOkrs[q] = list;
      deptOkrs[selectedYear] = yearOkrs;
      return { ...d, okrs: deptOkrs };
    });
    updateDepartments(depts);
  };

  const addNewYear = () => {
    const nextYear = Math.max(...availableYears) + 1;
    setAvailableYears([...availableYears, nextYear]);
    setSelectedYear(nextYear);
  };



  return (
    <div className="h-full flex flex-col gap-4 md:gap-6 p-4 md:p-6 bg-slate-50 relative overflow-hidden">
      <div className="bg-white p-4 md:p-6 rounded-[2.5rem] border shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div className="flex items-center gap-4 w-full md:w-auto">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-brand-50 rounded-2xl flex items-center justify-center text-brand-600 shadow-inner shrink-0"><Target size={20} className="md:w-6 md:h-6"/></div>
          <div className="flex-1">
            <h2 className="text-lg md:text-xl font-black tracking-tighter">OKR 中心</h2>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <div className="flex items-center bg-slate-100 border rounded-xl px-2 md:px-3 py-1 gap-1 md:gap-2 shadow-inner">
                <Calendar size={12} className="text-slate-400 md:w-3.5 md:h-3.5"/>
                <select value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))} className="bg-transparent text-[10px] font-black outline-none border-none uppercase tracking-widest">
                  {availableYears.map(y => <option key={y} value={y}>{y} 年度</option>)}
                </select>
              </div>
              {permissions.create && (
                <button onClick={addNewYear} className="p-1 md:p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-all" title="新增规划年度"><Plus size={14} className="md:w-4 md:h-4"/></button>
              )}
              <div className="w-px h-4 bg-slate-200 mx-1 md:mx-2 hidden md:block"></div>
              <button 
                onClick={() => handleSave(['strategy', 'departments'])} 
                disabled={isSaving} 
                className={`px-4 md:px-6 py-1.5 md:py-2 rounded-xl text-[10px] font-black uppercase flex items-center gap-1 md:gap-2 transition-all shadow-md ${showSaveSuccess ? 'bg-emerald-50 text-emerald-600' : isDirty ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-brand-100' : 'bg-slate-100 text-slate-400 cursor-default'}`}
              >
                {isSaving ? <Loader2 className="animate-spin h-3 w-3"/> : showSaveSuccess ? <CheckCircle size={14}/> : <Save size={14} />} 
                {showSaveSuccess ? '已保存' : isDirty ? '立即保存' : '已是最新'}
              </button>
            </div>
          </div>
        </div>
        <div className="flex gap-2 bg-slate-100 p-1.5 rounded-2xl shadow-inner overflow-x-auto w-full md:w-auto custom-scrollbar">
          {[
            { id: 'company-okr', label: '公司年度 OKR', icon: <Stars size={14}/> },
            { id: 'dept-okr', label: '部门 OKR', icon: <Building2 size={14}/> }
          ].map(t => (
            <button 
              key={t.id} 
              onClick={() => setActiveTab(t.id as any)} 
              className={`flex-1 md:flex-none flex items-center justify-center gap-2 px-3 md:px-6 py-2 rounded-xl text-xs font-black uppercase transition-all whitespace-nowrap ${activeTab === t.id ? 'bg-white text-brand-600 shadow-md scale-105' : 'text-slate-500 hover:text-slate-700'}`}
            >
              {t.icon} <span className="hidden sm:inline">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar pb-12">
        {activeTab === 'company-okr' && (
          <div className="max-w-4xl mx-auto space-y-6 md:space-y-8 pb-12 py-4 md:py-6">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
               <h3 className="text-xs md:text-sm font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Calendar size={16}/> {selectedYear} 年度公司核心战略目标</h3>
               {permissions.create && (
                 <button onClick={() => updateStrategy({ companyOKRs: { ...state.strategy.companyOKRs, [selectedYear]: [...currentCompanyOKRs, { id: `c-okr-${Date.now()}`, objective: '', keyResults: [''] }] } })} className="bg-brand-600 text-white font-black text-xs px-4 md:px-6 py-2 md:py-2.5 rounded-xl md:rounded-2xl shadow-xl shadow-brand-100 hover:bg-brand-700 transition-all flex items-center gap-2 w-full md:w-auto justify-center">
                   <Plus size={16}/> 新增年度战略
                 </button>
               )}
            </header>
            
            <div className="space-y-4 md:space-y-6">
              {currentCompanyOKRs.length === 0 ? (
                <div className="bg-white p-12 md:p-20 rounded-[2rem] md:rounded-[3rem] border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-center">
                  <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center text-slate-300 mb-4">
                    <Target size={32} />
                  </div>
                  <h4 className="text-lg font-black text-slate-400 uppercase tracking-widest">暂无 {selectedYear} 年度公司级 OKR</h4>
                  <p className="text-xs text-slate-400 mt-2 font-bold max-w-xs">点击右上角“新增年度战略”开始制定本年度的公司核心战略目标</p>
                </div>
              ) : (
                currentCompanyOKRs.map((o, i) => (
                  <div key={o.id} className="bg-white p-6 md:p-10 rounded-[2rem] md:rounded-[3rem] border-2 shadow-sm relative border-l-[8px] md:border-l-[12px] border-l-brand-600 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex flex-col md:flex-row gap-4 md:gap-6 items-start mb-6 md:mb-8">
                      <div className="bg-brand-600 text-white px-3 md:px-4 py-1 md:py-1.5 rounded-xl text-[10px] font-black uppercase mt-1 tracking-widest shadow-lg shadow-brand-100">OBJ {i+1}</div>
                      <div className="flex-1 w-full">
                         <IMEInput 
                           className="w-full bg-transparent text-xl md:text-3xl font-black text-slate-800 tracking-tighter outline-none placeholder-slate-200 disabled:opacity-50" 
                           value={o.objective || ''} 
                           disabled={!permissions.update}
                           onChange={e => updateCompanyObjective(i, e.target.value)} 
                           placeholder="输入公司年度目标..." 
                         />
                      </div>
                      <div className="flex gap-2 self-end md:self-auto">
                        <button onClick={() => runAiCheck(o.id, o.objective, o.keyResults)} disabled={checking === o.id} className="px-3 md:px-4 py-1.5 md:py-2 bg-brand-50 text-brand-600 rounded-xl flex items-center gap-1 md:gap-2 text-[10px] font-black uppercase hover:bg-brand-100 transition-all border border-brand-100">
                          {checking === o.id ? <Loader2 className="animate-spin h-3 w-3"/> : <Wand2 size={14} className="md:w-4 md:h-4"/>} <span className="hidden sm:inline">AI 检查</span>
                        </button>
                        {permissions.update && (
                          <button onClick={() => setPendingDeleteOkr({deptId: null, period: 'Annual', okrIdx: i})} className="p-1.5 md:p-2 text-slate-200 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"><Trash2 size={16} className="md:w-[18px] md:h-[18px]"/></button>
                        )}
                      </div>
                    </div>
                    
                    <div className="space-y-2 md:space-y-3 pl-2 md:pl-6">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1">关键结果 (Key Results)</label>
                      {o.keyResults?.map((kr, ki) => (
                        <div key={ki} className="group flex items-center gap-2 md:gap-3 animate-in slide-in-from-left-2">
                          <div className="w-1.5 h-1.5 md:w-2 md:h-2 rounded-full bg-brand-300 shrink-0"/>
                          <IMEInput 
                            className="flex-1 bg-slate-50 hover:bg-white border border-transparent hover:border-slate-200 focus:border-brand-300 focus:bg-white p-2 md:p-3 rounded-xl md:rounded-2xl text-[10px] md:text-xs font-bold text-slate-700 outline-none transition-all shadow-inner disabled:opacity-50"
                            value={kr || ''}
                            disabled={!permissions.update}
                            onChange={e => updateCompanyKR(i, ki, e.target.value)}
                            placeholder="输入关键指标..."
                          />
                          {permissions.update && (
                        <button onClick={() => deleteCompanyKR(i, ki)} className="p-1 md:p-2 text-slate-300 hover:text-red-500 md:opacity-0 group-hover:opacity-100 transition-all"><Minus size={14}/></button>
                      )}
                        </div>
                      ))}
                      {permissions.update && (
                        <button onClick={() => addCompanyKR(i)} className="ml-3 md:ml-5 flex items-center gap-1 md:gap-2 text-[10px] font-black text-brand-600 py-2"><Plus size={12}/> 添加 KR 指标</button>
                      )}
                    </div>
  
                    {aiResult?.id === o.id && (
                      <div className="mt-6 md:mt-8 p-4 md:p-8 bg-brand-50 rounded-2xl md:rounded-[2rem] border border-brand-100 text-[10px] md:text-[11px] font-bold text-slate-700 relative shadow-inner">
                        <div className="absolute top-3 md:top-4 right-4 md:right-6 text-[8px] md:text-[9px] font-black text-brand-600 uppercase tracking-widest">AI 诊断建议</div>
                        <div className="prose prose-sm prose-slate" dangerouslySetInnerHTML={{ __html: aiResult.text }} />
                        <button onClick={() => setAiResult(null)} className="absolute bottom-3 md:bottom-4 right-4 md:right-6 p-1 md:p-2 text-slate-300 hover:text-brand-600"><CheckCircle size={14} className="md:w-4 md:h-4"/></button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'dept-okr' && (
          <div className="max-w-5xl mx-auto space-y-4 md:space-y-6 pb-12 py-4 md:py-6">
            <div className="flex flex-col items-center gap-4 mb-6 md:mb-10">
               <div className="flex gap-1 bg-white p-1 rounded-2xl border shadow-sm w-full md:w-auto overflow-x-auto">
                  <button onClick={() => setDeptViewMode('Annual')} className={`flex-1 md:flex-none px-4 md:px-8 py-2 rounded-xl text-[10px] md:text-[11px] font-black transition-all uppercase tracking-widest whitespace-nowrap ${deptViewMode === 'Annual' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}>部门年度目标</button>
                  <button onClick={() => setDeptViewMode('Quarter')} className={`flex-1 md:flex-none px-4 md:px-8 py-2 rounded-xl text-[10px] md:text-[11px] font-black transition-all uppercase tracking-widest whitespace-nowrap ${deptViewMode === 'Quarter' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}>部门季度目标</button>
               </div>
               {deptViewMode === 'Quarter' && (
                 <div className="flex gap-2 md:gap-4 w-full md:w-auto overflow-x-auto pb-2 md:pb-0">
                    {['Q1', 'Q2', 'Q3', 'Q4'].map(q => (
                      <button key={q} onClick={() => setActiveQuarter(q as any)} className={`flex-1 md:flex-none px-4 md:px-8 py-2 md:py-2.5 rounded-xl md:rounded-2xl text-[10px] font-black transition-all border whitespace-nowrap ${activeQuarter === q ? 'bg-brand-50 border-brand-200 text-brand-600 shadow-sm' : 'bg-white text-slate-400 border-slate-100'}`}>{q} 季度</button>
                    ))}
                 </div>
               )}
            </div>

            {state.departments.map(d => {
              const targetPeriod = deptViewMode === 'Annual' ? 'Annual' : activeQuarter;
              const periodOkrs = (d.okrs?.[selectedYear]?.[targetPeriod]) || [];
              return (
                <div key={d.id} className="bg-white rounded-[2rem] md:rounded-[3rem] border shadow-sm overflow-hidden mb-4 md:mb-6 group">
                  <div onClick={() => setExpandedDept(expandedDept === d.id ? null : d.id)} className="p-4 md:p-8 flex flex-col md:flex-row justify-between items-start md:items-center cursor-pointer hover:bg-slate-50 transition-colors gap-4">
                    <div className="flex items-center gap-4 md:gap-5 w-full md:w-auto">
                      <div className={`p-3 md:p-4 rounded-xl md:rounded-2xl shrink-0 ${expandedDept === d.id ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-400'}`}><Building2 size={20} className="md:w-6 md:h-6"/></div>
                      <div className="flex-1">
                        <h4 className="font-black text-lg md:text-xl text-slate-800">{d.name}</h4>
                        <div className="flex flex-wrap items-center gap-2 md:gap-3 mt-1">
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{targetPeriod} 治理</span>
                          {d.managerName && <span className="text-[10px] font-black bg-brand-50 text-brand-600 px-2 py-0.5 rounded uppercase">负责人: {d.managerName}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 self-end md:self-auto">
                      <span className="text-[10px] font-black px-3 md:px-4 py-1 md:py-1.5 bg-brand-50 text-brand-600 rounded-xl border border-brand-100 uppercase">{periodOkrs.length} 个 OKR</span>
                      <ChevronDown className={`transition-transform duration-500 text-slate-300 ${expandedDept === d.id ? 'rotate-180' : ''}`}/>
                    </div>
                  </div>
                  {expandedDept === d.id && (
                    <div className="p-4 md:p-10 bg-slate-50/50 border-t space-y-4 md:space-y-6">
                      {periodOkrs.map((okr, idx) => (
                        <div key={okr.id} className="bg-white p-4 md:p-8 rounded-2xl md:rounded-[2.5rem] border shadow-sm hover:border-brand-200 transition-all">
                          <div className="flex flex-col md:flex-row gap-4 md:gap-6 mb-4 md:mb-6">
                             <div className="flex-1 w-full">
                               <label className="text-[9px] font-black text-slate-300 uppercase mb-1 md:mb-2 block">Objective 目标</label>
                               <IMEInput 
                                 className="w-full font-black text-slate-800 outline-none text-base md:text-lg border-b-2 border-slate-50 focus:border-brand-300 transition-colors bg-transparent pb-1 disabled:opacity-50" 
                                 value={okr.objective || ''} 
                                 disabled={!permissions.update}
                                 onChange={e => updateDeptOkrField(d.id, targetPeriod, idx, { objective: e.target.value })} 
                                 placeholder="输入部门目标..." 
                               />
                             </div>
                             <div className="shrink-0 flex flex-wrap md:flex-nowrap gap-2 w-full md:w-auto">
                               <div className="flex items-center bg-white px-2 md:px-3 py-1.5 md:py-2 rounded-xl gap-1 md:gap-2 border shadow-sm flex-1 md:flex-none">
                                 <Link2 size={12} className="text-slate-400 shrink-0"/>
                                 <button 
                                   onClick={() => setAlignmentModal({
                                     isOpen: true,
                                     deptId: d.id,
                                     period: targetPeriod,
                                     okrIdx: idx,
                                     currentAlignedIds: okr.alignedToIds || []
                                   })}
                                   disabled={!permissions.update}
                                   className="bg-transparent text-[10px] font-black outline-none w-full md:max-w-[200px] truncate hover:text-brand-600 text-left disabled:opacity-50"
                                 >
                                   {okr.alignedToIds && okr.alignedToIds.length > 0 
                                     ? `已对齐 ${okr.alignedToIds.length} 项指标` 
                                     : '点击设置对齐目标'}
                                 </button>
                               </div>
                               <button onClick={() => runAiCheck(okr.id, okr.objective, okr.keyResults)} disabled={checking === okr.id} className="p-2 md:p-3 bg-brand-50 text-brand-600 rounded-xl flex items-center justify-center gap-1 md:gap-2 hover:bg-brand-100 transition-all flex-1 md:flex-none">
                                 {checking === okr.id ? <Loader2 className="animate-spin h-3 w-3 md:h-4 md:w-4"/> : <Wand2 size={14} className="md:w-4 md:h-4"/>}
                                 <span className="text-[10px] font-black uppercase">AI 检查</span>
                               </button>
                               {permissions.update && (
                                 <button onClick={() => setPendingDeleteOkr({deptId: d.id, period: targetPeriod, okrIdx: idx})} className="p-2 md:p-3 text-red-100 hover:text-red-400 rounded-xl bg-red-50 md:bg-transparent"><Trash2 size={14} className="md:w-4 md:h-4"/></button>
                               )}
                             </div>
                          </div>
                          <div className="space-y-2 md:space-y-3">
                             <label className="text-[9px] font-black text-slate-300 uppercase block mb-1">Key Results 关键结果指标</label>
                             {okr.keyResults?.map((kr, ki) => (
                               <div key={ki} className="flex items-center gap-2 md:gap-3">
                                 <div className="w-1.5 h-1.5 rounded-full bg-brand-400 shrink-0"/>
                                 <IMEInput 
                                   className="flex-1 bg-slate-50 p-2 rounded-xl text-[10px] md:text-xs font-bold text-slate-600 border border-transparent focus:border-brand-100 focus:bg-white outline-none disabled:opacity-50"
                                   value={kr || ''}
                                   disabled={!permissions.update}
                                   onChange={e => updateDeptKR(d.id, targetPeriod, idx, ki, e.target.value)}
                                 />
                                 {permissions.update && (
                                   <button onClick={() => deleteDeptKR(d.id, targetPeriod, idx, ki)} className="p-1 text-slate-300 hover:text-red-500"><Minus size={14}/></button>
                                 )}
                               </div>
                             ))}
                             {permissions.update && (
                               <button onClick={() => addDeptKR(d.id, targetPeriod, idx)} className="ml-3 md:ml-4 text-[10px] font-black text-brand-600 py-1 flex items-center gap-1"><Plus size={12}/> 添加量化指标</button>
                             )}
                          </div>
                          {aiResult?.id === okr.id && (
                            <div className="mt-4 p-3 md:p-4 bg-brand-50 rounded-xl border border-brand-100 text-[10px] text-slate-600 relative">
                              <div className="absolute top-2 right-2 cursor-pointer text-slate-400 hover:text-slate-600" onClick={() => setAiResult(null)}><X size={12}/></div>
                              <div className="flex items-center gap-2 mb-2 font-bold text-brand-700"><Sparkles size={12}/> AI 分析建议</div>
                              <div className="leading-relaxed whitespace-pre-wrap">{aiResult.text}</div>
                            </div>
                          )}
                        </div>
                      ))}
                      {permissions.create && (
                        <button onClick={() => addDeptOkr(d.id, targetPeriod)} className="w-full py-4 md:py-5 border-2 border-dashed border-slate-200 rounded-2xl md:rounded-[2.5rem] text-slate-400 font-black uppercase text-[10px] md:text-xs hover:border-brand-300 hover:text-brand-600 hover:bg-white transition-all flex items-center justify-center gap-2">
                          <Plus size={16} className="md:w-[18px] md:h-[18px]"/> 录入 {targetPeriod} 目标
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}





      </div>

      {/* Custom Confirmation for OKR Deletion */}
      {pendingDeleteOkr && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-4 md:p-6">
          <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] w-full max-w-sm p-6 md:p-10 shadow-2xl text-center animate-in zoom-in-95">
             <div className="w-12 h-12 md:w-16 md:h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 md:mb-6"><AlertCircle size={24} className="md:w-8 md:h-8"/></div>
             <h3 className="text-lg md:text-xl font-black mb-2 text-slate-800">确认删除此 OKR？</h3>
             <p className="text-[10px] md:text-xs text-slate-400 font-bold mb-6 md:mb-8 uppercase tracking-widest">关联的指标也将同步移除</p>
             <div className="flex gap-2 md:gap-3">
                <button onClick={() => setPendingDeleteOkr(null)} className="flex-1 py-2.5 md:py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] md:text-xs uppercase">取消</button>
                <button onClick={performDeleteOkr} className="flex-1 py-2.5 md:py-3 bg-red-500 text-white rounded-xl font-black text-[10px] md:text-xs uppercase shadow-lg shadow-red-200">确认删除</button>
             </div>
          </div>
        </div>
      )}



      {/* Custom Confirmation for KR Deletion */}
      {pendingDeleteKR && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-4 md:p-6">
          <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] w-full max-w-sm p-6 md:p-10 shadow-2xl text-center animate-in zoom-in-95">
             <div className="w-12 h-12 md:w-16 md:h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 md:mb-6"><AlertCircle size={24} className="md:w-8 md:h-8"/></div>
             <h3 className="text-lg md:text-xl font-black mb-2 text-slate-800">确认删除此关键结果 (KR)？</h3>
             <p className="text-[10px] md:text-xs text-slate-400 font-bold mb-6 md:mb-8 uppercase tracking-widest">删除后将无法恢复</p>
             <div className="flex gap-2 md:gap-3">
                <button onClick={() => setPendingDeleteKR(null)} className="flex-1 py-2.5 md:py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] md:text-xs uppercase">取消</button>
                <button onClick={performDeleteKR} className="flex-1 py-2.5 md:py-3 bg-red-500 text-white rounded-xl font-black text-[10px] md:text-xs uppercase shadow-lg shadow-red-200">确认删除</button>
             </div>
          </div>
        </div>
      )}
      {/* Alignment Modal */}
      {alignmentModal && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-4 md:p-6">
          <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] w-full max-w-2xl p-6 md:p-10 shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[90vh]">
             <div className="flex justify-between items-start md:items-center mb-4 md:mb-6 shrink-0 gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 md:w-12 md:h-12 bg-brand-50 text-brand-600 rounded-xl md:rounded-2xl flex items-center justify-center shrink-0"><Link2 size={20} className="md:w-6 md:h-6"/></div>
                  <div>
                    <h3 className="text-lg md:text-xl font-black text-slate-800">对齐战略目标</h3>
                    <p className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-widest">选择该 OKR 对齐的上级或关联目标</p>
                  </div>
                </div>
                <button onClick={() => setAlignmentModal(null)} className="p-2 hover:bg-slate-100 rounded-full shrink-0"><X size={20}/></button>
             </div>

             <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-2">
                {getAlignmentTree(alignmentModal.deptId, alignmentModal.period as any, activeQuarter).map(node => (
                  <AlignmentTreeNode 
                    key={node.id} 
                    node={node} 
                    selectedIds={alignmentModal.currentAlignedIds || []} 
                    onToggle={(id) => {
                      const currentIds = alignmentModal.currentAlignedIds || [];
                      const isSelected = currentIds.includes(id);
                      const newIds = isSelected 
                        ? currentIds.filter(i => i !== id)
                        : [...currentIds, id];
                      setAlignmentModal({ ...alignmentModal, currentAlignedIds: newIds });
                    }} 
                  />
                ))}
             </div>

             <div className="mt-6 md:mt-8 pt-4 md:pt-6 border-t border-slate-100 flex flex-col md:flex-row justify-end gap-2 md:gap-3 shrink-0">
                <button onClick={() => setAlignmentModal(null)} className="w-full md:w-auto px-6 py-2.5 md:py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] md:text-xs uppercase hover:bg-slate-200">取消</button>
                <button 
                  onClick={() => {
                    updateDeptOkrField(alignmentModal.deptId, alignmentModal.period, alignmentModal.okrIdx, { alignedToIds: alignmentModal.currentAlignedIds });
                    setAlignmentModal(null);
                  }} 
                  className="w-full md:w-auto px-8 py-2.5 md:py-3 bg-brand-600 text-white rounded-xl font-black text-[10px] md:text-xs uppercase shadow-xl hover:bg-brand-700"
                >
                  确认对齐 ({alignmentModal.currentAlignedIds?.length || 0})
                </button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StrategyView;
