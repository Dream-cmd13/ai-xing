import React, { useState, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, SystemRole, User, MenuPermission, Department } from '../types';
import { MENU_GROUPS, ALL_MENU_ITEMS } from '../constants';
import { Shield, Users, Plus, Edit2, Trash2, Check, X, Save, Lock, Building2, CheckCircle, Unlock, Loader2, AlertCircle } from 'lucide-react';



const MenuPermissionView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('menu-permissions');
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

  const [activeTab, setActiveTab] = useState<'roles' | 'users'>('roles');
  const [userSubTab, setUserSubTab] = useState<'menu' | 'dept'>('menu');
  const [editingRole, setEditingRole] = useState<SystemRole | null>(null);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [pendingDeleteRoleId, setPendingDeleteRoleId] = useState<string | null>(null);

  const roles = state.systemRoles || [];
  const users = state.users || [];

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

  if (!permissions.view) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center bg-white p-12 rounded-[3rem] border shadow-sm">
          <Lock size={64} className="mx-auto text-slate-200 mb-6"/>
          <h2 className="text-xl font-black text-slate-800">权限不足</h2>
          <p className="text-slate-400 text-sm mt-2">您没有访问权限管理中心的权限。</p>
        </div>
      </div>
    );
  }

  const handleAddRole = () => {
    setEditingRole({
      id: `role-${Date.now()}`,
      name: '新角色',
      description: '',
      permissions: {}
    });
  };

  const handleSaveRole = () => {
    if (!editingRole) return;
    const newRoles = roles.some(r => r.id === editingRole.id)
      ? roles.map(r => r.id === editingRole.id ? editingRole : r)
      : [...roles, editingRole];
    setSystemRoles(newRoles);
    setIsDirty(true);
    setEditingRole(null);
  };

  const handleDeleteRole = (id: string) => {
    setPendingDeleteRoleId(id);
  };

  const confirmDeleteRole = () => {
    if (!pendingDeleteRoleId) return;
    setSystemRoles(roles.filter(r => r.id !== pendingDeleteRoleId));
    setIsDirty(true);
    setPendingDeleteRoleId(null);
  };

  const handleSaveUser = () => {
    if (!editingUser) return;
    setUsers(users.map(u => u.id === editingUser.id ? editingUser : u));
    setIsDirty(true);
    setEditingUser(null);
  };

  const togglePermission = (
    target: 'role' | 'user',
    menuId: string,
    field: keyof MenuPermission,
    value: boolean
  ) => {
    if (target === 'role' && editingRole) {
      const currentPerms = editingRole.permissions[menuId] || { view: false, create: false, update: false };
      const newPerms = { ...currentPerms, [field]: value };
      
      // If create or update is checked, view must be checked
      if (value && (field === 'create' || field === 'update')) {
        newPerms.view = true;
      }
      // If view is unchecked, uncheck create and update
      if (!value && field === 'view') {
        newPerms.create = false;
        newPerms.update = false;
      }
      
      setEditingRole({ 
        ...editingRole, 
        permissions: { 
          ...editingRole.permissions, 
          [menuId]: newPerms 
        } 
      });
    } else if (target === 'user' && editingUser) {
      const currentPerms = (editingUser.customPermissions || {})[menuId] || { view: false, create: false, update: false };
      const newPerms = { ...currentPerms, [field]: value };
      
      if (value && (field === 'create' || field === 'update')) {
        newPerms.view = true;
      }
      if (!value && field === 'view') {
        newPerms.create = false;
        newPerms.update = false;
      }
      
      setEditingUser({ 
        ...editingUser, 
        customPermissions: { 
          ...(editingUser.customPermissions || {}), 
          [menuId]: newPerms 
        } 
      });
    }
  };

  const togglePadPermission = (deptId: string) => {
    if (!editingUser) return;
    const currentPerms = editingUser.padPermissions || [];
    const newPerms = currentPerms.includes(deptId) 
      ? currentPerms.filter(id => id !== deptId)
      : [...currentPerms, deptId];
    setEditingUser({ ...editingUser, padPermissions: newPerms });
  };

  const clearCustomPermission = (menuId: string) => {
    if (!editingUser || !editingUser.customPermissions) return;
    const newCustomPerms = { ...editingUser.customPermissions };
    delete newCustomPerms[menuId];
    setEditingUser({ ...editingUser, customPermissions: newCustomPerms });
  };

  const renderPermissionTable = (
    permsData: Record<string, MenuPermission>,
    target: 'role' | 'user'
  ) => (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            <th className="p-4 font-bold text-slate-700">功能模块</th>
            <th className="p-4 font-bold text-slate-700 text-center">查看</th>
            <th className="p-4 font-bold text-slate-700 text-center">新增</th>
            <th className="p-4 font-bold text-slate-700 text-center">修改</th>
            {target === 'user' && <th className="p-4 font-bold text-slate-700 text-center">操作</th>}
          </tr>
        </thead>
        <tbody>
          {MENU_GROUPS.map(group => (
            <React.Fragment key={group.id}>
              <tr className="bg-slate-100/50">
                <td colSpan={target === 'user' ? 5 : 4} className="p-3 font-black text-slate-800 text-xs uppercase tracking-wider">
                  {group.label}
                </td>
              </tr>
              {group.items.map(item => {
                const hasCustom = target === 'user' && editingUser?.customPermissions && item.id in editingUser.customPermissions;
                const perm = permsData[item.id] || { view: false, create: false, update: false };
                
                // Define which permissions are available for each menu item
                const availablePerms = {
                  view: true,
                  create: ['process', 'org', 'task-center', 'review', 'user'].includes(item.id),
                  update: !['roles', 'okr-review', 'workbench'].includes(item.id)
                };

                return (
                  <tr key={item.id} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors ${hasCustom ? 'bg-brand-50/30' : ''}`}>
                    <td className="p-4 font-medium text-slate-700 pl-8">
                      {item.label}
                      {hasCustom && <span className="ml-2 text-[9px] bg-brand-100 text-brand-600 px-1.5 py-0.5 rounded-md font-bold">已覆盖</span>}
                    </td>
                    <td className="p-4 text-center">
                      <input 
                        type="checkbox" 
                        checked={perm.view}
                        disabled={!permissions.update}
                        onChange={(e) => togglePermission(target, item.id, 'view', e.target.checked)}
                        className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                      />
                    </td>
                    <td className="p-4 text-center">
                      {availablePerms.create ? (
                        <input 
                          type="checkbox" 
                          checked={perm.create}
                          disabled={!permissions.update}
                          onChange={(e) => togglePermission(target, item.id, 'create', e.target.checked)}
                          className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                        />
                      ) : (
                        <span className="text-slate-200">-</span>
                      )}
                    </td>
                    <td className="p-4 text-center">
                      {availablePerms.update ? (
                        <input 
                          type="checkbox" 
                          checked={perm.update}
                          disabled={!permissions.update}
                          onChange={(e) => togglePermission(target, item.id, 'update', e.target.checked)}
                          className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                        />
                      ) : (
                        <span className="text-slate-200">-</span>
                      )}
                    </td>
                    {target === 'user' && (
                      <td className="p-4 text-center">
                        {hasCustom && (
                          <button
                            onClick={() => clearCustomPermission(item.id)}
                            disabled={!permissions.update}
                            className="text-[10px] font-bold text-slate-400 hover:text-red-500 transition-colors disabled:opacity-50"
                          >
                            清除覆盖
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );

  const renderDeptPermissionGrid = () => {
    const renderDeptTree = (depts: Department[], depth: number = 0) => {
      return depts.map(d => (
        <div key={d.id} className="space-y-2" style={{ paddingLeft: `${depth * 20}px` }}>
          <button 
            disabled={!permissions.update}
            onClick={() => togglePadPermission(d.id)}
            className={`w-full px-4 py-3 rounded-2xl border text-left flex items-center justify-between transition-all ${editingUser?.padPermissions?.includes(d.id) ? 'bg-brand-50 border-brand-200 text-brand-700 shadow-inner' : 'bg-slate-50 border-transparent text-slate-400'} ${!permissions.update ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <div className="flex items-center gap-2 overflow-hidden">
              <Building2 size={14} className={editingUser?.padPermissions?.includes(d.id) ? 'text-brand-500' : 'text-slate-300'} />
              <span className="text-[11px] font-black truncate">{d.name}</span>
            </div>
            {editingUser?.padPermissions?.includes(d.id) ? <CheckCircle size={14} className="text-brand-500"/> : <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-200"/>}
          </button>
          {d.subDepartments && renderDeptTree(d.subDepartments, depth + 1)}
        </div>
      ));
    };

    return (
      <div className="space-y-6">
        <div className="bg-brand-50 p-4 rounded-xl border border-brand-100 flex items-start gap-3">
          <Unlock className="text-brand-600 shrink-0 mt-0.5" size={18} />
          <div>
            <h4 className="text-sm font-bold text-brand-800">PAD 治理可见性配置</h4>
            <p className="text-xs text-brand-600 mt-1">配置用户可以查看哪些部门的 PAD 治理数据。勾选后，该用户在“治理中心”和“任务中心”中将能看到对应部门的数据。</p>
          </div>
        </div>
        <div className="space-y-3">
          {renderDeptTree(state.departments)}
        </div>
        {state.departments.length === 0 && (
          <div className="text-center p-12 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400">
            <Building2 size={48} className="mx-auto mb-4 opacity-20" />
            <p className="text-sm">请先在组织架构中添加部门</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-slate-50/50 relative">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center p-4 md:p-8 pb-4 gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-black text-slate-800 tracking-tight flex items-center gap-3">
            <Shield className="text-brand-600" size={28} />
            权限管理
          </h2>
          <p className="text-slate-500 mt-2 text-xs md:text-sm font-medium">管理系统角色和用户的菜单访问权限</p>
        </div>
        <div className="flex items-center gap-4">
          {permissions.update && (
            <button 
              onClick={() => handleSave(['users', 'systemRoles'])} 
              disabled={isSaving} 
              className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase flex items-center gap-2 transition-all shadow-md ${showSaveSuccess ? 'bg-emerald-50 text-emerald-600' : isDirty ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-brand-100' : 'bg-slate-100 text-slate-400 cursor-default'}`}
            >
              {isSaving ? <Loader2 className="animate-spin" size={16}/> : showSaveSuccess ? <CheckCircle size={16}/> : <Save size={16} />} 
              {showSaveSuccess ? '已保存' : isDirty ? '立即保存' : '已是最新'}
            </button>
          )}
        </div>
      </div>

      <div className="px-4 md:px-8 pb-4">
        <div className="flex gap-4 border-b border-slate-200">
          <button
            onClick={() => { setActiveTab('roles'); setEditingRole(null); setEditingUser(null); }}
            className={`px-4 md:px-6 py-3 font-bold text-sm border-b-2 transition-colors ${activeTab === 'roles' ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            角色权限
          </button>
          <button
            onClick={() => { setActiveTab('users'); setEditingRole(null); setEditingUser(null); }}
            className={`px-4 md:px-6 py-3 font-bold text-sm border-b-2 transition-colors ${activeTab === 'users' ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            个人权限管理
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-8 pt-4 custom-scrollbar">
        {activeTab === 'roles' && (
          <div className="flex flex-col md:flex-row gap-4 md:gap-8">
            <div className={`w-full md:w-1/3 flex flex-col gap-4 ${editingRole ? 'hidden md:flex' : 'flex'}`}>
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-slate-800">系统角色</h3>
                {permissions.create && (
                  <button onClick={handleAddRole} className="p-2 text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                    <Plus size={20} />
                  </button>
                )}
              </div>
              <div className="space-y-3">
                {roles.map(role => (
                  <div 
                    key={role.id}
                    onClick={() => setEditingRole(role)}
                    className={`p-4 rounded-xl border cursor-pointer transition-all ${editingRole?.id === role.id ? 'bg-brand-50 border-brand-200 shadow-sm' : 'bg-white border-slate-200 hover:border-brand-300'}`}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-bold text-slate-800">{role.name}</h4>
                        <p className="text-xs text-slate-500 mt-1">{role.description || '无描述'}</p>
                      </div>
                      {permissions.update && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleDeleteRole(role.id); }}
                          className="text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {roles.length === 0 && (
                  <div className="text-center p-8 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 text-sm">
                    暂无角色，点击右上角添加
                  </div>
                )}
              </div>
            </div>

            <div className={`w-full md:w-2/3 bg-white rounded-2xl border border-slate-200 p-4 md:p-6 shadow-sm ${!editingRole ? 'hidden md:block' : 'block'}`}>
              {editingRole ? (
                <div className="space-y-6">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <h3 className="font-bold text-lg text-slate-800">编辑角色: {editingRole.name}</h3>
                    <div className="flex gap-2 w-full md:w-auto">
                      <button onClick={() => setEditingRole(null)} className="flex-1 md:flex-none px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg font-medium text-sm transition-colors">取消</button>
                      <button onClick={handleSaveRole} className="flex-1 md:flex-none px-4 py-2 bg-brand-600 text-white rounded-lg font-medium text-sm hover:bg-brand-700 transition-colors">应用更改</button>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-2">角色名称</label>
                      <input 
                        type="text" 
                        value={editingRole.name || ''}
                        onChange={e => setEditingRole({...editingRole, name: e.target.value})}
                        className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-brand-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-2">角色描述</label>
                      <input 
                        type="text" 
                        value={editingRole.description || ''}
                        onChange={e => setEditingRole({...editingRole, description: e.target.value})}
                        className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-brand-500"
                      />
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <label className="block text-xs font-bold text-slate-500 mb-3">菜单权限分配</label>
                    <div className="min-w-[500px]">
                      {renderPermissionTable(editingRole.permissions, 'role')}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-400">
                  <Shield size={48} className="mb-4 opacity-20" />
                  <p>请选择一个角色进行编辑</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'users' && (
          <div className="flex flex-col md:flex-row gap-4 md:gap-8">
            <div className={`w-full md:w-1/3 flex flex-col gap-4 ${editingUser ? 'hidden md:flex' : 'flex'}`}>
              <h3 className="font-bold text-slate-800">用户列表</h3>
              <div className="space-y-4 overflow-y-auto pr-2 custom-scrollbar">
                {(() => {
                  const renderUserTree = (depts: Department[], depth: number = 0) => {
                    return depts.map(d => {
                      const deptUsers = users.filter(u => u.departmentId === d.id);
                      return (
                        <div key={d.id} className="space-y-2" style={{ paddingLeft: depth === 0 ? 0 : '16px' }}>
                          <div className="flex items-center gap-2 py-2 text-slate-700 font-bold text-sm border-b border-slate-100">
                            <Building2 size={16} className="text-brand-500" />
                            <span>{d.name}</span>
                          </div>
                          <div className="space-y-2 pl-2">
                            {deptUsers.map(user => (
                              <div 
                                key={user.id}
                                onClick={() => setEditingUser(user)}
                                className={`p-3 rounded-xl border cursor-pointer transition-all ${editingUser?.id === user.id ? 'bg-brand-50 border-brand-200 shadow-sm' : 'bg-white border-slate-200 hover:border-brand-300'}`}
                              >
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-600 text-xs">
                                    {user.name.charAt(0)}
                                  </div>
                                  <div>
                                    <h4 className="font-bold text-slate-800 text-sm">{user.name}</h4>
                                    <p className="text-[10px] text-slate-500 mt-0.5">{user.role}</p>
                                  </div>
                                </div>
                              </div>
                            ))}
                            {d.subDepartments && renderUserTree(d.subDepartments, depth + 1)}
                          </div>
                        </div>
                      );
                    });
                  };

                  const unassignedUsers = users.filter(u => !u.departmentId);

                  return (
                    <>
                      {renderUserTree(state.departments)}
                      {unassignedUsers.length > 0 && (
                        <div className="space-y-2 mt-4">
                          <div className="flex items-center gap-2 py-2 text-slate-700 font-bold text-sm border-b border-slate-100">
                            <Users size={16} className="text-slate-400" />
                            <span>未分配部门</span>
                          </div>
                          <div className="space-y-2 pl-2">
                            {unassignedUsers.map(user => (
                              <div 
                                key={user.id}
                                onClick={() => setEditingUser(user)}
                                className={`p-3 rounded-xl border cursor-pointer transition-all ${editingUser?.id === user.id ? 'bg-brand-50 border-brand-200 shadow-sm' : 'bg-white border-slate-200 hover:border-brand-300'}`}
                              >
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-600 text-xs">
                                    {user.name.charAt(0)}
                                  </div>
                                  <div>
                                    <h4 className="font-bold text-slate-800 text-sm">{user.name}</h4>
                                    <p className="text-[10px] text-slate-500 mt-0.5">{user.role}</p>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            <div className={`w-full md:w-2/3 bg-white rounded-2xl border border-slate-200 p-4 md:p-6 shadow-sm ${!editingUser ? 'hidden md:block' : 'block'}`}>
              {editingUser ? (
                <div className="space-y-6">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <h3 className="font-bold text-lg text-slate-800">编辑用户权限: {editingUser.name}</h3>
                    <div className="flex gap-2 w-full md:w-auto">
                      <button onClick={() => setEditingUser(null)} className="flex-1 md:flex-none px-4 py-2 text-slate-500 hover:bg-slate-100 rounded-lg font-medium text-sm transition-colors">取消</button>
                      <button 
                        onClick={handleSaveUser} 
                        disabled={!permissions.update}
                        className="flex-1 md:flex-none px-4 py-2 bg-brand-600 text-white rounded-lg font-medium text-sm hover:bg-brand-700 transition-colors disabled:opacity-50"
                      >
                        应用更改
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-4 border-b border-slate-100">
                    <button
                      onClick={() => setUserSubTab('menu')}
                      className={`px-4 py-2 font-bold text-xs border-b-2 transition-colors ${userSubTab === 'menu' ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                    >
                      菜单权限
                    </button>
                    <button
                      onClick={() => setUserSubTab('dept')}
                      className={`px-4 py-2 font-bold text-xs border-b-2 transition-colors ${userSubTab === 'dept' ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                    >
                      部门可见权
                    </button>
                  </div>

                  {userSubTab === 'menu' ? (
                    <div className="space-y-6">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 mb-3">分配系统角色 (可多选)</label>
                        <div className="flex flex-wrap gap-3">
                          {roles.map(role => {
                            const isSelected = editingUser.systemRoleIds?.includes(role.id);
                            return (
                              <button
                                key={role.id}
                                onClick={() => {
                                  const currentIds = editingUser.systemRoleIds || [];
                                  const newIds = isSelected 
                                    ? currentIds.filter(id => id !== role.id)
                                    : [...currentIds, role.id];
                                  setEditingUser({ ...editingUser, systemRoleIds: newIds });
                                }}
                                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all flex items-center gap-2 ${isSelected ? 'bg-brand-50 border-brand-500 text-brand-700' : 'bg-white border-slate-200 text-slate-600 hover:border-brand-300'}`}
                              >
                                {isSelected && <Check size={14} />}
                                {role.name}
                              </button>
                            );
                          })}
                          {roles.length === 0 && <span className="text-sm text-slate-400 italic">暂无可选角色</span>}
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        <label className="block text-xs font-bold text-slate-500 mb-3">个人特殊权限 (将覆盖角色权限)</label>
                        <div className="min-w-[500px]">
                          {renderPermissionTable(editingUser.customPermissions || {}, 'user')}
                        </div>
                      </div>
                    </div>
                  ) : (
                    renderDeptPermissionGrid()
                  )}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-400">
                  <Users size={48} className="mb-4 opacity-20" />
                  <p>请选择一个用户进行权限配置</p>
                </div>
              )}
            </div>
          </div>
        )}
      {/* Delete Confirmation Modal */}
      {pendingDeleteRoleId && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl text-center animate-in zoom-in-95">
            <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle size={32} className="text-red-500" />
            </div>
            <h3 className="text-xl font-black text-slate-800 mb-2">确认删除此角色？</h3>
            <p className="text-slate-500 text-xs font-medium mb-8 uppercase tracking-widest">此操作无法撤销</p>
            <div className="flex gap-3">
              <button 
                onClick={() => setPendingDeleteRoleId(null)}
                className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-xs uppercase hover:bg-slate-200 transition-all"
              >
                取消
              </button>
              <button 
                onClick={confirmDeleteRole}
                className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-red-200 hover:bg-red-600 transition-all"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
);
};

export default MenuPermissionView;
