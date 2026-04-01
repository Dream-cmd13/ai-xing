import React, { useEffect, useRef } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppRoutes } from './router/AppRoutes';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppStore } from '@/store/useAppStore';
import { getWorkspace } from '@/data';
import { useRealtimeSync } from '@/useRealtimeSync';
import { supabase } from '@/supabase';

const App: React.FC = () => {
  const { isAuthenticated, login } = useAuthStore();
  const { 
    setState, 
    setIsInitialLoadComplete, 
    isInitialLoadComplete,
    setLastSavedProcesses, 
    setLastSavedDepartments, 
    setLastSavedBusinesses,
    setLastSavedUsers,
    setLastSavedSystemRoles,
    setLastSavedStrategy
  } = useAppStore();

  const { isSaving, isDirty } = useAppStore();
  const isSavingRef = useRef(isSaving);
  const isDirtyRef = useRef(isDirty);
  const lastProcessedUserIdRef = useRef<string | null>(null);
  const isInitializingRef = useRef(false);

  useEffect(() => {
    const handleAuthChange = async (session: any) => {
      const { isAuthenticated: currentIsAuthenticated } = useAuthStore.getState();
      const userId = session?.user?.id;

      if (userId) {
        // If already processed this user and we are authenticated, don't reload everything
        if (lastProcessedUserIdRef.current === userId && currentIsAuthenticated) {
          setIsInitialLoadComplete(true);
          return;
        }

        // Avoid concurrent initialization
        if (isInitializingRef.current) return;

        isInitializingRef.current = true;
        setIsInitialLoadComplete(false);
        try {
          const workspace = await getWorkspace();
          if (workspace) {
            // Find user by auth_id instead of username
            const user = workspace.users?.find(u => u.auth_id === userId);
            if (user) {
              lastProcessedUserIdRef.current = userId;
              login(user);
              const initialProcesses = workspace.processes || [];
              const initialDepartments = workspace.departments || [];
              const initialBusinesses = workspace.businesses || [];
              const initialUsers = workspace.users || [];
              const initialSystemRoles = workspace.systemRoles || [];
              const initialStrategy = {
                mission: workspace.strategy?.mission || '',
                vision: workspace.strategy?.vision || '',
                customerIssues: workspace.strategy?.customerIssues || '',
                employeeIssues: workspace.strategy?.employeeIssues || '',
                companyOKRs: workspace.strategy?.companyOKRs || {}
              };
              
              setLastSavedProcesses(initialProcesses);
              setLastSavedDepartments(initialDepartments);
              setLastSavedBusinesses(initialBusinesses);
              setLastSavedUsers(initialUsers);
              setLastSavedSystemRoles(initialSystemRoles);
              setLastSavedStrategy(initialStrategy);

              setState({
                ...workspace,
                processes: initialProcesses,
                departments: initialDepartments,
                businesses: initialBusinesses,
                users: initialUsers.length > 0 ? initialUsers : [
                  { id: 'admin-user-id', username: 'admin', name: '系统管理员', role: 'Admin' }
                ],
                systemRoles: initialSystemRoles,
                strategy: initialStrategy,
                tasks: workspace.tasks || [],
                aiSettings: workspace.aiSettings || {
                  selectedModelId: 'gemini',
                  configs: [
                    { id: 'gemini', name: 'Gemini 3 Flash Preview', type: 'gemini', apiKey: 'ENV_KEY' }
                  ]
                }
              });
            } else {
              console.warn("User not found in workspace data");
            }
          }
        } catch (e) {
          console.error("Session restore failed", e);
        } finally {
          isInitializingRef.current = false;
          setIsInitialLoadComplete(true);
        }
      } else {
        // Clear auth if session is lost
        if (currentIsAuthenticated) {
          // We don't call logout() here because it calls signOut() which might cause a loop
          // Just clear the local store state
          useAuthStore.setState({ isAuthenticated: false, currentUser: null });
        }
        lastProcessedUserIdRef.current = null;
        setIsInitialLoadComplete(true);
      }
    };

    // Check initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      handleAuthChange(session);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      handleAuthChange(session);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [login, setState, setIsInitialLoadComplete]);

  useEffect(() => {
    isSavingRef.current = isSaving;
  }, [isSaving]);
  
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useRealtimeSync(setState, isAuthenticated);

  return (
    <BrowserRouter>
      <Toaster position="top-center" richColors />
      <AppRoutes />
    </BrowserRouter>
  );
};

export default App;
