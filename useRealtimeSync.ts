import React, { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { supabase } from './supabase';
import { AppState, CompanyStrategy, BusinessDefinition, Department, ProcessDefinition, PADEntry } from './types';
import { matchesPendingMutation, normalizeForConflictComparison } from './syncConflictGuard';
import { getLastSavedTask, hasTaskLocalChanges } from './utils/taskSyncState.js';

const mapPayloadToState = (table: string, data: any) => {
  if (!data) return data;
  switch (table) {
    case 'strategy':
      return {
        id: data.id || 'default',
        mission: data.mission || '',
        vision: data.vision || '',
        customerIssues: data.customer_issues || '',
        employeeIssues: data.employee_issues || '',
        companyOKRs: typeof data.company_okrs === 'string' ? JSON.parse(data.company_okrs) : (data.company_okrs || {}),
        updatedAt: data.updated_at,
        rowVersion: typeof data.row_version === 'number' ? data.row_version : Number(data.row_version || 0)
      };
    case 'businesses':
      return {
        id: data.id,
        name: data.name,
        businessFormat: data.business_format,
        customerPersona: data.customer_persona,
        customerNeeds: data.customer_needs,
        surfaceProductPower: data.surface_product_power,
        coreProductPower: data.core_product_power,
        updatedAt: data.updated_at,
        rowVersion: typeof data.row_version === 'number' ? data.row_version : Number(data.row_version || 0)
      };
    case 'tasks':
      return {
        id: data.id,
        title: data.title,
        status: data.status,
        priority: data.priority,
        ownerId: data.owner_id,
        departmentId: data.department_id,
        visibility: data.visibility,
        alignedKrId: data.aligned_kr_id,
        targetWeeks: data.target_weeks || [],
        startDate: data.start_date,
        dueDate: data.due_date,
        tags: data.tags || [],
        participantIds: data.participant_ids || [],
        approverIds: data.approver_ids || [],
        logs: data.logs || [],
        plan: data.plan,
        action: data.action,
        deliverable: data.deliverable,
        updatedAt: data.updated_at,
        rowVersion: typeof data.row_version === 'number' ? data.row_version : Number(data.row_version || 0)
      };
    case 'processes':
      return {
        id: data.id,
        name: data.name,
        category: data.category,
        level: data.level,
        version: data.version,
        isActive: data.is_active,
        type: data.type,
        owner: data.owner ?? '',
        coOwner: data.co_owner ?? '',
        objective: data.objective ?? '',
        nodes: typeof data.nodes === 'string' ? JSON.parse(data.nodes) : (data.nodes || []),
        links: typeof data.links === 'string' ? JSON.parse(data.links) : (data.links || []),
        history: typeof data.history === 'string' ? JSON.parse(data.history) : (data.history || []),
        updatedAt: data.updated_at,
        rowVersion: typeof data.row_version === 'number' ? data.row_version : Number(data.row_version || 0)
      };
    case 'departments':
      return {
        id: data.id,
        name: data.name,
        managerName: data.manager_name ?? '',
        responsibilities: data.responsibilities ?? '',
        roles: typeof data.roles === 'string' ? JSON.parse(data.roles) : (data.roles || []),
        roleMembers: typeof data.role_members === 'string' ? JSON.parse(data.role_members) : (data.role_members || {}),
        attributes: data.attributes ?? '',
        subDepartments: typeof data.sub_departments === 'string' ? JSON.parse(data.sub_departments) : (data.sub_departments || []),
        okrs: typeof data.okrs === 'string' ? JSON.parse(data.okrs) : (data.okrs || {}),
        reviews: typeof data.reviews === 'string' ? JSON.parse(data.reviews) : (data.reviews || {}),
        updatedAt: data.updated_at,
        rowVersion: typeof data.row_version === 'number' ? data.row_version : Number(data.row_version || 0)
      };
    default:
      return data;
  }
};

export const useRealtimeSync = (
  setState: React.Dispatch<React.SetStateAction<AppState>>,
  isAuthenticated: boolean
) => {
  useEffect(() => {
    if (!isAuthenticated) return;

    const channel = supabase.channel('workspace-sync');

    const hasUnsavedChanges = () => {
      const store = useAppStore.getState() as any;
      return Boolean(store.isDirty);
    };

    const shouldKeepLocalArray = (table: string, itemId: string | undefined, currentData: any[]) => {
      if (!itemId || !hasUnsavedChanges()) return false;
      const store = useAppStore.getState() as any;
      const localItem = currentData.find(item => item.id === itemId);
      if (!localItem) return false;

      let lastSavedItem = null;
      if (table === 'businesses') {
        lastSavedItem = store.lastSavedBusinesses.find((item: any) => item.id === itemId);
      } else if (table === 'departments') {
        lastSavedItem = store.lastSavedDepartments.find((item: any) => item.id === itemId);
      } else if (table === 'processes') {
        lastSavedItem = store.lastSavedProcesses.find((item: any) => item.id === itemId);
      } else if (table === 'tasks') {
        lastSavedItem = getLastSavedTask(store.lastSavedTasks || [], itemId);
      }

      if (!lastSavedItem) return false;
      if (table === 'tasks') {
        return hasTaskLocalChanges(currentData, store.lastSavedTasks || [], itemId);
      }
      return normalizeForConflictComparison(localItem) !== normalizeForConflictComparison(lastSavedItem);
    };

    const shouldKeepLocalStrategy = () => {
      const store = useAppStore.getState() as any;
      if (!store.isDirty || !store.lastSavedStrategy) return false;
      return normalizeForConflictComparison(store.strategy) !== normalizeForConflictComparison(store.lastSavedStrategy);
    };

    const applyArrayChange = (payload: any, updatedData: any[], mappedNew: any) => {
      switch (payload.eventType) {
        case 'INSERT':
          if (!updatedData.find(item => item.id === mappedNew.id)) {
            updatedData.push(mappedNew);
          }
          break;
        case 'UPDATE':
          updatedData = updatedData.map(item => item.id === mappedNew.id ? mappedNew : item);
          break;
        case 'DELETE':
          updatedData = updatedData.filter(item => item.id !== payload.old.id);
          break;
      }
      return updatedData;
    };

    const handleTableChange = (table: string, payload: any) => {
      const mappedNew = mapPayloadToState(table, payload.new);
      const mappedOld = payload.old ? mapPayloadToState(table, payload.old) : null;

      setState(prevState => {
        const newState = { ...prevState } as any;

        if (table === 'strategy') {
          if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
            const isPendingEcho = matchesPendingMutation('strategy', mappedNew.id || 'default', mappedNew);

            if (isPendingEcho) {
              newState.lastSavedStrategy = mappedNew;
              if (!shouldKeepLocalStrategy()) {
                newState.strategy = mappedNew;
              }
              return newState;
            }

            if (shouldKeepLocalStrategy()) {
              return prevState;
            }

            newState.strategy = mappedNew as CompanyStrategy;
            newState.lastSavedStrategy = mappedNew as CompanyStrategy;
          }
          return newState;
        }

        const stateKey = table as keyof AppState;
        const currentData = prevState[stateKey] as any[];
        if (!Array.isArray(currentData)) return prevState;

        const itemId = mappedNew?.id || mappedOld?.id;
        const isPendingEcho = mappedNew && itemId ? matchesPendingMutation(table, itemId, mappedNew) : false;

        if (isPendingEcho) {
          if (table === 'businesses') {
            newState.lastSavedBusinesses = currentData.map(item => item.id === mappedNew.id ? mappedNew : item);
          } else if (table === 'departments') {
            newState.lastSavedDepartments = currentData.map(item => item.id === mappedNew.id ? mappedNew : item);
          } else if (table === 'processes') {
            newState.lastSavedProcesses = currentData.map(item => item.id === mappedNew.id ? mappedNew : item);
          } else if (table === 'tasks') {
            newState.lastSavedTasks = currentData.map(item => item.id === mappedNew.id ? mappedNew : item);
          }

          if (!shouldKeepLocalArray(table, itemId, currentData)) {
            newState[stateKey] = applyArrayChange(payload, [...currentData], mappedNew) as any;
          } else {
            newState[stateKey] = currentData;
          }
          return newState;
        }

        if (shouldKeepLocalArray(table, itemId, currentData)) {
          return prevState;
        }

        let updatedData = applyArrayChange(payload, [...currentData], mappedNew);

        newState[stateKey] = updatedData as any;

        if (table === 'businesses') {
          newState.lastSavedBusinesses = updatedData;
        } else if (table === 'departments') {
          newState.lastSavedDepartments = updatedData;
        } else if (table === 'processes') {
          newState.lastSavedProcesses = updatedData;
        } else if (table === 'tasks') {
          newState.lastSavedTasks = updatedData;
        }

        return newState;
      });
    };

    ['tasks', 'processes', 'departments', 'strategy', 'businesses'].forEach(table => {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => handleTableChange(table, payload)
      );
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('Successfully subscribed to realtime updates');
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [setState, isAuthenticated]);
};
