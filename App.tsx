import React, { useEffect, useRef } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppRoutes } from './router/AppRoutes';
import { UnsavedChangesGuard } from './components/UnsavedChangesGuard';
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
    setLastSavedTasks,
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
      const email = (session?.user?.email || '').toLowerCase();
      const accountFromEmail = email.includes('@') ? email.split('@')[0] : email;

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
            // Prefer auth_id mapping, fallback to username for legacy records.
            const user = workspace.users?.find((u) => {
              if (u.auth_id === userId) return true;
              if (!accountFromEmail) return false;
              return (u.username || '').toLowerCase() === accountFromEmail;
            });
            if (user) {
              // Backfill auth_id so subsequent logins can map directly.
              if (user.auth_id !== userId) {
                const { error: bindError } = await supabase
                  .from('users')
                  .update({ auth_id: userId })
                  .eq('id', user.id);
                if (bindError) {
                  console.warn('Failed to backfill auth_id for user', bindError);
                } else {
                  user.auth_id = userId;
                }
              }

              lastProcessedUserIdRef.current = userId;
              login(user);
              const initialProcesses = workspace.processes || [];
              const initialDepartments = workspace.departments || [];
              const initialBusinesses = workspace.businesses || [];
              const initialUsers = workspace.users || [];
              const initialSystemRoles = workspace.systemRoles || [];
              const initialTasks = workspace.tasks || [];
              const initialStrategy = {
                mission: workspace.strategy?.mission || '',
                vision: workspace.strategy?.vision || '',
                customerIssues: workspace.strategy?.customerIssues || '',
                employeeIssues: workspace.strategy?.employeeIssues || '',
                companyOKRs: workspace.strategy?.companyOKRs || {},
                updatedAt: workspace.strategy?.updatedAt,
                rowVersion: workspace.strategy?.rowVersion || 0
              };
              
              setLastSavedProcesses(initialProcesses);
              setLastSavedDepartments(initialDepartments);
              setLastSavedBusinesses(initialBusinesses);
              setLastSavedTasks(initialTasks);
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
                tasks: initialTasks,
                aiSettings: workspace.aiSettings || {
                  selectedModelId: 'gemini',
                  configs: [
                    { id: 'gemini', name: 'Gemini 3 Flash Preview', type: 'gemini', apiKey: 'ENV_KEY' }
                  ]
                }
              });
            } else {
              console.warn("User not found in workspace data, auth session will not be activated");
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
      <UnsavedChangesGuard />
      <AppRoutes />
    </BrowserRouter>
  );
};

export default App;
