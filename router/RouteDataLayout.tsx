import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { getRequiredDomains } from '../utils/routeDomains';

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
  const routeLoadKeyRef = useRef('');
  const domainRequestVersionRef = useRef<Record<AppDomainKey, number>>({
    users: 0,
    systemRoles: 0,
    aiSettings: 0,
    departments: 0,
    processes: 0,
    strategy: 0,
    businesses: 0,
    tasks: 0
  });

  const requiredDomains = useMemo(() => getRequiredDomains(location.pathname), [location.pathname]);

  useEffect(() => {
    setRouteError(null);
  }, [location.pathname, retryToken]);

  useEffect(() => {
    if (!isAuthenticated || requiredDomains.length === 0 || routeError) {
      return;
    }

    const routeLoadKey = `${location.pathname}:${retryToken}:${requiredDomains.join(',')}`;
    routeLoadKeyRef.current = routeLoadKey;

    const currentDomainLoadStatus = useAppStore.getState().domainLoadStatus;
    const missingDomains = requiredDomains.filter((domain) => {
      const status = currentDomainLoadStatus[domain];
      return !status.loaded && !status.loading;
    });
    if (missingDomains.length === 0) {
      return;
    }
    const requestVersions = Object.fromEntries(
      missingDomains.map((domain) => {
        const nextVersion = domainRequestVersionRef.current[domain] + 1;
        domainRequestVersionRef.current[domain] = nextVersion;
        return [domain, nextVersion];
      })
    ) as Record<AppDomainKey, number>;

    missingDomains.forEach((domain) => setDomainLoadState(domain, { loading: true }));

    const loaders: Record<AppDomainKey, () => Promise<void>> = {
      users: async () => {},
      systemRoles: async () => {},
      aiSettings: async () => {},
      departments: async () => {
        const departments = await getDepartments();
        if (routeLoadKeyRef.current !== routeLoadKey) return;
        if (domainRequestVersionRef.current.departments !== requestVersions.departments) return;
        setState({ departments });
        setLastSavedDepartments(departments);
        setDomainLoadState('departments', { loaded: true });
      },
      processes: async () => {
        const processes = await getProcesses();
        if (routeLoadKeyRef.current !== routeLoadKey) return;
        if (domainRequestVersionRef.current.processes !== requestVersions.processes) return;
        setState({ processes });
        setLastSavedProcesses(processes);
        setDomainLoadState('processes', { loaded: true });
      },
      strategy: async () => {
        const strategy = await getStrategy();
        if (routeLoadKeyRef.current !== routeLoadKey) return;
        if (domainRequestVersionRef.current.strategy !== requestVersions.strategy) return;
        setState({ strategy });
        setLastSavedStrategy(strategy);
        setDomainLoadState('strategy', { loaded: true });
      },
      businesses: async () => {
        const businesses = await getBusinesses();
        if (routeLoadKeyRef.current !== routeLoadKey) return;
        if (domainRequestVersionRef.current.businesses !== requestVersions.businesses) return;
        setState({ businesses });
        setLastSavedBusinesses(businesses);
        setDomainLoadState('businesses', { loaded: true });
      },
      tasks: async () => {
        const tasks = await getTasks();
        if (routeLoadKeyRef.current !== routeLoadKey) return;
        if (domainRequestVersionRef.current.tasks !== requestVersions.tasks) return;
        setState({ tasks });
        setLastSavedTasks(tasks);
        setDomainLoadState('tasks', { loaded: true });
      }
    };

    Promise.all(missingDomains.map((domain) => loaders[domain]()))
      .catch((error: any) => {
        if (routeLoadKeyRef.current !== routeLoadKey) return;
        const message = error?.message || '页面数据加载失败';
        setRouteError(message);
        setBackendError(message);
      })
      .finally(() => {
        missingDomains.forEach((domain) => {
          if (domainRequestVersionRef.current[domain] === requestVersions[domain]) {
            setDomainLoadState(domain, { loading: false });
          }
        });
      });
  }, [
    location.pathname,
    isAuthenticated,
    domainLoadStatus,
    routeError,
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
