import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePermissions } from '../hooks/usePermissions';

import { ShieldCheck, Loader2 as Spinner, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../utils/cn';
import { User, AppState } from '../types';
import { supabase } from '../supabase';



const LoginView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('process');
  const { 
    handleSave, saveStateDirectly, executeAtomicOperation, 
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

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const { login, isAuthenticated } = useAuthStore();
  const { setState, setIsInitialLoadComplete } = useAppStore();
  const navigate = useNavigate();

  React.useEffect(() => {
    if (isAuthenticated) {
      navigate('/workbench', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    
    if (!username.trim() || !password.trim()) {
      toast.error('请输入用户名和密码');
      return;
    }

    setIsLoading(true);
    
    try {
      const account = username.trim().toLowerCase();
      const email = account.includes('@') ? account : `${account}@app.local`;
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (authError) {
        toast.error(`登录失败：${authError.message}`);
        return;
      }

      if (authData.user) {
        toast.success('登录成功，正在进入系统...');
        navigate('/workbench', { replace: true });
      }
    } catch (error: any) {
      toast.error(`登录出错：${error.message || '未知错误'}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-900 p-6 relative">
      <div className="w-full max-w-md bg-white rounded-[2.5rem] shadow-2xl overflow-hidden p-10 animate-in fade-in zoom-in duration-500">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-brand-50 rounded-3xl mb-4">
            <ShieldCheck className="h-10 w-10 text-brand-600" />
          </div>
          <h1 className="text-2xl font-black text-slate-800 tracking-tighter text-center">AI星组织 工作台</h1>
          <p className="text-slate-400 text-xs font-bold mt-2 uppercase tracking-widest">StratFlow AI Enterprise</p>
        </div>
        
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="p-3 bg-slate-50 border border-slate-100 rounded-2xl focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 transition-all">
            <label className="text-[10px] font-black uppercase text-slate-400 block mb-1">登录账号</label>
            <input 
              type="text" 
              autoComplete="username"
              className="w-full bg-transparent text-sm font-bold outline-none text-slate-700 placeholder:text-slate-300" 
              placeholder="请输入用户名"
              value={username} 
              onChange={e => setUsername(e.target.value)} 
              disabled={isLoading}
            />
          </div>
          <div className="p-3 bg-slate-50 border border-slate-100 rounded-2xl focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 transition-all">
            <label className="text-[10px] font-black uppercase text-slate-400 block mb-1">登录密码</label>
            <input 
              type="password"  
              autoComplete="current-password"
              className="w-full bg-transparent text-sm font-bold outline-none text-slate-700 placeholder:text-slate-300" 
              placeholder="请输入密码"
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              disabled={isLoading}
            />
          </div>

          <button 
            type="submit"
            disabled={isLoading}
            className={cn(
              "w-full text-white py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl transition-all active:scale-[0.98] flex items-center justify-center gap-2",
              isLoading ? "bg-slate-700 cursor-not-allowed" : "bg-slate-900 hover:bg-brand-600 hover:shadow-brand-200"
            )}
          >
            {isLoading ? (
              <>
                <Spinner className="h-4 w-4 animate-spin" />
                正在验证身份...
              </>
            ) : (
              "验证身份并进入"
            )}
          </button>
        </form>
        
        <div className="mt-8 pt-6 border-t border-slate-50 text-center">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter">
            &copy; 2026 StratFlow AI. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginView;
