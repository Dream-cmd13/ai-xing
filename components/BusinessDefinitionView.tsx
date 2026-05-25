import React, { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, BusinessDefinition, CompanyStrategy } from '../types';
import { IMEInput, IMETextarea } from './IMEInput';
import { Globe, Plus, Trash2, Save, Loader2, CheckCircle, AlertCircle, Users, Target, Package, Layers, Workflow, Info } from 'lucide-react'
const BusinessDefinitionView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, tasks, aiSettings, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('business-definition');
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

  const businesses = state.businesses || [];
  const strategy = state.strategy;
  const [activeBusinessId, setActiveBusinessId] = useState<string | null>(businesses.length > 0 ? businesses[0].id : null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const handleAddBusiness = () => {
    if (!permissions.create) return;
    const newBusiness: BusinessDefinition = {
      id: `biz-${Date.now()}`,
      name: `新事业 ${businesses.length + 1}`,
      businessFormat: '',
      customerPersona: '',
      customerNeeds: '',
      surfaceProductPower: '',
      coreProductPower: ''
    };
    setBusinesses([...businesses, newBusiness]);
    setActiveBusinessId(newBusiness.id);
    setIsDirty(true);
  };

  const handleUpdateBusiness = (id: string, updates: Partial<BusinessDefinition>) => {
    if (!permissions.update) return;
    setBusinesses(businesses.map(b => b.id === id ? { ...b, ...updates } : b));
    setIsDirty(true);
  };

  const handleDeleteBusiness = (id: string) => {
    if (!permissions.update) return; // Assuming update/delete are tied
    setPendingDeleteId(id);
  };

  const confirmDelete = () => {
    if (!pendingDeleteId) return;
    const newBusinesses = businesses.filter(b => b.id !== pendingDeleteId);
    setBusinesses(newBusinesses);
    if (activeBusinessId === pendingDeleteId) {
      setActiveBusinessId(newBusinesses.length > 0 ? newBusinesses[0].id : null);
    }
    setIsDirty(true);
    setPendingDeleteId(null);
  };

  const activeBusiness = businesses.find(b => b.id === activeBusinessId);

  return (
    <div className="h-full flex flex-col bg-slate-50 overflow-hidden">
      <div className="p-4 md:p-6 border-b border-slate-200 bg-white flex flex-col md:flex-row justify-between items-start md:items-center shrink-0 gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-black text-slate-800 tracking-tight flex items-center gap-2">
            <Globe className="text-brand-600" />
            事业定义
          </h2>
          <p className="text-xs md:text-sm text-slate-500 mt-1">定义企业的各个事业、顾客画像、需求及商品力</p>
        </div>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <button 
            onClick={handleSave}
            disabled={isSaving}
            className={`flex-1 md:flex-none flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-xs font-black uppercase transition-all shadow-lg ${showSaveSuccess ? 'bg-emerald-50 text-emerald-600 shadow-emerald-100' : isDirty ? 'bg-brand-600 text-white shadow-brand-200 hover:bg-brand-700' : 'bg-slate-100 text-slate-400 cursor-default'}`}
          >
            {isSaving ? <Loader2 className="animate-spin" size={16}/> : showSaveSuccess ? <CheckCircle size={16}/> : <Save size={16}/>}
            {showSaveSuccess ? '已保存' : isDirty ? '立即保存' : '已是最新'}
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Sidebar */}
        <div className="w-full md:w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-100 flex justify-between items-center">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">事业列表</h3>
            {permissions.create && (
              <button onClick={handleAddBusiness} className="p-1 hover:bg-brand-50 text-brand-600 rounded">
                <Plus size={16} />
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
            {businesses.map(b => (
              <div 
                key={b.id}
                onClick={() => setActiveBusinessId(b.id)}
                className={`flex items-center justify-between px-3 py-3 rounded-xl cursor-pointer transition-colors mb-1 ${activeBusinessId === b.id ? 'bg-brand-50 text-brand-600 font-bold' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                <span className="text-sm truncate">{b.name}</span>
              </div>
            ))}
            {businesses.length === 0 && (
              <div className="text-center p-4 text-xs text-slate-400">暂无事业定义</div>
            )}
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar">
          {activeBusiness ? (
            <div className="max-w-4xl mx-auto space-y-6 md:space-y-8 pb-12">
              <div className="flex justify-between items-center bg-white p-4 md:p-6 rounded-2xl border shadow-sm">
                <IMEInput 
                  className="text-xl md:text-2xl font-black text-slate-800 outline-none bg-transparent w-full"
                  value={activeBusiness.name || ''}
                  onChange={e => handleUpdateBusiness(activeBusiness.id, { name: e.target.value })}
                  placeholder="输入事业名称..."
                  disabled={!permissions.update}
                />
                {permissions.update && (
                  <button onClick={() => handleDeleteBusiness(activeBusiness.id)} className="p-2 text-red-400 hover:bg-red-50 rounded-xl transition-colors shrink-0">
                    <Trash2 size={20} />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                {/* Shared Mission & Vision */}
                <div className="bg-white p-6 rounded-3xl border shadow-sm space-y-4 md:col-span-2">
                  <div className="flex items-center gap-2 mb-2">
                    <Info className="text-brand-500" size={20}/>
                    <h3 className="font-black text-slate-800">共有使命与愿景</h3>
                    <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-bold uppercase tracking-widest">所有事业共有</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">使命 (Mission)</label>
                      <IMETextarea 
                        className="w-full bg-slate-50 p-4 rounded-xl text-sm font-bold text-slate-700 outline-none focus:border-brand-300 border border-transparent min-h-[80px] resize-none"
                        placeholder="定义企业存在的根本意义..."
                        value={strategy.mission || ''}
                        onChange={e => { setStrategy({ mission: e.target.value }); setIsDirty(true); }}
                        disabled={!permissions.update}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">愿景 (Vision)</label>
                      <IMETextarea 
                        className="w-full bg-slate-50 p-4 rounded-xl text-sm font-bold text-slate-700 outline-none focus:border-brand-300 border border-transparent min-h-[80px] resize-none"
                        placeholder="描绘企业未来的理想蓝图..."
                        value={strategy.vision || ''}
                        onChange={e => { setStrategy({ vision: e.target.value }); setIsDirty(true); }}
                        disabled={!permissions.update}
                      />
                    </div>
                  </div>
                </div>

                {/* Customer Persona & Needs */}
                <div className="bg-white p-6 rounded-3xl border shadow-sm space-y-4 md:col-span-2">
                  <div className="flex items-center gap-2 mb-4">
                    <Users className="text-brand-500" size={20}/>
                    <h3 className="font-black text-slate-800">顾客定义</h3>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">顾客画像定义</label>
                      <IMETextarea 
                        className="w-full bg-slate-50 p-4 rounded-xl text-sm font-bold text-slate-700 outline-none focus:border-brand-300 border border-transparent min-h-[100px] resize-none"
                        placeholder="描述目标顾客的特征、行为、偏好等..."
                        value={activeBusiness.customerPersona || ''}
                        onChange={e => handleUpdateBusiness(activeBusiness.id, { customerPersona: e.target.value })}
                        disabled={!permissions.update}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">顾客需求定义</label>
                      <IMETextarea 
                        className="w-full bg-slate-50 p-4 rounded-xl text-sm font-bold text-slate-700 outline-none focus:border-brand-300 border border-transparent min-h-[100px] resize-none"
                        placeholder="描述顾客的核心痛点 and 需求..."
                        value={activeBusiness.customerNeeds || ''}
                        onChange={e => handleUpdateBusiness(activeBusiness.id, { customerNeeds: e.target.value })}
                        disabled={!permissions.update}
                      />
                    </div>
                  </div>
                </div>

                {/* Product Power */}
                <div className="bg-white p-6 rounded-3xl border shadow-sm space-y-4 md:col-span-2">
                  <div className="flex items-center gap-2 mb-4">
                    <Package className="text-brand-500" size={20}/>
                    <h3 className="font-black text-slate-800">商品力属性</h3>
                    <span className="text-xs text-slate-400 ml-2 font-normal">决定顾客购买要素的组合</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2 flex items-center gap-1"><Layers size={14}/> 表层商品力</label>
                      <IMETextarea 
                        className="w-full bg-slate-50 p-4 rounded-xl text-sm font-bold text-slate-700 outline-none focus:border-brand-300 border border-transparent min-h-[120px] resize-none"
                        placeholder="顾客容易感知到的外在属性（如外观、包装、基础功能等）..."
                        value={activeBusiness.surfaceProductPower || ''}
                        onChange={e => handleUpdateBusiness(activeBusiness.id, { surfaceProductPower: e.target.value })}
                        disabled={!permissions.update}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2 flex items-center gap-1"><Target size={14}/> 核心商品力</label>
                      <IMETextarea 
                        className="w-full bg-slate-50 p-4 rounded-xl text-sm font-bold text-slate-700 outline-none focus:border-brand-300 border border-transparent min-h-[120px] resize-none"
                        placeholder="不可替代的核心竞争优势（如独家技术、品牌心智、极致性价比等）..."
                        value={activeBusiness.coreProductPower || ''}
                        onChange={e => handleUpdateBusiness(activeBusiness.id, { coreProductPower: e.target.value })}
                        disabled={!permissions.update}
                      />
                    </div>
                  </div>
                </div>

                {/* Business Format */}
                <div className="bg-white p-6 rounded-3xl border shadow-sm space-y-4 md:col-span-2">
                  <div className="flex items-center gap-2 mb-2">
                    <Workflow className="text-brand-500" size={20}/>
                    <h3 className="font-black text-slate-800">业态定义</h3>
                    <span className="text-[10px] bg-brand-50 text-brand-600 px-2 py-0.5 rounded-full font-bold uppercase tracking-widest">满足客户需求的整个过程</span>
                  </div>
                  <div>
                    <IMETextarea 
                      className="w-full bg-slate-50 p-4 rounded-xl text-sm font-bold text-slate-700 outline-none focus:border-brand-300 border border-transparent min-h-[100px] resize-none"
                      placeholder="如：客户需求 -> 报价 -> 模具开发 -> 打样 -> 样品承认..."
                      value={activeBusiness.businessFormat || ''}
                      onChange={e => handleUpdateBusiness(activeBusiness.id, { businessFormat: e.target.value })}
                      disabled={!permissions.update}
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4">
              <Globe size={48} className="opacity-20"/>
              <p className="font-bold">请选择或创建一个事业定义</p>
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {pendingDeleteId && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2.5rem] w-full max-w-sm p-10 shadow-2xl text-center animate-in zoom-in-95">
            <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle size={32} />
            </div>
            <h3 className="text-xl font-black text-slate-800 mb-2">确认删除此事业定义？</h3>
            <p className="text-slate-500 text-xs font-medium mb-8 uppercase tracking-widest">此操作无法撤销</p>
            <div className="flex gap-3">
              <button 
                onClick={() => setPendingDeleteId(null)}
                className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-xs uppercase hover:bg-slate-200 transition-all"
              >
                取消
              </button>
              <button 
                onClick={confirmDelete}
                className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase shadow-lg shadow-red-200 hover:bg-red-600 transition-all"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BusinessDefinitionView;
