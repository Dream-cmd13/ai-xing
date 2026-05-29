import React, { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useAuthStore } from '../store/useAuthStore';
import { useAppStore } from '../store/useAppStore';
import { RouteDataLayout } from './RouteDataLayout';
import { hasPermission } from '../utils/permissions';
import { Lock } from 'lucide-react';

const WorkbenchView = lazy(() => import('../components/WorkbenchView'));
const ProcessView = lazy(() => import('../components/ProcessView'));
const OrgView = lazy(() => import('../components/OrgView'));
const StrategyView = lazy(() => import('../components/StrategyView'));
const BusinessDefinitionView = lazy(() => import('../components/BusinessDefinitionView'));
const WeeklyView = lazy(() => import('../components/WeeklyView'));
const UserView = lazy(() => import('../components/UserView'));
const RoleQueryView = lazy(() => import('../components/RoleQueryView'));
const TaskCenterView = lazy(() => import('../components/TaskCenterView'));
const ExecutionView = lazy(() => import('../components/ExecutionView'));
const ReviewView = lazy(() => import('../components/ReviewView'));
const OkrReviewDashboard = lazy(() => import('../components/OkrReviewDashboard'));
const MenuPermissionView = lazy(() => import('../components/MenuPermissionView'));
const LoginView = lazy(() => import('../components/LoginView'));

const ProtectedRoute = ({ children, menuId }: { children: React.ReactNode, menuId?: string }) => {
  const { isAuthenticated, currentUser } = useAuthStore();
  const { systemRoles } = useAppStore();
  
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (menuId && currentUser) {
    const canView = hasPermission(currentUser, systemRoles || [], menuId, 'view');
    if (!canView) {
      return (
        <div className="h-full w-full flex items-center justify-center bg-slate-50 absolute inset-0 z-50">
          <div className="text-center bg-white p-12 rounded-[3rem] border shadow-sm flex flex-col items-center">
            <div className="w-20 h-20 bg-slate-50 text-slate-300 rounded-full flex items-center justify-center mb-6">
              <Lock size={32} />
            </div>
            <h2 className="text-xl font-black text-slate-800">权限不足</h2>
            <p className="text-slate-400 text-sm mt-2">您没有访问该页面的权限，或该菜单已对您隐藏。</p>
          </div>
        </div>
      );
    }
  }
  
  return <>{children}</>;
};

const LoginRouteLoadingFallback: React.FC = () => (
  <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-50 gap-4">
    <div className="w-10 h-10 border-4 border-brand-100 border-t-brand-600 rounded-full animate-spin" />
    <p className="text-slate-500 font-black text-xs uppercase tracking-widest animate-pulse">页面加载中...</p>
  </div>
);

export const AppRoutes: React.FC = () => {
  const { isInitialLoadComplete, setShowSaveSuccess } = useAppStore();
  const { isAuthenticated } = useAuthStore();
  const location = useLocation();

  useEffect(() => {
    setShowSaveSuccess(false);
  }, [location.pathname, setShowSaveSuccess]);

  return (
    <AnimatePresence mode="wait">
      {!isInitialLoadComplete ? (
        <motion.div 
          key="loading"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="h-screen w-screen flex flex-col items-center justify-center bg-slate-50 gap-4"
        >
          <div className="w-12 h-12 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin" />
          <p className="text-slate-500 font-black text-xs uppercase tracking-widest animate-pulse">正在初始化系统...</p>
        </motion.div>
      ) : (
        <motion.div 
          key="content"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
          className="h-full w-full"
        >
          <Routes>
            <Route 
              path="/login" 
              element={
                isAuthenticated ? (
                  <Navigate to="/workbench" replace />
                ) : (
                  <Suspense fallback={<LoginRouteLoadingFallback />}>
                    <LoginView />
                  </Suspense>
                )
              } 
            />
            <Route path="/" element={<ProtectedRoute><RouteDataLayout /></ProtectedRoute>}>
              <Route index element={<Navigate to="/workbench" replace />} />
              <Route path="workbench" element={<ProtectedRoute menuId="workbench"><WorkbenchView /></ProtectedRoute>} />
              <Route path="process" element={<ProtectedRoute menuId="process"><ProcessView /></ProtectedRoute>} />
              <Route path="org" element={<ProtectedRoute menuId="org"><OrgView /></ProtectedRoute>} />
              <Route path="okr" element={<ProtectedRoute menuId="okr"><StrategyView /></ProtectedRoute>} />
              <Route path="business-definition" element={<ProtectedRoute menuId="business-definition"><BusinessDefinitionView /></ProtectedRoute>} />
              <Route path="weekly" element={<ProtectedRoute menuId="execution"><WeeklyView /></ProtectedRoute>} />
              <Route path="user" element={<ProtectedRoute menuId="user"><UserView /></ProtectedRoute>} />
              <Route path="roles" element={<ProtectedRoute menuId="roles"><RoleQueryView /></ProtectedRoute>} />
              <Route path="task-center" element={<ProtectedRoute menuId="task-center"><TaskCenterView /></ProtectedRoute>} />
              <Route path="execution" element={<ProtectedRoute menuId="execution"><ExecutionView /></ProtectedRoute>} />
              <Route path="review" element={<ProtectedRoute menuId="okr-review"><ReviewView /></ProtectedRoute>} />
              <Route path="okr-review" element={<ProtectedRoute menuId="okr-review"><OkrReviewDashboard /></ProtectedRoute>} />
              <Route path="menu-permissions" element={<ProtectedRoute menuId="menu-permissions"><MenuPermissionView /></ProtectedRoute>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
