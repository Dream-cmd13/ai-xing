import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';

import { AlertCircle, ShieldCheck, Loader2 as Spinner } from 'lucide-react';
import PageToast from './PageToast';
import { usePageToast } from '../hooks/usePageToast';
import { cn } from '../utils/cn';
import { supabase } from '../supabase';
import { getLoginUserFacingError } from '../utils/userFacingError';

const MOBILE_LOGIN_PATTERN = /^1\d{10}$/;


const LoginView: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const { toastState, showToast, clearToast } = usePageToast();

  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/workbench', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    clearToast();
    setLoginError('');
  }, [clearToast, username, password]);

  useEffect(() => {
    if (loginError && !isLoading) passwordInputRef.current?.focus();
  }, [isLoading, loginError]);

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    
    if (!username.trim() || !password.trim()) {
      setLoginError('请输入用户名和密码');
      return;
    }

    clearToast();
    setLoginError('');
    setIsLoading(true);
    
    try {
      const account = username.trim().toLowerCase();
      const isPhoneLogin = MOBILE_LOGIN_PATTERN.test(account);
      const credential = isPhoneLogin
        ? { phone: account, password }
        : { email: account.includes('@') ? account : `${account}@app.local`, password };
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword(credential);

      if (authError) {
        setLoginError(getLoginUserFacingError(authError));
        return;
      }

      if (authData.user) {
        showToast('登录成功，正在初始化数据...', 'success');
      } else {
        setLoginError('登录失败，请稍后重试');
      }
    } catch (error: unknown) {
      setLoginError(getLoginUserFacingError(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-900 p-6 relative">
      <PageToast
        visible={!!toastState}
        message={toastState?.message || ''}
        type={toastState?.type}
        onClose={clearToast}
      />
      <div className="w-full max-w-md bg-white rounded-[2.5rem] shadow-2xl overflow-hidden p-10 animate-in fade-in zoom-in duration-500">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-brand-50 rounded-3xl mb-4">
            <ShieldCheck className="h-10 w-10 text-brand-600" />
          </div>
          <h1 className="text-2xl font-black text-slate-800 tracking-tighter text-center">AI星组织 工作台</h1>
          <p className="text-slate-400 text-xs font-bold mt-2 uppercase tracking-widest">组织协同工作平台</p>
        </div>
        
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="p-3 bg-slate-50 border border-slate-100 rounded-2xl focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 transition-all">
            <label htmlFor="login-username" className="text-[10px] font-black uppercase text-slate-400 block mb-1">登录账号</label>
            <input 
              id="login-username"
              type="text" 
              autoComplete="username"
              className="w-full bg-transparent text-sm font-bold outline-none text-slate-700 placeholder:text-slate-300" 
              placeholder="请输入用户名"
              value={username} 
              onChange={e => setUsername(e.target.value)} 
              disabled={isLoading}
              aria-invalid={!!loginError}
              aria-describedby={loginError ? 'login-form-error' : undefined}
            />
          </div>
          <div className="p-3 bg-slate-50 border border-slate-100 rounded-2xl focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 transition-all">
            <label htmlFor="login-password" className="text-[10px] font-black uppercase text-slate-400 block mb-1">登录密码</label>
            <input 
              id="login-password"
              ref={passwordInputRef}
              type="password"  
              autoComplete="current-password"
              className="w-full bg-transparent text-sm font-bold outline-none text-slate-700 placeholder:text-slate-300" 
              placeholder="请输入密码"
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              disabled={isLoading}
              aria-invalid={!!loginError}
              aria-describedby={loginError ? 'login-form-error' : undefined}
            />
          </div>

          {loginError && (
            <div
              id="login-form-error"
              role="alert"
              aria-live="assertive"
              className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{loginError}</span>
            </div>
          )}

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
            &copy; 2026 AI星组织 版权所有
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginView;
