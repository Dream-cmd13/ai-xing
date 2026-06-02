import React, { useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useLeaveGuard } from '@/hooks/useLeaveGuard';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppActions } from '@/hooks/useAppActions';
import { usePermissions } from '@/hooks/usePermissions';

import { Save, Shield, Cpu, AlertCircle, CheckCircle2 } from 'lucide-react';
import { AISettings, AIModelConfig } from '@/types';



const SystemConfigView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('system-config');
  const { 
    submitAISettings,
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

  const [selectedModelId, setSelectedModelId] = useState<string>(
    aiSettings?.selectedModelId || ''
  );
  const [configs, setConfigs] = useState<AIModelConfig[]>(
    aiSettings?.configs || [
      { id: 'gemini', name: 'Gemini 2.5 Flash', type: 'gemini', modelName: 'gemini-2.5-flash' },
      { id: 'deepseek', name: 'DeepSeek Chat', type: 'deepseek', modelName: 'deepseek-chat' }
    ]
  );

  const handleUpdateConfig = (id: string, updates: Partial<AIModelConfig>) => {
    setConfigs(configs.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  const handleSaveConfig = () => {
    submitAISettings({
      selectedModelId,
      configs
    });
  };

  return (
    <div className="h-full flex flex-col space-y-6 animate-in fade-in duration-500 overflow-y-auto custom-scrollbar pr-2">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Shield className="text-brand-600" /> 系统设置
          </h2>
          <p className="text-slate-500 text-sm font-medium mt-1">配置系统全局参数及 AI 大模型集成</p>
        </div>
        <button
          onClick={handleSaveConfig}
          disabled={isSaving}
          className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-black uppercase text-xs tracking-widest transition-all shadow-xl active:scale-95 disabled:opacity-50 ${showSaveSuccess ? 'bg-emerald-50 text-emerald-600' : isDirty ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-brand-100' : 'bg-slate-100 text-slate-400 cursor-default'}`}
        >
          {isSaving ? (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : showSaveSuccess ? (
            <CheckCircle2 size={16} />
          ) : (
            <Save size={16} />
          )}
          {showSaveSuccess ? '已保存' : isDirty ? '立即保存' : '已是最新'}
        </button>
      </div>

      {showSaveSuccess && (
        <div className="bg-emerald-50 border border-emerald-100 text-emerald-600 p-4 rounded-2xl flex items-center gap-3 animate-in slide-in-from-top-2">
          <CheckCircle2 size={20} />
          <p className="text-sm font-bold">系统配置已成功保存并同步</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Model Selection */}
          <div className="bg-white rounded-[2rem] p-8 shadow-sm border border-slate-100">
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-brand-50 rounded-xl flex items-center justify-center text-brand-600">
                  <Cpu size={20} />
                </div>
                <div>
                  <h3 className="text-lg font-black text-slate-800">AI 大模型集成</h3>
                  <p className="text-slate-400 text-xs font-bold uppercase">AI Model Integration</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {configs.map((config) => (
                <div 
                  key={config.id}
                  className={`p-6 rounded-2xl border-2 transition-all ${
                    selectedModelId === config.id
                      ? 'border-brand-600 bg-brand-50/30 ring-4 ring-brand-50'
                      : 'border-slate-100 bg-slate-50/30'
                  }`}
                >
                  <div className="flex flex-col md:flex-row gap-6">
                    <div className="flex-1 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <input 
                            type="radio" 
                            checked={selectedModelId === config.id}
                            onChange={() => setSelectedModelId(config.id)}
                            className="w-4 h-4 text-brand-600 border-slate-300 focus:ring-brand-500"
                          />
                          <input 
                            type="text"
                            value={config.name || ''}
                            onChange={(e) => handleUpdateConfig(config.id, { name: e.target.value })}
                            className="bg-transparent font-black text-slate-800 outline-none focus:border-b border-brand-500"
                            placeholder="模型名称"
                          />
                          <span className="text-[9px] font-black px-2 py-0.5 bg-slate-200 text-slate-500 rounded uppercase tracking-tighter">
                            {config.type}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">运行方式</label>
                          <div className="w-full px-4 py-2 bg-slate-50 border border-slate-100 rounded-xl text-xs font-bold text-slate-500">
                            由后端环境变量安全托管 API Key
                          </div>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Model Name</label>
                          <div className="relative">
                            <Cpu className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" size={14} />
                            <input
                              type="text"
                              value={config.modelName || ''}
                              onChange={(e) => handleUpdateConfig(config.id, { modelName: e.target.value })}
                              placeholder={config.type === 'deepseek' ? 'deepseek-chat' : 'gemini-2.5-flash'}
                              className="w-full pl-10 pr-4 py-2 bg-white border border-slate-100 rounded-xl text-xs font-bold outline-none focus:border-brand-500 transition-all"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {!selectedModelId && (
              <div className="mt-6 p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-start gap-3">
                <AlertCircle className="text-amber-500 shrink-0 mt-0.5" size={18} />
                <p className="text-xs font-bold text-amber-700 leading-relaxed">
                  当前未设置默认使用的 AI 模型。系统在调用 AI 功能时将提示“未设置大模型参数”。
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-slate-900 rounded-[2rem] p-8 text-white shadow-xl">
            <h3 className="text-lg font-black mb-4">配置说明</h3>
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0 text-[10px] font-black">1</div>
                <p className="text-xs text-slate-400 leading-relaxed font-medium">
                  选择一个默认模型后，系统中的所有 AI 辅助功能（如流程优化、策略建议等）将优先调用该模型。
                </p>
              </div>
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0 text-[10px] font-black">2</div>
                <p className="text-xs text-slate-400 leading-relaxed font-medium">
                  当前安全后端仅支持 Gemini 与 DeepSeek，两者都通过服务端代理调用。
                </p>
              </div>
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0 text-[10px] font-black">3</div>
                <p className="text-xs text-slate-400 leading-relaxed font-medium">
                  模型密钥不再保存在系统设置或业务表中，只允许配置在后端环境变量里。
                </p>
              </div>
            </div>
          </div>

          <div className="bg-brand-600 rounded-[2rem] p-8 text-white shadow-xl shadow-brand-600/20">
            <h3 className="text-lg font-black mb-2">安全提示</h3>
            <p className="text-xs text-brand-100 leading-relaxed font-medium mb-4">
              系统设置仅限“系统管理员”角色访问。前端只负责选择模型与模型名，真实 API Key 必须配置在后端服务环境变量中。
            </p>
            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest bg-white/20 p-2 rounded-lg w-fit">
              <Shield size={12} /> Administrator Only
            </div>
          </div>
        </div>
      </div>
      {LeaveModal}
    </div>
  );
};

export default SystemConfigView;
