
import React, { useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { Department, ProcessNode, ProcessDefinition, User, MenuPermission } from '../types';
import { addDepartment as addDbDepartment, updateDepartment as updateDbDepartment, deleteDepartment as deleteDbDepartment } from '../data';
import { canManageDepartment, isAdminUser } from '../utils/permissions';
import { 
  Plus, Trash2, Building2, ChevronRight, X, Briefcase, ChevronDown, 
  ExternalLink, Search, User as UserIcon, Check, Minus, Save, WifiOff, CheckCircle, Info, Shield, Users, AlertCircle, Lock, Loader2
} from 'lucide-react';



const OrgView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('org');
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
  const [addingToId, setAddingToId] = useState<string | null>(null);
  const [editingAttrId, setEditingAttrId] = useState<string | null>(null);
  const [newSubDeptName, setNewSubDeptName] = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  
  // Separate state for Root Department Modal
  const [showAddRootModal, setShowAddRootModal] = useState(false);
  const [newRootDeptName, setNewRootDeptName] = useState('');

  const [pendingDeleteRole, setPendingDeleteRole] = useState<{deptId: string, roleName: string} | null>(null);
  const [pendingDeleteDept, setPendingDeleteDept] = useState<{id: string, name: string} | null>(null);
  const [assigningRole, setAssigningRole] = useState<{deptId: string, roleName: string} | null>(null);
  const [roleUserSearch, setRoleUserSearch] = useState('');
  const [editingRole, setEditingRole] = useState<{deptId: string, roleName: string} | null>(null);
  const [editingRoleName, setEditingRoleName] = useState('');

  // Helper to set dirty when modifying data
  const updateDepartments = (newDepts: Department[]) => {
    setDepartments(newDepts);
    setIsDirty(true);
  };

  const performDeleteRole = () => {
    if (!pendingDeleteRole) return;
    updateDepartments(updateDeptRecursive(departments, pendingDeleteRole.deptId, dep => ({ ...dep, roles: dep.roles.filter(role => role !== pendingDeleteRole.roleName) })));
    setPendingDeleteRole(null);
  };

  // ... (existing code)

  // In renderDeptCard:
  // <button onClick={(e) => { e.stopPropagation(); setPendingDeleteRole({deptId: d.id, roleName: r}); }} className="ml-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"><Minus size={10}/></button>

  // ... (existing code)



  // Search filter
  const [searchQuery, setSearchQuery] = useState('');

  const matchesSearch = (d: Department, query: string): boolean => {
    if (!query) return true;
    const lowerQuery = query.toLowerCase();
    if (d.name.toLowerCase().includes(lowerQuery)) return true;
    if (d.subDepartments && d.subDepartments.some(sub => matchesSearch(sub, query))) return true;
    return false;
  };

  const globalRoles = useMemo(() => {
    const roles = new Set<string>();
    const collect = (depts: Department[]) => {
      depts.forEach(d => {
        d.roles.forEach(r => roles.add(r));
        if (d.subDepartments) collect(d.subDepartments);
      });
    };
    collect(departments);
    return Array.from(roles).sort();
  }, [departments]);

  const canEditDepartment = (department: Department) =>
    !!currentUser && permissions.update && canManageDepartment(department, currentUser, state.systemRoles || []);

  const isAdmin = !!currentUser && isAdminUser(currentUser, state.systemRoles || []);
  const canEditDepartmentManager = (department: Department) => isAdmin && canEditDepartment(department);

  const updateDeptRecursive = (depts: Department[], id: string, updater: (d: Department) => Department): Department[] => {
    return depts.map(d => {
      if (d.id === id) return updater(d);
      if (d.subDepartments) return { ...d, subDepartments: updateDeptRecursive(d.subDepartments, id, updater) };
      return d;
    });
  };

  const deleteDeptFromTree = (depts: Department[], targetId: string): Department[] => {
    return depts
      .filter(d => d.id !== targetId) // Filter current level
      .map(d => ({
        ...d,
        subDepartments: d.subDepartments ? deleteDeptFromTree(d.subDepartments, targetId) : []
      }));
  };

  const findDeptById = (depts: Department[], id: string): Department | undefined => {
    for (const department of depts) {
      if (department.id === id) return department;
      if (department.subDepartments) {
        const found = findDeptById(department.subDepartments, id);
        if (found) return found;
      }
    }
    return undefined;
  };

  const addRootDepartment = () => {
    if (!newRootDeptName.trim()) return;
    const newDept: Department = { id: `dept-${Date.now()}`, name: newRootDeptName, roles: [], subDepartments: [], attributes: '', managerName: '', managerUserId: undefined, responsibilities: '' };
    updateDepartments([...departments, newDept]);
    setNewRootDeptName('');
    setShowAddRootModal(false);
  };

  const addSubDepartment = (parentId: string) => {
    if (!newSubDeptName.trim()) return;
    const newDept: Department = { id: `dept-${Date.now()}`, name: newSubDeptName, roles: [], subDepartments: [], attributes: '', managerName: '', managerUserId: undefined, responsibilities: '' };
    updateDepartments(updateDeptRecursive(departments, parentId, d => ({ ...d, subDepartments: [...(d.subDepartments || []), newDept] })));
    setNewSubDeptName('');
    setAddingToId(null);
  };

  const addRoleToDept = (deptId: string, roleName: string) => {
    if (!roleName.trim()) return;
    updateDepartments(updateDeptRecursive(departments, deptId, d => ({ ...d, roles: Array.from(new Set([...d.roles, roleName])) })));
    setNewRoleName('');
  };

  const updateRoleName = (deptId: string, oldRoleName: string, newRoleName: string) => {
    if (!newRoleName.trim() || oldRoleName === newRoleName) {
      setEditingRole(null);
      return;
    }
    updateDepartments(updateDeptRecursive(departments, deptId, d => {
      const newRoles = d.roles.map(r => r === oldRoleName ? newRoleName : r);
      const newRoleMembers = { ...(d.roleMembers || {}) };
      if (newRoleMembers[oldRoleName]) {
        newRoleMembers[newRoleName] = newRoleMembers[oldRoleName];
        delete newRoleMembers[oldRoleName];
      }
      return { ...d, roles: newRoles, roleMembers: newRoleMembers };
    }));
    setEditingRole(null);
  };

  const toggleRoleMember = (deptId: string, roleName: string, userId: string) => {
    updateDepartments(updateDeptRecursive(departments, deptId, d => {
      const currentMembers = d.roleMembers?.[roleName] || [];
      const newMembers = currentMembers.includes(userId)
        ? currentMembers.filter(id => id !== userId)
        : [...currentMembers, userId];
      return { 
        ...d, 
        roleMembers: { 
          ...(d.roleMembers || {}), 
          [roleName]: newMembers 
        } 
      };
    }));
  };

  const updateDeptField = (deptId: string, field: keyof Department, val: string) => {
    updateDepartments(updateDeptRecursive(departments, deptId, d => ({ ...d, [field]: val })));
  };

  const updateDeptManager = (deptId: string, managerUserId: string) => {
    const manager = users.find((user) => user.id === managerUserId);
    updateDepartments(updateDeptRecursive(departments, deptId, (department) => ({
      ...department,
      managerUserId: managerUserId || undefined,
      managerName: manager?.name || ''
    })));
  };

  const performDeleteDept = () => {
    if (!pendingDeleteDept) return;
    // Use the recursive delete function instead of simple filter
    updateDepartments(deleteDeptFromTree(departments, pendingDeleteDept.id));
    setPendingDeleteDept(null);
  };

  const renderDeptCard = (d: Department, depth = 0, isLast = false) => {
    if (!matchesSearch(d, searchQuery)) return null;

    return (
      <div key={d.id} className="relative w-full">
        {/* Tree Connector Lines for Children */}
        {depth > 0 && (
          <div className="absolute -left-8 top-12 w-8 h-px bg-slate-300"></div>
        )}
        
        <div className={`bg-white p-6 rounded-[2rem] border-2 shadow-sm hover:shadow-lg transition-all relative ${depth > 0 ? 'border-slate-100' : 'border-brand-100'}`}>
          <div className="flex justify-between items-start mb-4">
            <div className="flex-1">
              <h4 className="font-black text-xl tracking-tight text-slate-800 flex items-center gap-2">
                <Building2 className={depth === 0 ? "text-brand-600" : "text-slate-400"} size={18}/>
                {d.name}
              </h4>
              <div className="flex items-center gap-3 mt-1">
                <button onClick={() => setSelectedDeptId(selectedDeptId === d.id ? null : d.id)} className="text-[9px] font-black text-brand-600 uppercase hover:underline">岗位治理 ({d.roles.length})</button>
                <button onClick={() => setEditingAttrId(editingAttrId === d.id ? null : d.id)} className="text-[9px] font-black text-slate-400 uppercase hover:underline">负责人与职责</button>
              </div>
            </div>
            <div className="flex gap-1">
                  {isAdmin && (
                    <button onClick={() => setAddingToId(addingToId === d.id ? null : d.id)} className="p-2 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-xl" title="添加子部门"><Plus size={16}/></button>
                  )}
                  {isAdmin && (
                    <button onClick={() => setPendingDeleteDept({id: d.id, name: d.name})} className="p-2 text-slate-200 hover:text-red-500 hover:bg-red-50 rounded-xl"><Trash2 size={16}/></button>
                  )}
            </div>
          </div>

          {editingAttrId === d.id && (
            <div className="mb-4 space-y-4 animate-in slide-in-from-top-2">
              <div className="space-y-1">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><Building2 size={10}/> 部门名称</label>
                 <input 
                  className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold outline-none border-slate-200 focus:border-brand-500 disabled:opacity-50" 
                  placeholder="部门名称..." 
                  value={d.name || ''} 
                  disabled={!canEditDepartment(d)}
                  onChange={e => updateDeptField(d.id, 'name', e.target.value)} 
                />
              </div>
              <div className="space-y-1">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><UserIcon size={10}/> 部门负责人</label>
                 <select 
                  className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold outline-none border-slate-200 focus:border-brand-500 disabled:opacity-50" 
                  value={d.managerUserId || ''} 
                  disabled={!canEditDepartmentManager(d)}
                  onChange={e => updateDeptManager(d.id, e.target.value)} 
                >
                  <option value="">选择负责人...</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                {!isAdmin && canEditDepartment(d) && (
                  <p className="text-[9px] font-bold text-slate-400">部门负责人仅管理员可调整。</p>
                )}
              </div>
              <div className="space-y-1">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><Shield size={10}/> 核心权力与职责</label>
                 <textarea 
                  className="w-full p-3 bg-slate-900 text-slate-100 border-none rounded-2xl text-xs font-bold outline-none h-32 shadow-inner disabled:opacity-50" 
                  placeholder="详细描述该部门拥有的业务权力、资源分配权及核心交付职责..." 
                  value={d.responsibilities || ''} 
                  disabled={!canEditDepartment(d)}
                  onChange={e => updateDeptField(d.id, 'responsibilities', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><Info size={10}/> 职能属性描述</label>
                 <textarea 
                  className="w-full p-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold outline-none h-24 disabled:opacity-50" 
                  placeholder="部门属性、职能边界..." 
                  value={d.attributes || ''} 
                  disabled={!canEditDepartment(d)}
                  onChange={e => updateDeptField(d.id, 'attributes', e.target.value)}
                />
              </div>
              {canEditDepartment(d) && (
                <div className="flex justify-end pt-2">
                  <button 
                    onClick={() => {
                      setEditingAttrId(null);
                    }}
                    disabled={isSaving}
                    className={`px-6 py-2 rounded-xl font-black text-xs uppercase shadow-md transition-all flex items-center gap-2 disabled:opacity-50 ${isDirty ? 'bg-brand-600 text-white hover:bg-brand-700' : 'bg-slate-100 text-slate-400'}`}
                  >
                    {isSaving ? <Loader2 className="animate-spin" size={14}/> : <Save size={14}/>}
                    {isDirty ? '保存设置' : '已保存'}
                  </button>
                </div>
              )}
            </div>
          )}

          {addingToId === d.id && (
            <div className="mb-4 flex gap-2 animate-in slide-in-from-top-2">
              <input autoFocus className="flex-1 p-2 bg-slate-50 border rounded-xl text-xs font-bold outline-none border-brand-200" placeholder="子部门名称..." value={newSubDeptName} onChange={e => setNewSubDeptName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSubDepartment(d.id)} />
              <button onClick={() => addSubDepartment(d.id)} className="bg-brand-600 text-white p-2 rounded-xl"><Check size={16}/></button>
              <button onClick={() => setAddingToId(null)} className="bg-slate-200 text-slate-600 p-2 rounded-xl"><X size={16}/></button>
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-2">
            {d.roles.map(r => {
              const memberCount = d.roleMembers?.[r]?.length || 0;
              const isEditing = editingRole?.deptId === d.id && editingRole?.roleName === r;
              
              if (isEditing) {
                return (
                  <div key={r} className="px-3 py-1.5 rounded-xl border text-[10px] font-black flex items-center gap-2 bg-white border-brand-300">
                    <Briefcase size={10} className="text-brand-500"/>
                    <input 
                      autoFocus
                      className="outline-none bg-transparent w-24 text-brand-600"
                      value={editingRoleName || ''}
                      onChange={e => setEditingRoleName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') updateRoleName(d.id, r, editingRoleName);
                        if (e.key === 'Escape') setEditingRole(null);
                      }}
                      onBlur={() => updateRoleName(d.id, r, editingRoleName)}
                    />
                  </div>
                );
              }

              return (
                <div
                  key={r}
                  onClick={() => {
                    if (!canEditDepartment(d)) return;
                    setAssigningRole({ deptId: d.id, roleName: r });
                  }}
                  className={`px-3 py-1.5 rounded-xl border text-[10px] font-black flex items-center gap-2 transition-all group ${
                    canEditDepartment(d)
                      ? 'bg-slate-50 hover:border-brand-300 cursor-pointer'
                      : 'bg-slate-50 border-slate-200 cursor-not-allowed opacity-70'
                  }`}
                >
                  <Briefcase size={10} className="text-brand-500"/>
                  <span 
                    className="hover:underline"
                    onClick={(e) => {
                      if (!canEditDepartment(d)) return;
                      e.stopPropagation();
                      setEditingRole({deptId: d.id, roleName: r});
                      setEditingRoleName(r);
                    }}
                  >
                    {r}
                  </span>
                  <span className="bg-brand-500 text-white px-1.5 py-0.5 rounded-full text-[8px] font-black">{memberCount}</span>
                  {canEditDepartment(d) && (
                    <button onClick={(e) => { e.stopPropagation(); setPendingDeleteRole({deptId: d.id, roleName: r}); }} className="ml-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"><Minus size={10}/></button>
                  )}
                </div>
              );
            })}
          </div>

          {selectedDeptId === d.id && (
            <div className="mt-4 p-5 bg-slate-50 rounded-[2rem] animate-in fade-in border border-dashed border-slate-200">
              <div className="mb-4">
                 <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2">复用系统现有岗位</label>
                 <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pr-2 custom-scrollbar">
                    {globalRoles.filter(gr => !d.roles.includes(gr)).map(gr => (
                      <button key={gr} disabled={!canEditDepartment(d)} onClick={() => addRoleToDept(d.id, gr)} className="px-2 py-1 bg-white border border-slate-100 rounded-lg text-[9px] font-bold hover:border-brand-500 transition-colors disabled:opacity-50">{gr}</button>
                    ))}
                 </div>
              </div>
              <div className="flex gap-2">
                <input className="flex-1 p-3 bg-white border rounded-xl text-xs font-bold outline-none focus:border-brand-500 shadow-inner disabled:opacity-50" placeholder="新增岗位名称..." value={newRoleName} disabled={!canEditDepartment(d)} onChange={e=>setNewRoleName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addRoleToDept(d.id, newRoleName)}/>
                <button onClick={() => addRoleToDept(d.id, newRoleName)} disabled={!canEditDepartment(d)} className="bg-slate-900 text-white px-5 py-2 rounded-xl text-[10px] font-black uppercase disabled:opacity-50">添加新岗位</button>
              </div>
            </div>
          )}
        </div>
        
        {/* Render Children */}
        {d.subDepartments && d.subDepartments.length > 0 && (
          <div className="ml-8 pl-8 border-l-2 border-slate-200 mt-8 space-y-8 relative">
             {d.subDepartments.map((sub, idx) => renderDeptCard(sub, depth + 1, idx === d.subDepartments.length - 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col gap-4 md:gap-6 overflow-hidden p-4 md:p-6 bg-slate-50 relative">
      <div className="bg-white p-4 md:p-6 rounded-[2.5rem] border shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div><h2 className="text-xl font-black text-slate-800">组织资产架构</h2><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Departments, Roles & Responsibilities</p></div>
        <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-center w-full md:w-auto">
           <div className="relative w-full md:w-auto"><input className="pl-10 pr-4 py-2.5 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-brand-500 w-full md:w-64 shadow-inner" placeholder="搜索部门..." value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}/><Search size={14} className="absolute left-4 top-3.5 text-slate-300"/></div>
           <div className="flex gap-2 w-full md:w-auto">
             <button disabled={!isAdmin} onClick={() => setShowAddRootModal(true)} className={`flex-1 md:flex-none justify-center px-6 py-2.5 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-2 border ${isAdmin ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 border-slate-200' : 'bg-slate-100 text-slate-300 border-slate-100 cursor-not-allowed'}`}><Plus size={16}/> 创建根部门</button>
             {(permissions.update || isAdmin) && (
               <button 
                 onClick={() => handleSave(['departments'])} 
                 disabled={isSaving || (!isAdmin && !currentUser)} 
                 className={`flex-1 md:flex-none justify-center px-6 py-2.5 rounded-xl text-xs font-black uppercase flex items-center gap-2 transition-all shadow-md ${showSaveSuccess ? 'bg-emerald-50 text-emerald-600' : isDirty ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-brand-100' : 'bg-slate-100 text-slate-400 cursor-default'} ${(!isAdmin && !currentUser) ? 'opacity-50 cursor-not-allowed' : ''}`}
               >
                 {isSaving ? <Loader2 className="animate-spin" size={16}/> : showSaveSuccess ? <CheckCircle size={16}/> : <Save size={16} />} 
                 {showSaveSuccess ? '已保存' : isDirty ? '立即保存' : '已是最新'}
               </button>
             )}
           </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pr-2 md:pr-4 custom-scrollbar pb-24">
        <div className="flex flex-col gap-8 items-start pl-2 md:pl-4">
          {departments.map((d, index, arr) => renderDeptCard(d, 0, index === arr.length - 1))}
          {departments.length > 0 && departments.every(d => !matchesSearch(d, searchQuery)) && (
            <div className="w-full py-20 text-center">
              <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300">
                <Search size={32}/>
              </div>
              <p className="text-slate-400 font-bold text-sm">未找到匹配的部门</p>
            </div>
          )}
          {departments.length === 0 && (
            <div className="w-full py-20 text-center bg-white rounded-[3rem] border-2 border-dashed border-slate-200">
              <div className="w-16 h-16 bg-brand-50 rounded-full flex items-center justify-center mx-auto mb-4 text-brand-600">
                <Building2 size={32}/>
              </div>
              <p className="text-slate-400 font-bold text-sm mb-4">暂无组织架构数据</p>
              <button onClick={() => setShowAddRootModal(true)} className="px-6 py-2 bg-brand-600 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-brand-100">立即创建根部门</button>
            </div>
          )}
        </div>
      </div>

      {showAddRootModal && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-6">
          <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl animate-in zoom-in-95">
             <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black">创建根部门</h3>
                <button onClick={() => setShowAddRootModal(false)} className="p-2 hover:bg-slate-100 rounded-full"><X/></button>
             </div>
             <p className="text-xs text-slate-400 font-bold mb-6">创建一个新的顶级部门节点。创建后请点击页面右上角的保存按钮生效。</p>
             <input autoFocus className="w-full p-4 bg-slate-50 border rounded-2xl mb-6 text-sm font-bold outline-none focus:border-brand-500" placeholder="部门名称..." value={newRootDeptName} onChange={e => setNewRootDeptName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addRootDepartment()} />
             <button onClick={addRootDepartment} className="w-full py-4 bg-brand-600 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-brand-700 transition-all">
                立即创建
             </button>
          </div>
        </div>
      )}

      {assigningRole && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-6">
          <div className="bg-white rounded-[2.5rem] w-full max-w-md p-10 shadow-2xl animate-in zoom-in-95">
            {(() => {
              const assigningDepartment = findDeptById(departments, assigningRole.deptId);
              const canAssignRoleMembers = !!assigningDepartment && canEditDepartment(assigningDepartment);
              return (
                <>
             <div className="flex justify-between items-center mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-brand-50 text-brand-600 rounded-2xl flex items-center justify-center"><Users size={24}/></div>
                  <div>
                    <h3 className="text-xl font-black">{assigningRole.roleName}</h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">分配岗位成员 (岗位人选)</p>
                  </div>
                </div>
                <button onClick={() => { setAssigningRole(null); setRoleUserSearch(''); }} className="p-2 hover:bg-slate-100 rounded-full"><X/></button>
             </div>
             
             <div className="mb-4 relative">
               <input 
                 type="text" 
                 placeholder="搜索人员..." 
                 value={roleUserSearch || ''}
                 onChange={(e) => setRoleUserSearch(e.target.value)}
                 className="w-full pl-10 pr-4 py-3 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-brand-500 shadow-inner"
               />
               <Search size={14} className="absolute left-4 top-4 text-slate-300"/>
             </div>
             
             <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                {users.length === 0 ? (
                  <p className="text-center py-10 text-slate-300 text-xs italic">请先在“用户管理”中创建系统用户</p>
                ) : users.filter(u => u.name.toLowerCase().includes(roleUserSearch.toLowerCase()) || u.username.toLowerCase().includes(roleUserSearch.toLowerCase())).map(u => {
                  const isAssigned = assigningDepartment?.roleMembers?.[assigningRole.roleName]?.includes(u.id);
                  return (
                    <button 
                      key={u.id} 
                      disabled={!canAssignRoleMembers}
                      onClick={() => toggleRoleMember(assigningRole.deptId, assigningRole.roleName, u.id)}
                      className={`w-full flex items-center justify-between p-3 rounded-2xl border transition-all ${
                        isAssigned ? 'bg-brand-50 border-brand-200' : 'bg-white hover:bg-slate-50 border-slate-100'
                      } ${!canAssignRoleMembers ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-black ${isAssigned ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                          {u.name.charAt(0)}
                        </div>
                        <div className="text-left">
                          <p className={`text-xs font-black ${isAssigned ? 'text-brand-900' : 'text-slate-600'}`}>{u.name}</p>
                          <p className="text-[8px] font-bold text-slate-400 uppercase">{u.username}</p>
                        </div>
                      </div>
                      {isAssigned ? <Check size={16} className="text-brand-600"/> : <Plus size={16} className="text-slate-300"/>}
                    </button>
                  );
                })}
             </div>

             {!canAssignRoleMembers && (
               <p className="mt-4 text-[10px] font-bold text-slate-400">仅管理员或负责该部门的部门长可调整岗位成员。</p>
             )}

             <button onClick={() => setAssigningRole(null)} className="w-full mt-10 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-brand-600 transition-all">
                完成分配 (需保存生效)
             </button>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {pendingDeleteRole && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-6">
          <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl text-center animate-in zoom-in-95">
             <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6"><AlertCircle size={32}/></div>
             <h3 className="text-xl font-black mb-2 text-slate-800">移除岗位 [{pendingDeleteRole.roleName}]？</h3>
             <p className="text-xs text-slate-400 font-bold mb-8">移除后该岗位的成员分配也将失效。</p>
             <div className="flex gap-3">
                <button onClick={() => setPendingDeleteRole(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-xs uppercase">取消</button>
                <button onClick={performDeleteRole} className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-red-200">确认移除</button>
             </div>
          </div>
        </div>
      )}

      {pendingDeleteDept && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-6">
          <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl text-center animate-in zoom-in-95">
             <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6"><AlertCircle size={32}/></div>
             <h3 className="text-xl font-black mb-2 text-slate-800">删除部门 [{pendingDeleteDept.name}]？</h3>
             <p className="text-xs text-slate-400 font-bold mb-8">此操作将移除该部门及其下属所有组织单元，不可恢复。</p>
             <div className="flex gap-3">
                <button onClick={() => setPendingDeleteDept(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-xs uppercase">取消</button>
                <button onClick={performDeleteDept} className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-red-200">确认删除</button>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OrgView;
