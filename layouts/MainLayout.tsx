import React, { Suspense, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { useAppStore } from '../store/useAppStore';
import { MENU_GROUPS } from '../constants';
import { hasPermission as hasMenuPermission } from '../utils/permissions';
import { updateMyProfileName } from '../data';
import { supabase } from '../supabase';
import { getUserFacingError } from '../utils/userFacingError';
import { getRequiredDomains } from '../utils/routeDomains';
import { 
  ShieldCheck, Settings, LogOut, X, Menu, LayoutDashboard, GitGraph, Target, Building2,
  Calendar, Users, UserCog, ShieldCheck as ShieldCheckIcon, Settings as SettingsIcon,
  ChevronRight, Save, Loader2 as Spinner, AlertCircle, CheckCircle, Briefcase, ListTodo, ClipboardCheck, Key
} from 'lucide-react';

const iconMap: Record<string, React.ReactNode> = {
  'workbench': <LayoutDashboard size={18} />,
  'process': <GitGraph size={18} />,
  'org': <Building2 size={18} />,
  'roles': <UserCog size={18} />,
  'business-definition': <Briefcase size={18} />,
  'okr': <Target size={18} />,
  'execution': <Calendar size={18} />,
  'task-center': <ListTodo size={18} />,
  'okr-review': <ClipboardCheck size={18} />,
  'user': <Users size={18} />,
  'menu-permissions': <Key size={18} />,
  'system-config': <SettingsIcon size={18} />
};

const ContentLoadingFallback: React.FC = () => (
  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-50/96 gap-5">
    <div className="w-14 h-14 border-4 border-brand-100 border-t-brand-600 rounded-full animate-spin" />
    <p className="text-slate-500 font-black text-sm tracking-wide animate-pulse">页面加载中...</p>
  </div>
);

interface MainLayoutProps {
  content?: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ content }) => {
  const { currentUser, logout, updateCurrentUser } = useAuthStore();
  const { dirtyDomains, isDirty, isSaving, showSaveSuccess, backendError, systemRoles, users, lastSavedUsers } = useAppStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [profileName, setProfileName] = useState(currentUser?.name || '');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);
  const [isProfileSaving, setIsProfileSaving] = useState(false);
  const [isPasswordSaving, setIsPasswordSaving] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const openProfileModal = () => {
    setProfileName(currentUser?.name || '');
    setNewPassword('');
    setConfirmPassword('');
    setProfileError(null);
    setProfileSuccess(null);
    setIsProfileModalOpen(true);
  };

  const closeProfileModal = () => {
    setIsProfileModalOpen(false);
    setProfileError(null);
    setProfileSuccess(null);
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleNavigation = (path: string) => {
    const proceed = () => {
      navigate(path);
      setIsSidebarCollapsed(true);
    };

    if (!shouldGuardNavigation) {
      proceed();
      return;
    }

    const navigationEvent = new CustomEvent('app:navigation-attempt', {
      cancelable: true,
      detail: {
        path,
        retry: proceed
      }
    });

    const shouldProceed = window.dispatchEvent(navigationEvent);
    if (shouldProceed) {
      proceed();
    }
  };

  const canAccessMenu = (menuId: string) => {
    if (menuId === 'workbench') return true;
    if (!currentUser) return false;
    return hasMenuPermission(currentUser, systemRoles || [], menuId, 'view');
  };

  const activeRouteDomains = getRequiredDomains(location.pathname);
  const isCurrentRouteDirty = activeRouteDomains.length === 0
    ? false
    : activeRouteDomains.some((domain) => dirtyDomains.includes(domain));
  const shouldGuardNavigation = isCurrentRouteDirty || (location.pathname === '/review' && isDirty);

  const headerStatus = isSaving
    ? {
        icon: <Spinner size={12} className="animate-spin text-brand-500" />,
        text: '保存中...',
        className: 'text-slate-500 bg-slate-100'
      }
    : backendError
      ? {
          icon: <AlertCircle size={14} className="text-red-500" />,
          text: backendError,
          className: 'text-red-600 bg-red-50 border border-red-100'
        }
      : isCurrentRouteDirty
        ? {
            icon: <div className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />,
            text: '未保存',
            className: 'text-amber-600 bg-amber-50 border border-amber-100'
          }
        : showSaveSuccess
          ? {
              icon: <CheckCircle size={12} className="text-emerald-500" />,
              text: '已保存',
              className: 'text-emerald-600 bg-emerald-50 border border-emerald-100'
            }
          : null;

  const handleSaveProfileName = async () => {
    if (!currentUser) return;

    const trimmedName = profileName.trim();
    if (!trimmedName) {
      setProfileError('姓名不能为空');
      setProfileSuccess(null);
      return;
    }

    if (trimmedName === currentUser.name) {
      setProfileSuccess('姓名未发生变化');
      setProfileError(null);
      return;
    }

    setIsProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      const updatedUser = await updateMyProfileName(trimmedName, currentUser.rowVersion);
      updateCurrentUser(updatedUser);
      useAppStore.setState({
        users: users.map((user) => user.id === updatedUser.id ? updatedUser : user),
        lastSavedUsers: lastSavedUsers.map((user) => user.id === updatedUser.id ? updatedUser : user)
      });
      setProfileSuccess('姓名已更新');
    } catch (error: any) {
      setProfileError(getUserFacingError(error, '姓名更新失败，请稍后重试'));
    } finally {
      setIsProfileSaving(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (!newPassword) {
      setProfileError('请输入新密码');
      setProfileSuccess(null);
      return;
    }

    if (newPassword.length < 6) {
      setProfileError('新密码至少需要 6 位');
      setProfileSuccess(null);
      return;
    }

    if (newPassword !== confirmPassword) {
      setProfileError('两次输入的密码不一致');
      setProfileSuccess(null);
      return;
    }

    setIsPasswordSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword('');
      setConfirmPassword('');
      setProfileSuccess('密码已更新');
    } catch (error: any) {
      setProfileError(getUserFacingError(error, '密码更新失败，请稍后重试'));
    } finally {
      setIsPasswordSaving(false);
    }
  };

  return (
    <div className="flex h-screen w-screen bg-slate-50 overflow-hidden relative">
      {!isSidebarCollapsed && (
        <div 
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setIsSidebarCollapsed(true)}
        />
      )}

      <aside className={`w-64 bg-slate-900 text-slate-300 flex flex-col shrink-0 fixed md:relative z-50 h-full transition-transform duration-300 ${isSidebarCollapsed ? '-translate-x-full md:translate-x-0' : 'translate-x-0'}`}>
        <div className="p-3 border-b border-slate-800 bg-slate-800/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 overflow-hidden">
              <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center shrink-0 shadow-lg shadow-brand-600/20">
                <ShieldCheck className="text-white" size={18} />
              </div>
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-1">
                  <h1 className="text-white font-black text-sm tracking-tighter leading-tight truncate">AI星组织</h1>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] font-black text-brand-400 truncate">{currentUser?.name}</span>
                  <div className="flex gap-1">
                    <button onClick={openProfileModal} className="p-0.5 hover:bg-slate-700 text-slate-500 hover:text-white rounded transition-colors" title="个人资料">
                      <Settings size={10} />
                    </button>
                    <button onClick={handleLogout} className="p-0.5 hover:bg-red-900/30 text-slate-500 hover:text-red-400 rounded transition-colors" title="退出">
                      <LogOut size={10} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <button className="md:hidden text-slate-400 hover:text-white" onClick={() => setIsSidebarCollapsed(true)}>
              <X size={18} />
            </button>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-4 overflow-y-auto custom-scrollbar">
          {MENU_GROUPS.map((group, idx) => {
            const visibleItems = group.items.filter(item => canAccessMenu(item.id));
            if (visibleItems.length === 0) return null;
            
            return (
              <div key={idx}>
                {group.label && (
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 px-3">
                    {group.label}
                  </div>
                )}
                <div className="space-y-0.5">
                  {visibleItems.map(item => {
                    const isActive = location.pathname === `/${item.id}` || location.pathname.startsWith(`/${item.id}/`);
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleNavigation(`/${item.id}`)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 text-sm font-medium ${
                          isActive 
                            ? 'bg-brand-500/10 text-brand-400 shadow-sm shadow-brand-500/5' 
                            : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                        }`}
                      >
                        <span className={`${isActive ? 'text-brand-400' : 'text-slate-500'}`}>
                          {iconMap[item.id] || <LayoutDashboard size={18} />}
                        </span>
                        <span className="truncate">{item.label}</span>
                        {isActive && <ChevronRight size={14} className="ml-auto opacity-50" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 bg-slate-50 relative h-full">
        <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 shrink-0 shadow-sm relative z-10">
          <div className="flex items-center gap-3">
            <button 
              className="md:hidden p-2 -ml-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
              onClick={() => setIsSidebarCollapsed(false)}
            >
              <Menu size={20} />
            </button>
            <h2 className="text-base font-bold text-slate-800 tracking-tight flex items-center gap-2">
              {/* You can map the current route to a title here */}
              AI星组织工作台
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {headerStatus && (
              <span className={`flex max-w-[320px] items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium ${headerStatus.className}`}>
                {headerStatus.icon}
                <span className="truncate">{headerStatus.text}</span>
              </span>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-hidden relative">
          {content ?? (
            <Suspense fallback={<ContentLoadingFallback />}>
              <Outlet />
            </Suspense>
          )}
        </div>
      </main>

      {isProfileModalOpen && currentUser && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-6">
          <div className="bg-white rounded-[2.5rem] w-full max-w-lg p-8 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-xl font-black text-slate-800">个人资料</h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">个人资料与密码</p>
              </div>
              <button onClick={closeProfileModal} className="p-2 hover:bg-slate-100 rounded-full">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-6">
              <div className="rounded-[1.5rem] border border-slate-200 p-5 space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">显示名称</label>
                  <input
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    className="mt-2 w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold outline-none focus:border-brand-500"
                    placeholder="请输入姓名"
                  />
                </div>
                <button
                  onClick={handleSaveProfileName}
                  disabled={isProfileSaving}
                  className="w-full py-3 bg-brand-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isProfileSaving ? <Spinner size={14} className="animate-spin" /> : <Save size={14} />}
                  保存姓名
                </button>
              </div>

              <div className="rounded-[1.5rem] border border-slate-200 p-5 space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">新密码</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="mt-2 w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold outline-none focus:border-brand-500"
                    placeholder="至少 6 位"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">确认新密码</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="mt-2 w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold outline-none focus:border-brand-500"
                    placeholder="再次输入新密码"
                  />
                </div>
                <button
                  onClick={handleUpdatePassword}
                  disabled={isPasswordSaving}
                  className="w-full py-3 bg-slate-900 text-white rounded-2xl text-xs font-black uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isPasswordSaving ? <Spinner size={14} className="animate-spin" /> : <Key size={14} />}
                  更新密码
                </button>
              </div>

              {profileError && (
                <div className="text-sm font-bold text-red-600 bg-red-50 border border-red-100 rounded-2xl px-4 py-3">
                  {profileError}
                </div>
              )}
              {profileSuccess && (
                <div className="text-sm font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-2xl px-4 py-3">
                  {profileSuccess}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
