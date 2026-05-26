import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useAuthStore } from '../store/useAuthStore';
import { useAppStore } from '../store/useAppStore';
import { RouteDataLayout } from './RouteDataLayout';

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

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated } = useAuthStore();
  
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  
  return <>{children}</>;
};

const RouteLoadingFallback: React.FC = () => (
  <div className="h-full w-full flex flex-col items-center justify-center bg-slate-50 gap-4">
    <div className="w-10 h-10 border-4 border-brand-100 border-t-brand-600 rounded-full animate-spin" />
    <p className="text-slate-500 font-black text-xs uppercase tracking-widest animate-pulse">页面加载中...</p>
  </div>
);

export const AppRoutes: React.FC = () => {
  const { isInitialLoadComplete } = useAppStore();
  const { isAuthenticated } = useAuthStore();

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
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
              <Route 
                path="/login" 
                element={isAuthenticated ? <Navigate to="/workbench" replace /> : <LoginView />} 
              />
              <Route path="/" element={<ProtectedRoute><RouteDataLayout /></ProtectedRoute>}>
                <Route index element={<Navigate to="/workbench" replace />} />
                <Route path="workbench" element={<WorkbenchView />} />
                <Route path="process" element={<ProcessView />} />
                <Route path="org" element={<OrgView />} />
                <Route path="okr" element={<StrategyView />} />
                <Route path="business-definition" element={<BusinessDefinitionView />} />
                <Route path="weekly" element={<WeeklyView />} />
                <Route path="user" element={<UserView />} />
                <Route path="roles" element={<RoleQueryView />} />
                <Route path="task-center" element={<TaskCenterView />} />
                <Route path="execution" element={<ExecutionView />} />
                <Route path="review" element={<ReviewView />} />
                <Route path="okr-review" element={<OkrReviewDashboard />} />
                <Route path="menu-permissions" element={<MenuPermissionView />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
