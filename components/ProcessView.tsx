
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useLeaveGuard } from '@/hooks/useLeaveGuard';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { ProcessNode, ProcessLink, SIPOC, ProcessDefinition, Department, ProcessCategory, ProcessHistory, MenuPermission, User as AppUser } from '../types';
import { IMEInput, IMETextarea } from './IMEInput';
import { 
  X, Plus, Trash2, Layers, ChevronLeft, ChevronRight, 
  ArrowUpRight, CheckCircle2, Settings, History, Send, Info, User, Users, Target, RotateCcw, Layout,
  GitMerge, PlayCircle, StopCircle, Save, WifiOff, CheckCircle, Clock, AlertTriangle, Check, Lock, Loader2, Search
} from 'lucide-react';
import PageToast from './PageToast';
import { usePageToast } from '../hooks/usePageToast';
import { canPersistProcess, canManageProcess, getManagedDepartmentIds } from '../utils/permissions';



const CATEGORIES: ProcessCategory[] = ['供应链', '需求链', '产品研发', '辅助体系'];
const NODE_W = 170;
const NODE_H = 60;
const CIRCLE_SIZE = 80;

const isArrayField = (field: string): boolean => 
  ['source', 'target', 'inputs', 'outputs', 'customers'].includes(field);

const CompactSipoc: React.FC<{ title: string, items: string[], onClick: () => void }> = ({ title, items, onClick }) => (
  <div onClick={onClick} className="p-3 bg-slate-50 border rounded-xl cursor-pointer hover:border-brand-300 transition-all flex flex-col gap-1 shadow-sm">
    <span className="text-[8px] font-black text-slate-400 uppercase tracking-tighter">{title}</span>
    <div className="flex flex-wrap gap-1 overflow-hidden h-5">
      {items.length === 0 ? (
        <span className="text-[9px] text-slate-300 italic">待完善</span>
      ) : (
        items.map((it, i) => (
          <span key={i} className="text-[8px] font-bold bg-white px-1.5 py-0.5 rounded border border-slate-100 text-slate-600 truncate max-w-[50px]">{it}</span>
        ))
      )}
    </div>
  </div>
);

const filterRolesByKeyword = (roles: string[], keyword: string) => {
  const query = keyword.trim().toLowerCase();
  if (!query) return roles;
  return roles.filter(role => role.toLowerCase().includes(query));
};

const DetailedSipocCard: React.FC<{ title: string, items: string[], onClick: () => void }> = ({ title, items, onClick }) => {
  const visibleItems = items.slice(0, 3);
  const remainingCount = Math.max(items.length - visibleItems.length, 0);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full p-4 bg-slate-50 border rounded-2xl cursor-pointer hover:border-brand-300 transition-all flex flex-col gap-3 shadow-sm text-left"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{title}</span>
        <span className="text-[9px] font-black text-brand-600">{items.length} 项</span>
      </div>
      {items.length === 0 ? (
        <span className="text-[11px] text-slate-300 italic leading-relaxed">点击录入内容...</span>
      ) : (
        <div className="space-y-2">
          {visibleItems.map((item, index) => (
            <div
              key={`${title}-${index}-${item}`}
              className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-[11px] font-bold text-slate-600 leading-relaxed break-words line-clamp-2"
            >
              {item}
            </div>
          ))}
          {remainingCount > 0 && (
            <div className="text-[10px] font-black text-brand-600">另有 {remainingCount} 项，点击查看全部</div>
          )}
        </div>
      )}
    </button>
  );
};

interface LobbyProcessEntry {
  id: string;
  name: string;
  category: ProcessCategory;
  level: number;
  version: string;
  isActive: boolean;
  isVirtualSub?: boolean;
  parentName?: string;
  updatedAt: number;
  rootId: string;
  path: ProcessNode[];
}

const ProcessView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('process');
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
  const { LeaveModal } = useLeaveGuard(isDirty);
  const setIsDirty = state.setIsDirty;
  const backendError = state.backendError;
  const currentProcessId = state.currentProcessId;
  const setCurrentProcessId = state.setCurrentProcessId;

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [subProcessPath, setSubProcessPath] = useState<ProcessNode[]>([]);
  const [showNewModal, setShowNewModal] = useState<{ category: ProcessCategory, level: 1 | 2 } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [newProcName, setNewProcName] = useState('');
  const [publishVersion, setPublishVersion] = useState('');
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [editModal, setEditModal] = useState<{ nodeId: string, field: keyof SIPOC | 'label', title: string } | null>(null);
  const [dragInfo, setDragInfo] = useState<{ nodeId: string, startX: number, startY: number, nodeX: number, nodeY: number } | null>(null);
  const [localNodePos, setLocalNodePos] = useState<{ id: string, x: number, y: number } | null>(null);
  const [showOwnerRoleDropdown, setShowOwnerRoleDropdown] = useState(false);
  const [showAssistantRoleDropdown, setShowAssistantRoleDropdown] = useState(false);
  const [ownerRoleSearch, setOwnerRoleSearch] = useState('');
  const [assistantRoleSearch, setAssistantRoleSearch] = useState('');
  
  // Custom Modal states for confirmations
  const [confirmDeleteNode, setConfirmDeleteNode] = useState(false);
  const [confirmDeleteAssetId, setConfirmDeleteAssetId] = useState<string | null>(null);

  const currentProcess = useMemo(() => processes.find(p => p.id === currentProcessId), [processes, currentProcessId]);
  
  const { toastState, showToast, clearToast } = usePageToast();

  useEffect(() => {
    clearToast();
  }, [currentProcessId, clearToast]);

  const onSaveProcesses = async () => {
    const success = await handleSave(['processes']);
    if (success) {
      showToast('保存成功', 'success');
    }
  };
  const managedDepartmentIds = useMemo(() => {
    if (!currentUser) return [];
    return getManagedDepartmentIds(currentUser, departments);
  }, [currentUser, departments]);
  const canCreateProcess = useMemo(() => {
    if (!currentUser || !permissions.create) return false;
    if (currentUser.role === 'Admin') return true;
    return managedDepartmentIds.length > 0;
  }, [currentUser, managedDepartmentIds.length, permissions.create]);
  const canEditCurrentProcess = useMemo(() => {
    if (!currentUser || !currentProcess) return false;
    return permissions.update && canManageProcess(currentProcess, currentUser, state.systemRoles || [], departments);
  }, [currentProcess, currentUser, departments, permissions.update, state.systemRoles]);
  const canSaveProcessChanges = useMemo(() => {
    if (!currentUser) return false;
    if (currentProcess) return (permissions.update || permissions.create) && canPersistProcess(currentProcess, currentUser, state.systemRoles || [], departments);
    if (currentUser.role === 'Admin') return permissions.update || permissions.create;
    return (permissions.update || permissions.create) && managedDepartmentIds.length > 0;
  }, [currentProcess, currentUser, departments, managedDepartmentIds.length, permissions.create, permissions.update, state.systemRoles]);
  const canManageProcessEntry = useCallback((processId: string) => {
    if (!currentUser) return false;
    const targetProcess = processes.find((process) => process.id === processId);
    if (!targetProcess) return false;
    return permissions.update && canPersistProcess(targetProcess, currentUser, state.systemRoles || [], departments);
  }, [currentUser, departments, permissions.update, processes, state.systemRoles]);

  const availableRoles = useMemo(() => {
    const roles: string[] = [];
    const collect = (depts: Department[]) => {
      depts.forEach(d => {
        roles.push(...d.roles);
        if (d.subDepartments) collect(d.subDepartments);
      });
    };
    collect(departments);
    return Array.from(new Set(roles)).sort();
  }, [departments]);

  const allLobbyEntries = useMemo(() => {
    const entries: LobbyProcessEntry[] = [];
    const scanNodes = (nodes: ProcessNode[], root: ProcessDefinition, currentPath: ProcessNode[], parentName: string) => {
      nodes.forEach(node => {
        if (node.isSubProcess) {
          entries.push({ id: node.id, name: node.label, category: root.category, level: root.level, version: root.version, isActive: root.isActive, isVirtualSub: true, parentName: parentName, updatedAt: root.updatedAt, rootId: root.id, path: [...currentPath, node] });
          if (node.subProcessNodes) scanNodes(node.subProcessNodes, root, [...currentPath, node], node.label);
        }
      });
    };
    processes.forEach(p => {
      entries.push({ id: p.id, name: p.name, category: p.category, level: p.level, version: p.version, isActive: p.isActive, isVirtualSub: false, updatedAt: p.updatedAt, rootId: p.id, path: [] });
      scanNodes(p.nodes, p, [], p.name);
    });
    return entries;
  }, [processes]);

  const currentContext = useMemo(() => {
    if (!currentProcess) return { nodes: [], links: [] };
    let nodes = currentProcess.nodes;
    let links = currentProcess.links;
    for (const pathNode of subProcessPath) {
      const parent = nodes.find(n => n.id === pathNode.id);
      if (parent) { 
        nodes = parent.subProcessNodes || []; 
        links = parent.subProcessLinks || []; 
      }
    }
    return { nodes, links };
  }, [currentProcess, subProcessPath]);

  const selectedNode = useMemo(() => currentContext.nodes.find(n => n.id === selectedNodeId), [currentContext.nodes, selectedNodeId]);

  const filteredOwnerRoles = useMemo(() => {
    const matchedRoles = filterRolesByKeyword(availableRoles, ownerRoleSearch);
    const currentOwner = selectedNode?.sipoc.ownerRole;
    if (currentOwner && !matchedRoles.includes(currentOwner)) {
      return [currentOwner, ...matchedRoles];
    }
    return matchedRoles;
  }, [availableRoles, ownerRoleSearch, selectedNode?.sipoc.ownerRole]);

  const filteredAssistantRoles = useMemo(() => {
    const candidateRoles = availableRoles.filter(role => role !== selectedNode?.sipoc.ownerRole);
    const matchedRoles = filterRolesByKeyword(candidateRoles, assistantRoleSearch);
    const selectedAssistantRoles = (selectedNode?.sipoc.assistantRoles || []).filter(role => !matchedRoles.includes(role));
    return [...selectedAssistantRoles, ...matchedRoles];
  }, [availableRoles, selectedNode?.sipoc.ownerRole, selectedNode?.sipoc.assistantRoles, assistantRoleSearch]);

  useEffect(() => {
    setOwnerRoleSearch('');
    setAssistantRoleSearch('');
    setShowOwnerRoleDropdown(false);
    setShowAssistantRoleDropdown(false);
  }, [selectedNodeId]);

  const updateCurrentData = useCallback((newNodes: ProcessNode[], newLinks: ProcessLink[]) => {
    if (!currentProcessId || !currentProcess) return;
    
    if (subProcessPath.length === 0) {
      setProcessData(currentProcessId, newNodes, newLinks);
    } else {
      const recursiveUpdate = (list: ProcessNode[], depth: number): ProcessNode[] => {
        return list.map(n => {
          if (n.id === subProcessPath[depth].id) {
            if (depth === subProcessPath.length - 1) {
              return { ...n, subProcessNodes: newNodes, subProcessLinks: newLinks, isSubProcess: true };
            }
            return { ...n, subProcessNodes: recursiveUpdate(n.subProcessNodes || [], depth + 1) };
          }
          return n;
        });
      };
      setProcessData(currentProcessId, recursiveUpdate(currentProcess.nodes, 0), currentProcess.links);
    }
  }, [currentProcessId, subProcessPath, currentProcess, setProcessData]);

  const performDeleteNode = useCallback(() => {
    if (!selectedNodeId) return;
    
    const nextNodes = currentContext.nodes.filter(n => n.id !== selectedNodeId);
    const nextLinks = currentContext.links.filter(l => l.from !== selectedNodeId && l.to !== selectedNodeId);
    
    setSelectedNodeId(null);
    updateCurrentData(nextNodes, nextLinks);
    setConfirmDeleteNode(false);
  }, [selectedNodeId, currentContext, updateCurrentData]);

  const updateNode = useCallback((id: string, updates: Partial<ProcessNode>) => {
    const newNodes = currentContext.nodes.map(n => n.id === id ? { ...n, ...updates } : n);
    updateCurrentData(newNodes, currentContext.links);
  }, [currentContext, updateCurrentData]);

  const toggleAssistantRole = (role: string) => {
    if (!selectedNode) return;
    const currentRoles = selectedNode.sipoc.assistantRoles || [];
    const newRoles = currentRoles.includes(role) 
      ? currentRoles.filter(r => r !== role)
      : [...currentRoles, role];
    updateNode(selectedNode.id, { sipoc: { ...selectedNode.sipoc, assistantRoles: newRoles } });
  };

  const updateContainerProps = (props: { owner?: string, coOwner?: string, objective?: string, label?: string }) => {
    if (!currentProcess) return;

    if (subProcessPath.length === 0) {
      updateProcessProps(currentProcess.id, props);
    } else {
      const targetNode = subProcessPath[subProcessPath.length - 1];
      
      // Helper to recursively update node in tree
      const updateNodeInTree = (nodes: ProcessNode[]): ProcessNode[] => {
        return nodes.map(n => {
          if (n.id === targetNode.id) {
            return { ...n, ...props };
          }
          if (n.subProcessNodes) {
            return { ...n, subProcessNodes: updateNodeInTree(n.subProcessNodes) };
          }
          return n;
        });
      };

      const newNodes = updateNodeInTree(currentProcess.nodes);
      setProcessData(currentProcess.id, newNodes, currentProcess.links);
      
      // Update local state
      setSubProcessPath(prev => prev.map(n => n.id === targetNode.id ? { ...n, ...props } : n));
    }
  };

  const activeContainer = useMemo(() => {
    if (subProcessPath.length === 0) return currentProcess;
    return subProcessPath[subProcessPath.length - 1];
  }, [currentProcess, subProcessPath]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!dragInfo) return;
      const dx = e.clientX - dragInfo.startX;
      const dy = e.clientY - dragInfo.startY;
      setLocalNodePos({
        id: dragInfo.nodeId,
        x: Math.max(0, dragInfo.nodeX + dx),
        y: Math.max(0, dragInfo.nodeY + dy)
      });
    };
    const handleGlobalMouseUp = () => {
      if (dragInfo && localNodePos) {
        updateNode(localNodePos.id, { x: localNodePos.x, y: localNodePos.y });
      }
      setDragInfo(null);
      setLocalNodePos(null);
    };
    if (dragInfo) {
      window.addEventListener('mousemove', handleGlobalMouseMove);
      window.addEventListener('mouseup', handleGlobalMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [dragInfo, localNodePos, updateNode]);

  // Reset current process when leaving the view
  useEffect(() => {
    return () => {
      setCurrentProcessId(null);
    };
  }, [setCurrentProcessId]);

  const formatTime = (ts: number) => {
    if (!ts) return '-';
    const d = new Date(ts);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  if (!currentProcessId) {
    return (
      <div className="h-full overflow-y-auto p-10 custom-scrollbar max-w-7xl mx-auto space-y-12 pb-24">
        <header className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-4xl font-black text-slate-800 tracking-tighter">流程资产大厅</h1>
            <p className="text-slate-400 mt-2 font-bold uppercase tracking-widest text-[10px]">Value Streams & Enterprise Assets</p>
          </div>
          <button 
            onClick={onSaveProcesses} 
            disabled={isSaving || !canSaveProcessChanges} 
            className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase flex items-center gap-2 transition-all shadow-md ${isDirty ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-brand-100' : 'bg-slate-100 text-slate-400 cursor-default'}`}
          >
            {isSaving ? <Loader2 className="animate-spin" size={16}/> : <Save size={16} />} 
            {isDirty ? '立即保存' : '已是最新'}
          </button>
        </header>

        {CATEGORIES.map(cat => (
          <section key={cat} className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <h2 className="text-sm font-black text-brand-600 uppercase tracking-widest border-l-4 border-brand-600 pl-4 py-1">{cat}</h2>
                {canCreateProcess && (
            <button onClick={() => setShowNewModal({ category: cat, level: 2 })} className="flex items-center gap-1 text-xs font-bold text-slate-400 hover:text-brand-600 transition-all bg-slate-100 hover:bg-brand-50 px-3 py-1.5 rounded-full">创建二级流程 <Plus size={14}/></button>
          )}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {allLobbyEntries.filter(e => e.category === cat).map(entry => (
                <div key={entry.id} onClick={() => { setCurrentProcessId(entry.rootId); setSubProcessPath(entry.path); }} className={`group bg-white p-6 rounded-[2rem] border-2 shadow-sm hover:shadow-xl transition-all cursor-pointer relative overflow-hidden ${entry.isActive ? 'border-brand-100' : 'border-slate-100 opacity-70'}`}>
                  <div className="flex justify-between mb-2">
                    <span className={`px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest ${entry.isVirtualSub ? 'bg-brand-50 text-brand-600' : 'bg-slate-900 text-white'}`}>{entry.isVirtualSub ? `L${entry.level} - 子流程` : `L${entry.level} - 主流程`}</span>
                    <div className="flex items-center gap-2"><span className="text-[9px] font-bold text-slate-400">Ver: {entry.version}</span>{entry.isActive && <CheckCircle2 size={14} className="text-emerald-500"/>}</div>
                  </div>
                  <h3 className="text-xl font-black text-slate-800 tracking-tight group-hover:text-brand-600">{entry.name}</h3>
                  {entry.isVirtualSub && <p className="text-[10px] text-slate-400 mt-1 font-bold italic truncate">所属父级: {entry.parentName}</p>}
                  <div className="mt-4 pt-4 border-t flex items-center justify-between text-slate-400">
                    <span className="text-[10px] font-bold uppercase tracking-tighter flex items-center gap-1.5">
                      <Clock size={12} className="text-slate-300"/> 
                      {formatTime(entry.updatedAt)}
                    </span>
                    {canManageProcessEntry(entry.rootId) && !entry.isVirtualSub && (
                      <Trash2 
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteAssetId(entry.id); }} 
                        className="h-4 w-4 opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-all"
                      />
                    )}
                  </div>
                </div>
              ))}
              {canCreateProcess ? (
                <button onClick={() => setShowNewModal({ category: cat, level: 1 })} className="border-2 border-dashed border-slate-200 rounded-[2rem] p-8 text-slate-400 hover:text-brand-600 hover:border-brand-300 hover:bg-brand-50 transition-all font-black uppercase text-sm tracking-widest flex flex-col items-center justify-center gap-3 min-h-[160px]"><Plus size={28}/> 创建一级流程</button>
              ) : (
                <div className="border-2 border-dashed border-slate-100 rounded-[2rem] p-8 text-slate-300 font-black uppercase text-sm tracking-widest flex flex-col items-center justify-center gap-3 min-h-[160px]">
                  <Lock size={28}/> 无创建权限
                </div>
              )}
            </div>
          </section>
        ))}

        {showNewModal && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/90 backdrop-blur-sm">
            <div className="bg-white rounded-[2.5rem] w-full max-w-md p-10 shadow-2xl animate-in zoom-in-95">
              <h3 className="text-2xl font-black mb-2">创建流程资产</h3>
              <p className="text-xs text-slate-400 font-bold uppercase mb-8">{showNewModal.category} / Level {showNewModal.level}</p>
              <IMEInput autoFocus className="w-full p-5 bg-slate-50 border rounded-2xl mb-8 font-bold outline-none focus:border-brand-500" placeholder="资产名称..." value={newProcName} onChange={e => setNewProcName(e.target.value)} />
              <div className="flex gap-4">
                <button onClick={() => setShowNewModal(null)} className="flex-1 py-4 font-bold text-slate-500">取消</button>
                <button onClick={() => {
                  const created = addProcess(showNewModal.category, showNewModal.level, newProcName);
                  if (created) {
                    setShowNewModal(null);
                    setNewProcName('');
                  }
                }} className="flex-1 py-4 bg-brand-600 text-white rounded-2xl font-black shadow-lg">确认创建</button>
              </div>
            </div>
          </div>
        )}

        {/* Custom Confirmation for Asset Deletion */}
        {confirmDeleteAssetId && (
          <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-6">
            <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl text-center animate-in zoom-in-95">
               <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6"><Trash2 size={32}/></div>
               <h3 className="text-xl font-black mb-2">确认删除流程资产？</h3>
               <p className="text-xs text-slate-400 font-bold mb-8">删除后数据将永久丢失，不可恢复。</p>
               <div className="flex gap-3">
                  <button onClick={() => setConfirmDeleteAssetId(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-xs uppercase">取消</button>
                  <button onClick={() => { deleteProcess(confirmDeleteAssetId); setConfirmDeleteAssetId(null); }} className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-red-200">确认删除</button>
               </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-4 overflow-hidden relative">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-white p-3 rounded-2xl shadow-sm border border-slate-200 shrink-0 gap-3 md:gap-0">
        <div className="flex items-center gap-4 w-full md:w-auto overflow-x-auto no-scrollbar pb-1 md:pb-0">
          <button onClick={() => subProcessPath.length > 0 ? setSubProcessPath(subProcessPath.slice(0, -1)) : setCurrentProcessId(null)} className="p-2 hover:bg-slate-100 rounded-lg text-brand-600 font-bold flex items-center gap-1 text-xs shrink-0">
            <ChevronLeft size={16}/> {subProcessPath.length > 0 ? '返回上一级' : '返回大厅'}
          </button>
          <div className="flex items-center gap-2 text-xs font-black whitespace-nowrap">
             <span className="text-slate-400">{currentProcess?.name}</span>
             {subProcessPath.map(p => <React.Fragment key={p.id}><ChevronRight size={14}/><span className="text-brand-600">{p.label}</span></React.Fragment>)}
             <span className="ml-4 px-2 py-0.5 bg-slate-100 text-slate-400 rounded text-[9px] uppercase font-black">{currentProcess?.version}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto justify-end">
           <button onClick={() => setShowHistory(true)} className="p-2.5 text-slate-400 hover:text-brand-600 hover:bg-slate-50 rounded-xl transition-all" title="发布记录"><History size={18}/></button>
           <button onClick={() => setShowSettings(true)} className="p-2.5 text-slate-400 hover:text-brand-600 hover:bg-slate-50 rounded-xl transition-all" title="属性设置"><Settings size={18}/></button>
           <div className="hidden md:block w-px h-4 bg-slate-200 mx-2"></div>
           <button onClick={onSaveProcesses} disabled={isSaving || backendError || !canEditCurrentProcess} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase flex items-center gap-2 transition-all ${isDirty ? 'bg-brand-600 text-white hover:bg-brand-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} ${(backendError || !canEditCurrentProcess) ? 'opacity-50 cursor-not-allowed' : ''}`}>
             {isSaving ? <Loader2 className="animate-spin" size={14}/> : (backendError ? <WifiOff size={14}/> : <Save size={14} />)} {isDirty ? '立即保存' : '保存'}
           </button>
           <button disabled={!canEditCurrentProcess} onClick={() => setShowPublishModal(true)} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all ${canEditCurrentProcess ? 'bg-slate-900 text-white hover:bg-brand-600' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}><Send size={14}/> 发布生效</button>
        </div>
      </div>
      
      <div className="flex-1 flex flex-col md:flex-row gap-4 overflow-hidden">
        <div className="w-full md:w-20 h-20 md:h-auto bg-white border border-slate-200 rounded-3xl flex flex-row md:flex-col items-center justify-center md:py-6 gap-4 md:gap-6 shadow-sm shrink-0 overflow-x-auto px-4 md:px-0">
           {[
             { type: 'start', label: '开始', icon: <PlayCircle size={20} className="text-emerald-500"/> },
             { type: 'process', label: '节点', icon: <Layout size={20} className="text-slate-600"/> },
             { type: 'decision', label: '分支', icon: <GitMerge size={20} className="text-amber-500"/> },
             { type: 'end', label: '结束', icon: <StopCircle size={20} className="text-slate-900"/> }
           ].map(item => (
            <button key={item.type} disabled={!canEditCurrentProcess} onClick={() => {
              const newNode: ProcessNode = { 
                id: `node-${Date.now()}`, 
                label: item.type === 'start' ? '开始' : item.type === 'end' ? '结束' : item.type === 'decision' ? '条件判断' : '新环节', 
                type: item.type as any, x: 150, y: 150, description: '', sipoc: { source: [], target: [], inputs: [], outputs: [], customers: [], standard: '', ownerRole: '' }, subProcessNodes: [], subProcessLinks: [] 
              };
              updateCurrentData([...currentContext.nodes, newNode], currentContext.links);
              setSelectedNodeId(newNode.id);
            }} className="flex flex-col items-center gap-1 group disabled:opacity-30 shrink-0">
               <div className="w-10 h-10 md:w-12 md:h-12 flex items-center justify-center rounded-2xl bg-slate-50 border border-transparent group-hover:border-brand-200 group-hover:bg-brand-50 transition-all">{item.icon}</div>
               <span className="text-[10px] font-black text-slate-400 group-hover:text-brand-600 uppercase tracking-widest hidden md:block">{item.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 bg-white rounded-3xl border relative overflow-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:20px_20px]">
          <div className="min-w-[3000px] min-h-[3000px] relative p-32">
            <svg className="absolute inset-0 w-full h-full pointer-events-none">
              {currentContext.links.map(link => {
                const from = currentContext.nodes.find(n => n.id === link.from);
                const to = currentContext.nodes.find(n => n.id === link.to);
                if (!from || !to) return null;
                const fW = (from.type === 'start' || from.type === 'end') ? CIRCLE_SIZE : NODE_W;
                const fH = (from.type === 'start' || from.type === 'end') ? CIRCLE_SIZE : NODE_H;
                const tW = (to.type === 'start' || to.type === 'end') ? CIRCLE_SIZE : NODE_W;
                return <path key={link.id} d={`M ${from.x + fW/2} ${from.y + fH} C ${from.x + fW/2} ${from.y + fH + 60}, ${to.x + tW/2} ${to.y - 60}, ${to.x + tW/2} ${to.y}`} stroke="#cbd5e1" strokeWidth="2" fill="none" />;
              })}
            </svg>
            {currentContext.nodes.map(node => {
              const isDragging = localNodePos?.id === node.id;
              const displayX = isDragging ? localNodePos!.x : node.x;
              const displayY = isDragging ? localNodePos!.y : node.y;
              
              return (
                <div key={node.id} 
                  onMouseDown={(e) => { 
                    e.stopPropagation(); 
                    setSelectedNodeId(node.id); 
                    if (canEditCurrentProcess) {
                      setDragInfo({ nodeId: node.id, startX: e.clientX, startY: e.clientY, nodeX: node.x, nodeY: node.y }); 
                    }
                  }} 
                  style={{ left: displayX, top: displayY }}
                  className={`absolute flex flex-col items-center justify-center text-center transition-shadow
                    ${canEditCurrentProcess ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
                    ${(node.type === 'start' || node.type === 'end') ? 'w-[80px] h-[80px] rounded-full' : 'w-[170px] min-h-[60px] rounded-xl p-3'}
                    ${node.type === 'start' ? 'bg-emerald-500 text-white' : node.type === 'end' ? 'bg-slate-900 text-white' : node.type === 'decision' ? 'bg-amber-50 border-2 border-amber-400' : 'bg-white border-2 border-slate-100'}
                    ${selectedNodeId === node.id ? 'ring-4 ring-brand-500/20 border-brand-500 z-30 scale-105 shadow-xl' : 'z-10 shadow-sm'}
                    ${isDragging ? 'opacity-80 z-50 cursor-grabbing' : ''}
                  `}>
                  <h4 className="text-[10px] leading-tight font-black select-none">{node.label}</h4>
                  {node.sipoc.ownerRole && node.type !== 'start' && node.type !== 'decision' && node.type !== 'end' && (
                    <div className="absolute -bottom-2 right-2 bg-slate-900 text-white text-[7px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter">{node.sipoc.ownerRole}</div>
                  )}
                  {node.sipoc.assistantRoles && node.sipoc.assistantRoles.length > 0 && node.type !== 'start' && node.type !== 'decision' && node.type !== 'end' && (
                    <div className="absolute -bottom-6 flex gap-1 justify-center w-full flex-wrap px-2">
                      {node.sipoc.assistantRoles.map(r => (
                        <span key={r} className="bg-slate-200 text-slate-600 text-[6px] font-bold px-1 py-0.5 rounded uppercase tracking-tighter truncate max-w-[50px]">{r}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {selectedNode && (
          <div className="absolute md:relative inset-0 md:inset-auto z-50 md:z-auto w-full md:w-[380px] bg-white border border-slate-200 rounded-3xl shadow-xl flex flex-col animate-in slide-in-from-right duration-300">
            <div className="p-6 border-b flex justify-between items-center bg-slate-50/50 rounded-t-3xl">
              <div><span className="text-[9px] font-black text-brand-600 uppercase">环节属性 · {selectedNode.type}</span><h3 className="text-lg font-black truncate">{selectedNode.label}</h3></div>
              <button onClick={() => setSelectedNodeId(null)} className="p-2 hover:bg-slate-200 rounded-full"><X size={18}/></button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar pb-12">
              <div className="space-y-4">
                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">基础设置</label>
                <div className="flex gap-2">
                  <IMEInput className="flex-1 p-3 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-brand-500 disabled:opacity-50" value={selectedNode.label || ''} disabled={!canEditCurrentProcess} onChange={e => updateNode(selectedNode.id, { label: e.target.value })} />
                  {canEditCurrentProcess && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteNode(true); }} 
                      className="p-3 bg-red-50 text-red-500 rounded-xl hover:bg-red-100 transition-colors shadow-sm" 
                      title="删除环节"
                    >
                      <Trash2 size={16}/>
                    </button>
                  )}
                </div>
              </div>

              {selectedNode.type !== 'start' && selectedNode.type !== 'end' && (
                <>
                  <div className="space-y-4 relative">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">执行角色 (岗位)</label>
                    <div
                      className={`w-full p-3 bg-slate-50 border rounded-xl min-h-[42px] transition-all flex items-center justify-between gap-2 ${canEditCurrentProcess ? 'cursor-pointer hover:border-brand-300' : 'opacity-50 cursor-not-allowed'}`}
                      onClick={() => canEditCurrentProcess && setShowOwnerRoleDropdown(!showOwnerRoleDropdown)}
                    >
                      {selectedNode.sipoc.ownerRole ? (
                        <span className="text-xs font-bold text-slate-700">{selectedNode.sipoc.ownerRole}</span>
                      ) : (
                        <span className="text-xs text-slate-400 font-bold">选择执行角色...</span>
                      )}
                      <Search size={14} className="text-slate-300 shrink-0" />
                    </div>
                    {showOwnerRoleDropdown && (
                      <div className="absolute top-full left-0 w-full bg-white border border-slate-200 rounded-xl shadow-xl z-50 mt-2 p-2 animate-in zoom-in-95">
                        <div className="relative mb-2">
                          <IMEInput
                            className="w-full pl-10 pr-3 py-2.5 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-brand-500"
                            value={ownerRoleSearch}
                            placeholder="搜索执行角色..."
                            onChange={e => setOwnerRoleSearch(e.target.value)}
                          />
                          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
                        </div>
                        <div className="max-h-40 overflow-y-auto custom-scrollbar space-y-1">
                          <div
                            onClick={() => {
                              updateNode(selectedNode.id, { sipoc: { ...selectedNode.sipoc, ownerRole: '' } });
                              setShowOwnerRoleDropdown(false);
                              setOwnerRoleSearch('');
                            }}
                            className={`flex items-center justify-between p-2 rounded-lg text-xs font-bold cursor-pointer transition-all ${!selectedNode.sipoc.ownerRole ? 'bg-brand-50 text-brand-600' : 'hover:bg-slate-50 text-slate-600'}`}
                          >
                            未选择岗位
                            {!selectedNode.sipoc.ownerRole && <Check size={14} className="text-brand-600" />}
                          </div>
                          {filteredOwnerRoles.map(r => (
                            <div
                              key={r}
                              onClick={() => {
                                const newAssistantRoles = (selectedNode.sipoc.assistantRoles || []).filter(role => role !== r);
                                updateNode(selectedNode.id, { sipoc: { ...selectedNode.sipoc, ownerRole: r, assistantRoles: newAssistantRoles } });
                                setShowOwnerRoleDropdown(false);
                                setOwnerRoleSearch('');
                              }}
                              className={`flex items-center justify-between p-2 rounded-lg text-xs font-bold cursor-pointer transition-all ${selectedNode.sipoc.ownerRole === r ? 'bg-brand-50 text-brand-600' : 'hover:bg-slate-50 text-slate-600'}`}
                            >
                              {r}
                              {selectedNode.sipoc.ownerRole === r && <Check size={14} className="text-brand-600" />}
                            </div>
                          ))}
                          {availableRoles.length === 0 && <div className="text-center py-4 text-[10px] text-slate-400 italic">暂无岗位可选</div>}
                          {ownerRoleSearch.trim() && filteredOwnerRoles.length === 0 && <div className="text-center py-4 text-[10px] text-slate-400 italic">暂无匹配岗位</div>}
                        </div>
                      </div>
                    )}
                    {showOwnerRoleDropdown && (
                      <div className="fixed inset-0 z-40" onClick={() => setShowOwnerRoleDropdown(false)} />
                    )}
                  </div>

                  <div className="space-y-4 relative">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">辅助岗位 (多选)</label>
                    <div 
                      className={`w-full p-3 bg-slate-50 border rounded-xl min-h-[42px] transition-all flex flex-wrap gap-1 ${canEditCurrentProcess ? 'cursor-pointer hover:border-brand-300' : 'opacity-50 cursor-not-allowed'}`}
                      onClick={() => canEditCurrentProcess && setShowAssistantRoleDropdown(!showAssistantRoleDropdown)}
                    >
                      {(selectedNode.sipoc.assistantRoles && selectedNode.sipoc.assistantRoles.length > 0) ? (
                        selectedNode.sipoc.assistantRoles.map(r => (
                          <span key={r} className="text-[9px] font-bold bg-white border border-slate-200 px-1.5 py-0.5 rounded text-slate-600 flex items-center gap-1">
                            {r} {canEditCurrentProcess && <X size={10} className="hover:text-red-500" onClick={(e) => { e.stopPropagation(); toggleAssistantRole(r); }}/>}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-slate-400 font-bold">选择辅助角色...</span>
                      )}
                    </div>
                    
                    {showAssistantRoleDropdown && (
                      <div className="absolute top-full left-0 w-full bg-white border border-slate-200 rounded-xl shadow-xl z-50 mt-2 p-2 animate-in zoom-in-95">
                        <div className="relative mb-2">
                          <IMEInput
                            className="w-full pl-10 pr-3 py-2.5 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-brand-500"
                            value={assistantRoleSearch}
                            placeholder="搜索辅助岗位..."
                            onChange={e => setAssistantRoleSearch(e.target.value)}
                          />
                          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
                        </div>
                        <div className="max-h-40 overflow-y-auto custom-scrollbar space-y-1">
                        {filteredAssistantRoles.map(r => {
                          const isSelected = selectedNode.sipoc.assistantRoles?.includes(r);
                          return (
                            <div 
                              key={r} 
                              onClick={() => toggleAssistantRole(r)}
                              className={`flex items-center justify-between p-2 rounded-lg text-xs font-bold cursor-pointer transition-all ${isSelected ? 'bg-brand-50 text-brand-600' : 'hover:bg-slate-50 text-slate-600'}`}
                            >
                              {r}
                              {isSelected && <Check size={14} className="text-brand-600"/>}
                            </div>
                          );
                        })}
                        {availableRoles.filter(r => r !== selectedNode.sipoc.ownerRole).length === 0 && <div className="text-center py-4 text-[10px] text-slate-400 italic">暂无岗位可选</div>}
                        {assistantRoleSearch.trim() && filteredAssistantRoles.length === 0 && <div className="text-center py-4 text-[10px] text-slate-400 italic">暂无匹配岗位</div>}
                      </div>
                      </div>
                    )}
                    {showAssistantRoleDropdown && (
                      <div className="fixed inset-0 z-40" onClick={() => setShowAssistantRoleDropdown(false)}/>
                    )}
                  </div>
                </>
              )}

              {selectedNode.type === 'decision' && (
                <div className="space-y-4">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">判断逻辑描述</label>
                  <IMETextarea disabled={!canEditCurrentProcess} className="w-full p-4 bg-amber-50 border-2 border-amber-200 rounded-2xl text-xs font-bold outline-none resize-none h-32 shadow-inner disabled:opacity-50" placeholder="描述判断依据..." value={selectedNode.decisionDescription || ''} onChange={e => updateNode(selectedNode.id, { decisionDescription: e.target.value })} />
                </div>
              )}

              {selectedNode.type === 'process' && (
                <>
                  <div className="p-4 bg-slate-900 rounded-2xl text-white space-y-4">
                     <div className="flex justify-between items-center"><span className="text-[9px] font-black text-brand-400 uppercase">子流程嵌套</span><label className={`scale-75 inline-flex items-center ${canEditCurrentProcess ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}><input type="checkbox" disabled={!canEditCurrentProcess} checked={!!selectedNode.isSubProcess} onChange={e=>updateNode(selectedNode.id, {isSubProcess: e.target.checked})} className="sr-only peer"/><div className="w-11 h-6 bg-slate-700 rounded-full peer peer-checked:bg-brand-500 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full"></div></label></div>
                     {selectedNode.isSubProcess && <button onClick={() => setSubProcessPath([...subProcessPath, selectedNode])} className="w-full py-2 bg-white/10 rounded-xl text-[9px] font-black uppercase tracking-widest flex items-center justify-center gap-1">展开细化流程 <ArrowUpRight size={14}/></button>}
                  </div>
                  <div className="space-y-3">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">SIPOC 要素控制</label>
                    <div className="grid grid-cols-1 gap-3">
                        <DetailedSipocCard title="S - 来源" items={selectedNode.sipoc.source || []} onClick={() => canEditCurrentProcess && setEditModal({ nodeId: selectedNode.id, field: 'source', title: 'S - 来源对象' })} />
                        <DetailedSipocCard title="I - 输入" items={selectedNode.sipoc.inputs || []} onClick={() => canEditCurrentProcess && setEditModal({ nodeId: selectedNode.id, field: 'inputs', title: 'I - 输入要素' })} />
                        <DetailedSipocCard title="O - 输出" items={selectedNode.sipoc.outputs || []} onClick={() => canEditCurrentProcess && setEditModal({ nodeId: selectedNode.id, field: 'outputs', title: 'O - 输出产物' })} />
                        <DetailedSipocCard title="C - 输出对象" items={selectedNode.sipoc.customers || []} onClick={() => canEditCurrentProcess && setEditModal({ nodeId: selectedNode.id, field: 'customers', title: 'C - 输出对象' })} />
                    </div>
                    <div onClick={() => canEditCurrentProcess && setEditModal({ nodeId: selectedNode.id, field: 'standard', title: 'P - 作业标准' })} className={`p-4 bg-slate-50 border rounded-2xl transition-all ${canEditCurrentProcess ? 'cursor-pointer hover:border-brand-300' : 'opacity-70 cursor-default'}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[9px] font-black text-slate-400 uppercase">P - 作业标准</span>
                        <span className="text-[9px] font-black text-brand-600">{selectedNode.sipoc.standard ? '已填写' : '待填写'}</span>
                      </div>
                      <div className="text-[10px] mt-2 italic text-slate-500 leading-relaxed line-clamp-5" dangerouslySetInnerHTML={{ __html: selectedNode.sipoc.standard || "点击录入标准文档内容..." }} />
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-3">
                 <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">逻辑流转管理</label>
                 <div className="max-h-[160px] overflow-y-auto space-y-1.5 pr-2 custom-scrollbar">
                    {currentContext.nodes.filter(n => n.id !== selectedNode.id).map(n => {
                      const linked = currentContext.links.some(l => l.from === selectedNode.id && l.to === n.id);
                      return (
                        <div key={n.id} onClick={() => {
                          if (!canEditCurrentProcess) return;
                          const newLinks = linked ? currentContext.links.filter(l => !(l.from === selectedNode.id && l.to === n.id)) : [...currentContext.links, { id: `link-${Date.now()}`, from: selectedNode.id, to: n.id }];
                          updateCurrentData(currentContext.nodes, newLinks);
                        }} className={`flex justify-between items-center p-2 rounded-lg border text-[10px] font-bold transition-all ${canEditCurrentProcess ? 'cursor-pointer' : 'opacity-70 cursor-default'} ${linked ? 'bg-brand-50 border-brand-200 text-brand-700' : 'bg-white hover:border-slate-300 shadow-sm'}`}>
                          {n.label} <Plus size={12} className={linked ? 'rotate-45' : ''}/>
                        </div>
                      );
                    })}
                 </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {showSettings && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-[2.5rem] w-full max-w-lg p-10 shadow-2xl animate-in zoom-in-95">
             <div className="flex justify-between items-center mb-8">
                <div className="flex items-center gap-4"><div className="w-12 h-12 bg-brand-50 rounded-2xl flex items-center justify-center text-brand-600"><Info/></div><div><h3 className="text-xl font-black">资产属性设置</h3><p className="text-[9px] text-slate-400 uppercase font-black tracking-widest">Metadata Configuration</p></div></div>
                <button onClick={() => setShowSettings(false)} className="p-2 hover:bg-slate-100 rounded-full"><X/></button>
             </div>
             <div className="space-y-5">
                <div className="space-y-2">
                   <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Layout size={12}/> 流程资产名称</label>
                   <IMEInput disabled={!canEditCurrentProcess} className="w-full p-4 bg-slate-50 border rounded-2xl text-xs font-bold outline-none focus:border-brand-500 disabled:opacity-50" value={(subProcessPath.length === 0 ? (activeContainer as ProcessDefinition)?.name : (activeContainer as ProcessNode)?.label) || ''} onChange={e => {
                     if (subProcessPath.length === 0) {
                       updateProcessProps(currentProcessId!, { name: e.target.value });
                     } else {
                       updateContainerProps({ label: e.target.value });
                     }
                   }} placeholder="输入流程资产名称..."/>
                </div>
                <div className="space-y-2">
                   <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><User size={12}/> 主责任人</label>
                   <select disabled={!canEditCurrentProcess} className="w-full p-4 bg-slate-50 border rounded-2xl text-xs font-bold outline-none focus:border-brand-500 appearance-none disabled:opacity-50" value={activeContainer?.owner || ''} onChange={e=>updateContainerProps({ owner: e.target.value })}>
                     <option value="">选择主导负责人...</option>
                     {users.map(u => (
                       <option key={u.id} value={u.name}>{u.name}</option>
                     ))}
                   </select>
                </div>
                <div className="space-y-2">
                   <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Users size={12}/> 辅助责任人</label>
                   <select disabled={!canEditCurrentProcess} className="w-full p-4 bg-slate-50 border rounded-2xl text-xs font-bold outline-none focus:border-brand-500 appearance-none disabled:opacity-50" value={activeContainer?.coOwner || ''} onChange={e=>updateContainerProps({ coOwner: e.target.value })}>
                     <option value="">选择辅助参与人...</option>
                     {users.map(u => (
                       <option key={u.id} value={u.name}>{u.name}</option>
                     ))}
                   </select>
                </div>
                <div className="space-y-2">
                   <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Target size={12}/> 流程目标 (Objective)</label>
                   <IMETextarea disabled={!canEditCurrentProcess} className="w-full p-4 bg-slate-50 border rounded-2xl text-xs font-bold outline-none focus:border-brand-500 h-24 resize-none shadow-inner disabled:opacity-50" value={activeContainer?.objective || ''} onChange={e=>updateContainerProps({ objective: e.target.value })} placeholder="定义流程的核心产出目标与业务价值..."/>
                </div>
             </div>
             <button onClick={() => setShowSettings(false)} className="w-full mt-10 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl">保存资产属性</button>
          </div>
        </div>
      )}

      {editModal && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-[2.5rem] w-full max-w-md p-10 shadow-2xl">
            <h3 className="text-xl font-black mb-6">{editModal.title}</h3>
            {isArrayField(editModal.field) ? (
              <div className="space-y-4">
                <div className="flex gap-2">
                  <IMEInput 
                    id="sipoc-input"
                    className="flex-1 p-3 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-brand-500" 
                    placeholder="输入项并回车..." 
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const input = e.currentTarget;
                        if (!input.value.trim()) return;
                        const field = editModal.field as keyof SIPOC;
                        const currentItems = (selectedNode!.sipoc[field] as string[]) || [];
                        updateNode(selectedNode!.id, { sipoc: { ...selectedNode!.sipoc, [field]: [...currentItems, input.value.trim()] } });
                        input.value = '';
                      }
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto custom-scrollbar">
                  {((selectedNode!.sipoc[editModal.field as keyof SIPOC] as string[]) || []).map((it, idx) => (
                    <div key={idx} className="flex items-center gap-1.5 bg-brand-50 text-brand-700 px-3 py-1 rounded-lg text-xs font-bold border border-brand-100">
                      {it}
                      <button onClick={() => {
                        const field = editModal.field as keyof SIPOC;
                        const currentItems = (selectedNode!.sipoc[field] as string[]) || [];
                        updateNode(selectedNode!.id, { sipoc: { ...selectedNode!.sipoc, [field]: currentItems.filter((_, i) => i !== idx) } });
                      }} className="hover:text-red-500"><X size={12}/></button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <IMETextarea 
                className="w-full p-4 bg-slate-50 border rounded-2xl text-xs font-bold outline-none h-48 resize-none shadow-inner" 
                value={selectedNode!.sipoc.standard || ''} 
                onChange={e => updateNode(selectedNode!.id, { sipoc: { ...selectedNode!.sipoc, standard: e.target.value } })}
              />
            )}
            <button onClick={() => {
              // Save any pending input
              if (isArrayField(editModal.field)) {
                const input = document.getElementById('sipoc-input') as HTMLInputElement;
                if (input && input.value.trim()) {
                  const field = editModal.field as keyof SIPOC;
                  const currentItems = (selectedNode!.sipoc[field] as string[]) || [];
                  updateNode(selectedNode!.id, { sipoc: { ...selectedNode!.sipoc, [field]: [...currentItems, input.value.trim()] } });
                }
              }
              setEditModal(null);
            }} className="w-full mt-8 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-xs">完成编辑</button>
          </div>
        </div>
      )}

      {showPublishModal && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl">
            <h3 className="text-xl font-black mb-2">发布资产版本</h3>
            <p className="text-xs text-slate-400 font-bold uppercase mb-8 tracking-widest">Version Publication</p>
            <IMEInput 
              autoFocus 
              className="w-full p-4 bg-slate-50 border rounded-2xl mb-8 font-black outline-none focus:border-brand-500" 
              placeholder="版本号 (如 V1.0.1)..." 
              value={publishVersion} 
              onChange={e => setPublishVersion(e.target.value)} 
            />
            <div className="flex gap-4">
              <button onClick={() => setShowPublishModal(false)} className="flex-1 py-4 font-bold text-slate-500">取消</button>
              <button disabled={!canEditCurrentProcess} onClick={async () => { publishProcess(currentProcessId!, publishVersion); setShowPublishModal(false); setPublishVersion(''); }} className={`flex-1 py-4 rounded-2xl font-black shadow-lg ${canEditCurrentProcess ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'}`}>确认发布</button>
            </div>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-[2.5rem] w-full max-w-lg p-10 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center mb-8 shrink-0">
              <h3 className="text-xl font-black">发布历史记录</h3>
              <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-slate-100 rounded-full"><X/></button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
              {currentProcess?.history?.length === 0 ? (
                <div className="text-center py-10 text-slate-300 italic font-bold">暂无发布记录</div>
              ) : (
                currentProcess?.history.map(h => (
                  <div key={h.id} className="p-4 border rounded-2xl bg-slate-50 flex justify-between items-center group">
                    <div>
                      <div className="flex items-center gap-2"><span className="text-xs font-black bg-slate-900 text-white px-2 py-0.5 rounded">{h.version}</span><span className="text-[10px] text-slate-400 font-bold">{formatTime(h.publishedAt)}</span></div>
                      <p className="text-[10px] font-black text-slate-500 mt-1 uppercase tracking-widest">发布人: {h.publishedBy}</p>
                    </div>
                    <button disabled={!canEditCurrentProcess} onClick={() => { rollbackProcess(currentProcess!.id, h.id); setShowHistory(false); }} className={`opacity-0 group-hover:opacity-100 p-2 rounded-xl text-[10px] font-black uppercase flex items-center gap-1 transition-all ${canEditCurrentProcess ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-300 cursor-not-allowed'}`}><RotateCcw size={12}/> 回滚</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirmation for Node Deletion */}
      {confirmDeleteNode && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-6">
          <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl text-center animate-in zoom-in-95">
             <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6"><AlertTriangle size={32}/></div>
             <h3 className="text-xl font-black mb-2">确认删除该流程环节？</h3>
             <p className="text-xs text-slate-400 font-bold mb-8 uppercase tracking-widest">此操作将移除该节点及其所有关联连线</p>
             <div className="flex gap-3">
                <button onClick={() => setConfirmDeleteNode(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-xs uppercase">取消</button>
                <button onClick={performDeleteNode} className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-red-200">立即删除</button>
             </div>
          </div>
        </div>
      )}

      <PageToast
        visible={!!toastState}
        message={toastState?.message || ''}
        type={toastState?.type}
        onClose={clearToast}
      />
      {LeaveModal}
    </div>
  );
};

export default ProcessView;
