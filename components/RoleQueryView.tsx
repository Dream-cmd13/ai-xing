
import React, { useState, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { ProcessDefinition, Department, ProcessNode, SIPOC, User } from '../types';
import { UserSearch, Search, Briefcase, ChevronRight, Layout, Info, Building2, Users, X } from 'lucide-react';



interface RoleInvolvement {
  processName: string;
  category: string;
  steps: {
    id: string;
    label: string;
    sipoc: SIPOC;
    type: 'Owner' | 'Assistant'; 
    nodeType: 'start' | 'process' | 'decision' | 'end';
  }[];
}

const RoleQueryView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('roles');
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

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [showMembersModal, setShowMembersModal] = useState(false);

  // Extract all unique roles from org structure
  const allRoles = useMemo(() => {
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

  const filteredRoles = useMemo(() => {
    return allRoles.filter(r => r.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [allRoles, searchTerm]);

  // Find users assigned to this role across all departments
  const assignedUsers = useMemo(() => {
    if (!selectedRole) return [];
    const userIds = new Set<string>();
    
    const collectFromDepts = (depts: Department[]) => {
      depts.forEach(d => {
        const members = d.roleMembers?.[selectedRole] || [];
        members.forEach(id => userIds.add(id));
        if (d.subDepartments) collectFromDepts(d.subDepartments);
      });
    };
    
    collectFromDepts(departments);
    return users.filter(u => userIds.has(u.id));
  }, [selectedRole, departments, users]);

  // Helper to find department name by ID
  const getDeptName = (deptId?: string) => {
    if (!deptId) return '未分配';
    const findDept = (depts: Department[]): string | undefined => {
        for (const d of depts) {
            if (d.id === deptId) return d.name;
            if (d.subDepartments) {
                const sub = findDept(d.subDepartments);
                if (sub) return sub;
            }
        }
        return undefined;
    };
    return findDept(departments) || '未知部门';
  };

  // For a selected role, find all involving processes and their steps
  const involvement = useMemo(() => {
    if (!selectedRole) return [];

    const result: RoleInvolvement[] = [];

    const scanNodes = (nodes: ProcessNode[], processName: string, category: string, acc: RoleInvolvement) => {
      nodes.forEach(node => {
        let roleType: 'Owner' | 'Assistant' | null = null;
        if (node.sipoc?.ownerRole === selectedRole) {
          roleType = 'Owner';
        } else if (node.sipoc?.assistantRoles?.includes(selectedRole)) {
          roleType = 'Assistant';
        }

        if (roleType && node.type !== 'decision') {
          acc.steps.push({
            id: node.id,
            label: node.label,
            sipoc: node.sipoc,
            type: roleType,
            nodeType: node.type
          });
        }
        if (node.subProcessNodes && node.subProcessNodes.length > 0) {
          scanNodes(node.subProcessNodes, processName, category, acc);
        }
      });
    };

    processes.forEach(p => {
      const entry: RoleInvolvement = { processName: p.name, category: p.category, steps: [] };
      scanNodes(p.nodes, p.name, p.category, entry);
      if (entry.steps.length > 0) {
        result.push(entry);
      }
    });

    return result;
  }, [selectedRole, processes]);

  return (
    <div className="h-full flex flex-col gap-4 md:gap-6 p-4 md:p-6 bg-slate-50 relative overflow-hidden">
      <div className="bg-white p-4 md:p-6 rounded-[2.5rem] border shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center shrink-0 gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-800">岗位职责透视</h2>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Cross-Process Role Responsibility Mapping</p>
        </div>
        <div className="relative w-full md:w-auto">
          <input 
            className="pl-10 pr-4 py-2.5 bg-slate-50 border rounded-xl text-xs font-bold outline-none focus:border-brand-500 w-full md:w-64 shadow-inner" 
            placeholder="搜索岗位名称..." 
            value={searchTerm} 
            onChange={e => setSearchTerm(e.target.value)}
          />
          <Search size={14} className="absolute left-4 top-3.5 text-slate-300"/>
        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row gap-4 md:gap-6 overflow-hidden relative pb-10">
        <aside className={`w-full md:w-72 bg-white border rounded-[2.5rem] flex flex-col overflow-hidden shadow-sm shrink-0 ${selectedRole ? 'hidden md:flex' : 'flex'}`}>
          <div className="p-6 border-b bg-slate-50/50 flex justify-between items-center">
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">组织岗位库</h3>
            <UserSearch size={14}/>
          </div>
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-1">
            {filteredRoles.length === 0 ? (
              <div className="text-center py-20 text-slate-300 text-xs italic">未找到匹配岗位</div>
            ) : filteredRoles.map(role => (
              <button 
                key={role} 
                onClick={() => { setSelectedRole(role); setShowMembersModal(false); }}
                className={`w-full text-left px-4 py-3 rounded-2xl flex items-center justify-between group transition-all ${selectedRole === role ? 'bg-brand-600 text-white shadow-lg' : 'hover:bg-slate-50 text-slate-600'}`}
              >
                <div className="flex items-center gap-3 overflow-hidden">
                  <Briefcase size={14} className={selectedRole === role ? 'text-white' : 'text-slate-400'}/>
                  <span className="text-xs font-black truncate">{role}</span>
                </div>
                <ChevronRight size={14} className={`opacity-0 group-hover:opacity-100 transition-opacity ${selectedRole === role ? 'text-white' : 'text-slate-300'}`}/>
              </button>
            ))}
          </div>
        </aside>

        <div className={`flex-1 bg-white border rounded-[2.5rem] flex flex-col overflow-hidden shadow-sm ${!selectedRole ? 'hidden md:flex' : 'flex'}`}>
          {!selectedRole ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-300 gap-4">
              <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center"><UserSearch size={40}/></div>
              <p className="text-sm font-black uppercase tracking-widest">请选择一个岗位以查看其跨流程职责</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden animate-in fade-in duration-500">
              <header className="p-4 md:p-8 border-b bg-slate-50/30 shrink-0 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
                <div className="flex items-center gap-4">
                  <button onClick={() => setSelectedRole(null)} className="md:hidden p-2 -ml-2 text-slate-400 hover:text-slate-600">
                    <ChevronRight size={24} className="rotate-180" />
                  </button>
                  <div className="w-14 h-14 bg-brand-50 text-brand-600 rounded-2xl flex items-center justify-center shadow-inner shrink-0"><Briefcase size={28}/></div>
                  <div>
                    <h3 className="text-xl md:text-2xl font-black text-slate-800 tracking-tight">{selectedRole}</h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase mt-1">参与流程总计: <span className="text-brand-600">{involvement.length}</span></p>
                  </div>
                </div>
                
                {/* Member List Section - Clickable */}
                <div 
                  className="flex flex-col items-start md:items-end gap-2 cursor-pointer group w-full md:w-auto"
                  onClick={() => assignedUsers.length > 0 && setShowMembersModal(true)}
                >
                   <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1 group-hover:text-brand-600 transition-colors">
                     <Users size={10}/> 岗位成员 ({assignedUsers.length})
                   </span>
                   <div className="flex -space-x-2">
                      {assignedUsers.length === 0 ? (
                        <span className="text-[10px] text-slate-300 font-bold italic">暂无分配成员</span>
                      ) : assignedUsers.map((u, i) => (
                        <div key={u.id} className="w-8 h-8 rounded-full bg-brand-600 border-2 border-white flex items-center justify-center text-[10px] text-white font-black shadow-sm ring-1 ring-slate-100 group-hover:scale-110 transition-transform" title={u.name}>
                           {u.name.charAt(0)}
                        </div>
                      ))}
                   </div>
                </div>
              </header>
              <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar bg-[radial-gradient(#f1f5f9_1px,transparent_1px)] [background-size:32px_32px]">
                {involvement.length === 0 ? (
                  <div className="text-center py-20 text-slate-400 italic">该岗位暂未被分配到任何流程环节。</div>
                ) : involvement.map((inv, idx) => (
                  <div key={idx} className="bg-white rounded-[2.5rem] border shadow-sm p-8 space-y-6">
                    <div className="flex justify-between items-center border-b pb-4">
                      <div className="flex items-center gap-3">
                        <span className="text-[9px] font-black bg-slate-900 text-white px-2 py-0.5 rounded uppercase tracking-tighter">{inv.category}</span>
                        <h4 className="text-lg font-black text-slate-800">{inv.processName}</h4>
                      </div>
                      <Layout size={16} className="text-slate-200"/>
                    </div>
                    <div className="grid grid-cols-1 gap-6">
                      {inv.steps.map(step => (
                        <div key={step.id} className="p-6 bg-slate-50/50 border rounded-3xl group hover:border-brand-200 transition-all">
                          <div className="flex justify-between items-start mb-4">
                            <h5 className="font-black text-slate-700 flex items-center gap-2">
                              <div className={`w-2 h-2 rounded-full ${step.type === 'Owner' ? 'bg-brand-600' : 'bg-amber-500'}`}/>
                              {step.label}
                            </h5>
                            <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${step.type === 'Owner' ? 'bg-brand-100 text-brand-700' : 'bg-amber-100 text-amber-700'}`}>
                              {step.type === 'Owner' ? '主责' : '辅助'}
                            </span>
                          </div>
                          
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                            <SipocMiniBox label="S - 来源" items={step.sipoc.source || []} />
                            <SipocMiniBox label="I - 输入" items={step.sipoc.inputs || []} />
                            <SipocMiniBox label="O - 输出" items={step.sipoc.outputs || []} />
                            <SipocMiniBox label="C - 输出对象" items={step.sipoc.customers || []} />
                          </div>
                          {step.sipoc.standard && (
                            <div className="mt-4 pt-4 border-t border-slate-100">
                               <div className="flex items-center gap-2 text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1"><Info size={10}/> P - 作业标准</div>
                               <p className="text-[10px] text-slate-500 italic line-clamp-2 leading-relaxed">{step.sipoc.standard}</p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Member List Modal */}
      {showMembersModal && selectedRole && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-6">
            <div className="bg-white rounded-[2.5rem] w-full max-w-md p-10 shadow-2xl animate-in zoom-in-95">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-brand-50 text-brand-600 rounded-2xl flex items-center justify-center"><Users size={24}/></div>
                        <div>
                            <h3 className="text-xl font-black">{selectedRole}</h3>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">在职人员名单 ({assignedUsers.length})</p>
                        </div>
                    </div>
                    <button onClick={() => setShowMembersModal(false)} className="p-2 hover:bg-slate-100 rounded-full"><X size={20}/></button>
                </div>
                
                <div className="space-y-3 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
                    {assignedUsers.map(u => (
                        <div key={u.id} className="flex items-center justify-between p-4 rounded-2xl border border-slate-100 bg-slate-50">
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-xs font-black text-brand-600">
                                    {u.name.charAt(0)}
                                </div>
                                <div>
                                    <h4 className="text-sm font-black text-slate-800">{u.name}</h4>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase">{u.username}</p>
                                </div>
                            </div>
                            <div className="px-3 py-1 bg-white border rounded-lg text-[10px] font-black text-slate-500 flex items-center gap-1">
                                <Building2 size={10}/> {getDeptName(u.departmentId)}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
      )}
    </div>
  );
};

const SipocMiniBox = ({ label, items }: { label: string, items: string[] }) => (
  <div className="space-y-1.5">
    <div className="text-[8px] font-black text-slate-400 uppercase tracking-tighter">{label}</div>
    <div className="flex flex-wrap gap-1">
      {items.length === 0 ? (
        <span className="text-[9px] text-slate-300 italic">无</span>
      ) : (
        items.map((it, i) => (
          <span key={i} className="text-[8px] font-bold bg-white text-slate-600 px-1.5 py-0.5 rounded border border-slate-100">{it}</span>
        ))
      )}
    </div>
  </div>
);

export default RoleQueryView;
