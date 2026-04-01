import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { MainLayout } from '../layouts/MainLayout';
import { useAuthStore } from '../store/useAuthStore';
import { useAppStore } from '../store/useAppStore';

import WorkbenchView from '../components/WorkbenchView';
import ProcessView from '../components/ProcessView';
import OrgView from '../components/OrgView';
import StrategyView from '../components/StrategyView';
import BusinessDefinitionView from '../components/BusinessDefinitionView';
import WeeklyView from '../components/WeeklyView';
import UserView from '../components/UserView';
import RoleQueryView from '../components/RoleQueryView';
import TaskCenterView from '../components/TaskCenterView';
import ExecutionView from '../components/ExecutionView';
import ReviewView from '../components/ReviewView';
import OkrReviewDashboard from '../components/OkrReviewDashboard';
import MenuPermissionView from '../components/MenuPermissionView';
import LoginView from '../components/LoginView';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated } = useAuthStore();
  
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  
  return <>{children}</>;
};

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
          <Routes>
            <Route 
              path="/login" 
              element={isAuthenticated ? <Navigate to="/workbench" replace /> : <LoginView />} 
            />
            <Route path="/" element={<ProtectedRoute><MainLayout /></ProtectedRoute>}>
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
        </motion.div>
      )}
    </AnimatePresence>
  );
};
