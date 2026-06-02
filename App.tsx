import React, { useEffect, useRef } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './router/AppRoutes';
import { UnsavedChangesGuard } from './components/UnsavedChangesGuard';
import { useAuthStore } from '@/store/useAuthStore';
import { useAppStore } from '@/store/useAppStore';
import { getBootstrapData } from '@/data';
import { supabase } from '@/supabase';

const DEFAULT_AI_SETTINGS = {
  selectedModelId: 'gemini',
  configs: [
    { id: 'gemini', name: 'Gemini 2.5 Flash', type: 'gemini' as const, modelName: 'gemini-2.5-flash' },
    { id: 'deepseek', name: 'DeepSeek V4 Flash', type: 'deepseek' as const, modelName: 'deepseek-v4-flash' }
  ]
};

const DEFAULT_STRATEGY = {
  mission: '',
  vision: '',
  customerIssues: '',
  employeeIssues: '',
  companyOKRs: {},
  rowVersion: 0
};

const App: React.FC = () => {
  const { isAuthenticated, login } = useAuthStore();
  const { 
    setState, 
    setIsInitialLoadComplete, 
    setLastSavedAISettings,
    setLastSavedUsers,
    setLastSavedSystemRoles,
    resetDomainLoadState,
    setDomainLoadState
  } = useAppStore();

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
        resetDomainLoadState();
        try {
          const bootstrapData = await getBootstrapData();
          if (bootstrapData) {
            // Prefer auth_id mapping, fallback to username for legacy records.
            const user = bootstrapData.users?.find((u) => {
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
              const initialUsers = bootstrapData.users || [];
              const initialSystemRoles = bootstrapData.systemRoles || [];
              
              setLastSavedUsers(initialUsers);
              setLastSavedSystemRoles(initialSystemRoles);
              setLastSavedAISettings(bootstrapData.aiSettings || DEFAULT_AI_SETTINGS);
              setDomainLoadState('users', { loaded: true, loading: false });
              setDomainLoadState('systemRoles', { loaded: true, loading: false });
              setDomainLoadState('aiSettings', { loaded: true, loading: false });

              setState({
                processes: [],
                departments: [],
                businesses: [],
                users: initialUsers.length > 0 ? initialUsers : [
                  { id: 'admin-user-id', username: 'admin', name: '系统管理员', role: 'Admin' }
                ],
                systemRoles: initialSystemRoles,
                strategy: DEFAULT_STRATEGY,
                tasks: [],
                aiSettings: bootstrapData.aiSettings || DEFAULT_AI_SETTINGS
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
        resetDomainLoadState();
        useAppStore.setState({
          processes: [],
          departments: [],
          strategy: DEFAULT_STRATEGY,
          businesses: [],
          users: [],
          tasks: [],
          systemRoles: [],
          aiSettings: DEFAULT_AI_SETTINGS,
          isDirty: false,
          dirtyDomains: [],
          isSaving: false,
          showSaveSuccess: false,
          backendError: null,
          currentProcessId: null,
          lastSavedProcesses: [],
          lastSavedDepartments: [],
          lastSavedBusinesses: [],
          lastSavedTasks: [],
          lastSavedUsers: [],
          lastSavedSystemRoles: [],
          lastSavedAISettings: null,
          lastSavedStrategy: null
        });
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
  }, [login, resetDomainLoadState, setDomainLoadState, setIsInitialLoadComplete, setLastSavedAISettings, setLastSavedSystemRoles, setLastSavedUsers, setState]);

  return (
    <BrowserRouter>
      <UnsavedChangesGuard />
      <AppRoutes />
    </BrowserRouter>
  );
};

export default App;
