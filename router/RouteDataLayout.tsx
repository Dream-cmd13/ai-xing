import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MainLayout } from '../layouts/MainLayout';
import { useAuthStore } from '../store/useAuthStore';
import { AppDomainKey, useAppStore } from '../store/useAppStore';
import {
  getBusinesses,
  getDepartments,
  getProcesses,
  getStrategy,
  getTasks
} from '../data';

const ROUTE_DOMAIN_MAP: Array<{ match: RegExp; domains: AppDomainKey[] }> = [
  { match: /^\/workbench$/, domains: ['tasks', 'departments', 'strategy'] },
  { match: /^\/process$/, domains: ['processes', 'departments'] },
  { match: /^\/org$/, domains: ['departments'] },
  { match: /^\/okr$/, domains: ['strategy', 'departments'] },
  { match: /^\/business-definition$/, domains: ['businesses', 'strategy'] },
  { match: /^\/weekly$/, domains: ['tasks', 'departments', 'strategy'] },
  { match: /^\/task-center$/, domains: ['tasks', 'departments', 'strategy'] },
  { match: /^\/execution$/, domains: ['tasks', 'departments', 'strategy'] },
  { match: /^\/review$/, domains: ['tasks', 'departments', 'strategy'] },
  { match: /^\/okr-review$/, domains: ['departments'] },
  { match: /^\/user$/, domains: ['departments'] },
  { match: /^\/roles$/, domains: ['processes', 'departments'] },
  { match: /^\/menu-permissions$/, domains: ['departments'] }
];

const getRequiredDomains = (pathname: string): AppDomainKey[] => {
  const matched = ROUTE_DOMAIN_MAP.find((route) => route.match.test(pathname));
  return matched?.domains || [];
};

const RouteLoadingFallback: React.FC = () => (
  <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-50 gap-4">
    <div className="w-12 h-12 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin" />
    <p className="text-slate-500 font-black text-xs uppercase tracking-widest animate-pulse">页面数据加载中...</p>
  </div>
);

const RouteLoadError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="h-screen w-screen flex items-center justify-center bg-slate-50 p-6">
    <div className="max-w-md w-full bg-white rounded-[2.5rem] border border-slate-200 shadow-sm p-10 text-center">
      <h2 className="text-xl font-black text-slate-800">页面数据加载失败</h2>
      <p className="text-sm text-slate-500 mt-3 leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-8 px-6 py-3 bg-brand-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-lg hover:bg-brand-700 transition-all"
      >
        重新加载
      </button>
    </div>
  </div>
);

export const RouteDataLayout: React.FC = () => {
  const location = useLocation();
  const { isAuthenticated } = useAuthStore();
  const {
    domainLoadStatus,
    setDomainLoadState,
    setState,
    setBackendError,
    setLastSavedBusinesses,
    setLastSavedDepartments,
    setLastSavedProcesses,
    setLastSavedStrategy,
    setLastSavedTasks
  } = useAppStore();
  const [routeError, setRouteError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const requiredDomains = useMemo(() => getRequiredDomains(location.pathname), [location.pathname]);

  useEffect(() => {
    if (!isAuthenticated || requiredDomains.length === 0) {
      setRouteError(null);
      return;
    }

    const currentDomainLoadStatus = useAppStore.getState().domainLoadStatus;
    const missingDomains = requiredDomains.filter((domain) => {
      const status = currentDomainLoadStatus[domain];
      return !status.loaded && !status.loading;
    });
    if (missingDomains.length === 0) {
      setRouteError(null);
      return;
    }

    let cancelled = false;
    setRouteError(null);
    missingDomains.forEach((domain) => setDomainLoadState(domain, { loading: true }));

    const loaders: Record<AppDomainKey, () => Promise<void>> = {
      users: async () => {},
      systemRoles: async () => {},
      aiSettings: async () => {},
      departments: async () => {
        const departments = await getDepartments();
        if (cancelled) return;
        setState({ departments });
        setLastSavedDepartments(departments);
        setDomainLoadState('departments', { loaded: true });
      },
      processes: async () => {
        const processes = await getProcesses();
        if (cancelled) return;
        setState({ processes });
        setLastSavedProcesses(processes);
        setDomainLoadState('processes', { loaded: true });
      },
      strategy: async () => {
        const strategy = await getStrategy();
        if (cancelled) return;
        setState({ strategy });
        setLastSavedStrategy(strategy);
        setDomainLoadState('strategy', { loaded: true });
      },
      businesses: async () => {
        const businesses = await getBusinesses();
        if (cancelled) return;
        setState({ businesses });
        setLastSavedBusinesses(businesses);
        setDomainLoadState('businesses', { loaded: true });
      },
      tasks: async () => {
        const tasks = await getTasks();
        if (cancelled) return;
        setState({ tasks });
        setLastSavedTasks(tasks);
        setDomainLoadState('tasks', { loaded: true });
      }
    };

    Promise.all(missingDomains.map((domain) => loaders[domain]()))
      .catch((error: any) => {
        if (cancelled) return;
        const message = error?.message || '页面数据加载失败';
        setRouteError(message);
        setBackendError(message);
      })
      .finally(() => {
        if (cancelled) return;
        missingDomains.forEach((domain) => setDomainLoadState(domain, { loading: false }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    isAuthenticated,
    requiredDomains,
    retryToken,
    setBackendError,
    setDomainLoadState,
    setLastSavedBusinesses,
    setLastSavedDepartments,
    setLastSavedProcesses,
    setLastSavedStrategy,
    setLastSavedTasks,
    setState
  ]);

  const isRouteLoading = requiredDomains.some((domain) => {
    const status = domainLoadStatus[domain];
    return !status.loaded || status.loading;
  });

  if (routeError && isRouteLoading) {
    return <RouteLoadError message={routeError} onRetry={() => setRetryToken((value) => value + 1)} />;
  }

  if (isRouteLoading) {
    return <RouteLoadingFallback />;
  }

  return <MainLayout />;
};
