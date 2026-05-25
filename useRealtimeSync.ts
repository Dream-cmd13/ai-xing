import React, { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { supabase } from './supabase';
import { AppState, CompanyStrategy, BusinessDefinition, Department, ProcessDefinition, PADEntry } from './types';
import { toast } from 'sonner';
import { matchesPendingMutation, normalizeForConflictComparison } from './syncConflictGuard';

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
        owner: data.owner,
        coOwner: data.co_owner,
        objective: data.objective,
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
        managerName: data.manager_name,
        responsibilities: data.responsibilities,
        roles: typeof data.roles === 'string' ? JSON.parse(data.roles) : (data.roles || []),
        roleMembers: typeof data.role_members === 'string' ? JSON.parse(data.role_members) : (data.role_members || {}),
        attributes: typeof data.attributes === 'string' ? JSON.parse(data.attributes) : data.attributes,
        subDepartments: typeof data.sub_departments === 'string' ? JSON.parse(data.sub_departments) : data.sub_departments,
        okrs: typeof data.okrs === 'string' ? JSON.parse(data.okrs) : data.okrs,
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

    const handleTableChange = (table: string, payload: any) => {
      const mappedNew = mapPayloadToState(table, payload.new);
      const mappedOld = payload.old ? mapPayloadToState(table, payload.old) : null;

      setState(prevState => {
        const newState = { ...prevState } as any;
        
        const isEqualIgnoringMetadata = (a: any, b: any) => {
          if (!a || !b) return a === b;
          return normalizeForConflictComparison(a) === normalizeForConflictComparison(b);
        };

        // Granular Sync Guard for Strategy
        if (table === 'strategy') {
          if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
            const currentStrategy = prevState.strategy || { mission: '', vision: '', customerIssues: '', employeeIssues: '', companyOKRs: {} };
            const lastSavedStrategy = newState.lastSavedStrategy;
            const isPendingEcho = matchesPendingMutation('strategy', mappedNew.id || 'default', mappedNew);
            
            const isEcho = isPendingEcho || isEqualIgnoringMetadata(mappedNew, currentStrategy);
            if (isEcho) {
              newState.strategy = mappedNew;
              newState.lastSavedStrategy = mappedNew;
              return newState;
            }

            const hasLocalChanges = lastSavedStrategy && !isEqualIgnoringMetadata(currentStrategy, lastSavedStrategy);
            if (hasLocalChanges) {
              toast.warning('战略数据已被他人更新，请刷新后再继续保存。');
              console.log('Realtime: Skipping strategy update due to local changes');
              return prevState;
            }

            // Timestamp check for strategy
            if (currentStrategy.updatedAt && mappedNew.updatedAt) {
              const localTs = typeof currentStrategy.updatedAt === 'number' ? currentStrategy.updatedAt : new Date(currentStrategy.updatedAt).getTime();
              const serverTs = typeof mappedNew.updatedAt === 'number' ? mappedNew.updatedAt : new Date(mappedNew.updatedAt).getTime();
              if (serverTs <= localTs) {
                return prevState;
              }
            }

            const updatedStrategy = { ...currentStrategy };
            const payloadKeys = Object.keys(payload.new);
            
            if (payloadKeys.includes('mission')) updatedStrategy.mission = mappedNew.mission;
            if (payloadKeys.includes('vision')) updatedStrategy.vision = mappedNew.vision;
            if (payloadKeys.includes('customer_issues')) updatedStrategy.customerIssues = mappedNew.customerIssues;
            if (payloadKeys.includes('employee_issues')) updatedStrategy.employeeIssues = mappedNew.employeeIssues;
            if (payloadKeys.includes('company_okrs')) updatedStrategy.companyOKRs = mappedNew.companyOKRs;

            newState.strategy = updatedStrategy as CompanyStrategy;
            newState.lastSavedStrategy = updatedStrategy as CompanyStrategy;
          }
          return newState;
        }

        const stateKey = table as keyof AppState;
        const currentData = prevState[stateKey] as any[];
        
        if (!Array.isArray(currentData)) return prevState;

        let updatedData = [...currentData];

        // Granular Sync Guard for Departments and other arrays
        if (table === 'departments' || table === 'processes' || table === 'businesses') {
          const itemId = mappedNew?.id || mappedOld?.id;
          const localItem = currentData.find(item => item.id === itemId);
          
          let lastSavedItem = null;
          if (table === 'businesses') {
            lastSavedItem = newState.lastSavedBusinesses.find((item: any) => item.id === itemId);
          } else if (table === 'departments') {
            lastSavedItem = newState.lastSavedDepartments.find((item: any) => item.id === itemId);
          } else if (table === 'processes') {
            lastSavedItem = newState.lastSavedProcesses.find((item: any) => item.id === itemId);
          }
          
          const hasLocalChanges = localItem && lastSavedItem && !isEqualIgnoringMetadata(localItem, lastSavedItem);
          const isPendingEcho = mappedNew && itemId ? matchesPendingMutation(table, itemId, mappedNew) : false;
          const isEcho = Boolean(mappedNew && localItem && isEqualIgnoringMetadata(localItem, mappedNew)) || isPendingEcho;

          if (isEcho) {
            if (table === 'businesses') {
              newState.lastSavedBusinesses = currentData.map(item => item.id === mappedNew.id ? mappedNew : item);
            } else if (table === 'departments') {
              newState.lastSavedDepartments = currentData.map(item => item.id === mappedNew.id ? mappedNew : item);
            } else if (table === 'processes') {
              newState.lastSavedProcesses = currentData.map(item => item.id === mappedNew.id ? mappedNew : item);
            }
            newState[stateKey] = currentData.map(item => item.id === mappedNew.id ? mappedNew : item) as any;
            return newState;
          }

          if (hasLocalChanges && (payload.eventType === 'UPDATE' || payload.eventType === 'DELETE')) {
            toast.warning(`${table} 数据已被他人更新，请刷新后再继续保存。`);
            console.log(`Realtime: Skipping ${table} update for ${localItem.id} due to local changes`);
            return prevState;
          }

          // Timestamp check for processes, businesses to avoid older updates overwriting newer local state
          if ((table === 'processes' || table === 'businesses') && localItem && mappedNew && mappedNew.updatedAt) {
            const localTs = typeof localItem.updatedAt === 'number' ? localItem.updatedAt : new Date(localItem.updatedAt).getTime();
            const serverTs = typeof mappedNew.updatedAt === 'number' ? mappedNew.updatedAt : new Date(mappedNew.updatedAt).getTime();
            if (serverTs <= localTs) {
              return prevState;
            }
          }
        }

        switch (payload.eventType) {
          case 'INSERT':
            if (!updatedData.find(item => item.id === mappedNew.id)) {
              updatedData.push(mappedNew);
            }
            break;
          case 'UPDATE':
            updatedData = updatedData.map(item => 
              item.id === mappedNew.id ? mappedNew : item
            );
            break;
          case 'DELETE':
            updatedData = updatedData.filter(item => 
              item.id !== payload.old.id
            );
            break;
        }

        newState[stateKey] = updatedData as any;

        if (table === 'businesses') {
          newState.lastSavedBusinesses = updatedData;
        } else if (table === 'departments') {
          newState.lastSavedDepartments = updatedData;
        } else if (table === 'processes') {
          newState.lastSavedProcesses = updatedData;
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
