import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { useAppStore } from '../store/useAppStore';
import { MENU_GROUPS } from '../constants';
import { hasPermission as hasMenuPermission } from '../utils/permissions';
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

export const MainLayout: React.FC = () => {
  const { currentUser, logout } = useAuthStore();
  const { isDirty, isSaving, showSaveSuccess, backendError, systemRoles } = useAppStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleNavigation = (path: string) => {
    if (isDirty) {
      // In a real app, you might want to show a modal here
      // For now, we just navigate
      navigate(path);
    } else {
      navigate(path);
      setIsSidebarCollapsed(true);
    }
  };

  const canAccessMenu = (menuId: string) => {
    if (menuId === 'workbench') return true;
    if (!currentUser) return false;
    return hasMenuPermission(currentUser, systemRoles || [], menuId, 'view');
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
            {backendError && (
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 bg-red-50 px-2.5 py-1.5 rounded-full border border-red-100">
                <AlertCircle size={14} />
                <span>{backendError}</span>
              </div>
            )}
            
            <div className="flex items-center gap-2">
              {isSaving && (
                <span className="text-xs text-slate-500 flex items-center gap-1.5 bg-slate-100 px-2.5 py-1.5 rounded-full font-medium">
                  <Spinner size={12} className="animate-spin text-brand-500" />
                  保存中...
                </span>
              )}
              {showSaveSuccess && !isSaving && (
                <span className="text-xs text-emerald-600 flex items-center gap-1.5 bg-emerald-50 px-2.5 py-1.5 rounded-full font-medium border border-emerald-100 animate-in fade-in duration-300">
                  <CheckCircle size={12} />
                  已保存
                </span>
              )}
              {isDirty && !isSaving && (
                <span className="text-xs text-amber-600 flex items-center gap-1.5 bg-amber-50 px-2.5 py-1.5 rounded-full font-medium border border-amber-100">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  未保存
                </span>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-hidden relative">
          <Outlet />
        </div>
      </main>
    </div>
  );
};
