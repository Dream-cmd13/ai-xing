import React, { useState, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { useAuthStore } from '../store/useAuthStore';
import { useAppActions } from '../hooks/useAppActions';
import { usePageToast } from '../hooks/usePageToast';
import { usePermissions } from '../hooks/usePermissions';

import { AppState, Department, ReviewEntry, ObjectiveReview, User, PADEntry, MenuPermission, OKR } from '../types';
import { Calendar, Building2, ClipboardCheck, Save, CheckCircle, Loader2, Target, TrendingUp, MessageSquare, FileText, Lock, Download, RefreshCw, ChevronLeft, ChevronRight, PieChart } from 'lucide-react';
import PageToast from './PageToast';
import TaskModal from './TaskModal';
import { getTaskById } from '../data';
import { getUserFacingError } from '../utils/userFacingError';
import { canManageReview, canManageTask, getVisibleDepartments, canViewTask, isAdminUser } from '../utils/permissions';
import { createTaskOkrGroups } from '../utils/taskOkrOptions';
import { isTaskInMonthlyPeriod, isTaskInWeeklyPeriod } from '../utils/taskPeriods.js';
import { readTaskReviewState, updateTaskReviewState } from '../utils/reviewTaskState.js';
import { createReviewDraftSnapshot, hasReviewDraftChanges, ReviewDraftSnapshot } from '../utils/reviewDraft';
import { syncTaskReviewsToTasks } from '../utils/taskReviewSync';
import { useLeaveGuard } from '@/hooks/useLeaveGuard';
import { createTaskOwnerSections, getDepartmentManagerUserIds } from '../utils/taskOwnerGrouping.js';



const ReviewView: React.FC = () => {
  const state = useAppStore();
  const { processes, departments, users, strategy, tasks, aiSettings, businesses, systemRoles } = state;

  const { currentUser } = useAuthStore();
  const actions = useAppActions();
  const permissions = usePermissions('okr-review');
  const { 
    handleSave, 
    handleSetDepartments: setDepartments, handleSetUsers: setUsers, 
    handleSetSystemRoles: setSystemRoles, handleSetAISettings: setAISettings, 
    handleSetBusinesses: setBusinesses, setProcessData, updateProcessProps, 
    addProcess, deleteProcessFn: deleteProcess, publishProcess, rollbackProcess, 
    handleSetTasks: setTasks, handleSetStrategy: setStrategy,
    persistTaskEntries, persistTaskDeletion
  } = actions;
  const isSaving = state.isSaving;
  const showSaveSuccess = state.showSaveSuccess;
  const isDirty = state.isDirty;
  const setIsDirty = state.setIsDirty;
  const backendError = state.backendError;
  const currentProcessId = state.currentProcessId;
  const setCurrentProcessId = state.setCurrentProcessId;

  const location = useLocation();
  const navigate = useNavigate();
  const { initialTab, initialDeptId, initialPeriod } = (location.state as any) || {};

  const [activeTab, setActiveTab] = useState<'weekly' | 'monthly' | 'quarterly'>(initialTab || 'monthly');
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(initialDeptId || null);
  
  // Weekly State
  const [selectedWeek, setSelectedWeek] = useState<string>(() => {
    if (initialTab === 'weekly' && initialPeriod) return initialPeriod;
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`;
  });

  // Monthly State
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    if (initialTab === 'monthly' && initialPeriod) return initialPeriod;
    const now = new Date();
    return `${now.getFullYear()}-M${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  });
  const [selectedQuarter, setSelectedQuarter] = useState<string>(() => {
    if (initialTab === 'quarterly' && initialPeriod) return initialPeriod;
    const now = new Date();
    return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
  });

  const [reviewContent, setReviewContent] = useState('');
  const [reviewScore, setReviewScore] = useState(0);
  const [okrReviews, setOkrReviews] = useState<Record<string, ObjectiveReview>>({});
  const [deptTasks, setDeptTasks] = useState<PADEntry[]>([]);
  const [currentQuarterlyOkrIndex, setCurrentQuarterlyOkrIndex] = useState(0);
  const [reviewSubTab, setReviewSubTab] = useState<'tasks' | 'weekly-records' | 'okrs'>(
    initialTab === 'quarterly' || initialTab === 'monthly' ? 'okrs' : 'tasks'
  );
  const [loadedDraftSnapshot, setLoadedDraftSnapshot] = useState<ReviewDraftSnapshot>(() => createReviewDraftSnapshot());

  const [taskModal, setTaskModal] = useState<{ isOpen: boolean, weekId: string | null, mode: 'create' | 'edit', data: Partial<PADEntry> }>({ isOpen: false, weekId: null, mode: 'edit', data: {} });
  const { toastState, showToast, clearToast } = usePageToast();

  useEffect(() => {
    clearToast();
  }, [clearToast, activeTab, selectedDeptId, selectedWeek, selectedMonth, selectedQuarter, reviewSubTab]);

  useEffect(() => {
    if (activeTab === 'quarterly') {
      setReviewSubTab('okrs');
      return;
    }
    if (activeTab === 'monthly') {
      setReviewSubTab('okrs');
      return;
    }
    if (activeTab === 'weekly') {
      setReviewSubTab('tasks');
      return;
    }
    if (reviewSubTab === 'okrs' && activeTab === 'weekly') {
      setReviewSubTab('tasks');
    }
  }, [activeTab]);

  const updateReviewScore = (score: number) => {
    setReviewScore(score);
  };

  const updateReviewContent = (content: string) => {
    setReviewContent(content);
  };

  const updateOkrReviews = (reviews: Record<string, ObjectiveReview>) => {
    setOkrReviews(reviews);
  };

  const handleDeleteTask = async () => {
    if (!taskModal.data.id) return;
    const taskToDelete = state.tasks.find(t => t.id === taskModal.data.id);
    if (!taskToDelete || !canManageTask(taskToDelete, currentUser, state.systemRoles || [], state.departments)) {
      showToast('无权限删除该任务', 'error');
      return;
    }
    try {
      const updatedTasks = state.tasks.filter(t => t.id !== taskModal.data.id);
      await persistTaskDeletion(updatedTasks, [taskModal.data.id]);
      showToast('任务已删除', 'info');
      setTaskModal({ ...taskModal, isOpen: false });
    } catch (e: any) {
      showToast(getUserFacingError(e, '删除失败，请稍后重试'), 'error');
    }
  };

  const saveTask = async (status: string, keepOpen: boolean = false) => {
    const task = { ...taskModal.data, status } as PADEntry;
    const oldTask = state.tasks.find(t => t.id === task.id);
    const currentUserIsAdmin = isAdminUser(currentUser, state.systemRoles || []);
    if (!oldTask || !canManageTask(oldTask, currentUser, state.systemRoles || [], state.departments)) {
      showToast('无权限修改该任务', 'error');
      return;
    }
    if (!currentUserIsAdmin) {
      task.ownerId = oldTask.ownerId;
    }
    try {
      const updatedTasks = state.tasks.map(t => t.id === task.id ? task : t);
      await persistTaskEntries(updatedTasks, [task], 'update');
      showToast('任务已保存', 'success');
      if (!keepOpen) {
        setTaskModal({ ...taskModal, isOpen: false });
      }
    } catch (e: any) {
      showToast(getUserFacingError(e, '保存失败，请稍后重试'), 'error');
    }
  };

  const handleTaskClick = (task: PADEntry) => {
    if (!canViewTask(task, currentUser, state.users, state.systemRoles || [], state.departments)) {
      const owner = state.users.find(u => u.id === task.ownerId);
      showToast(`无任务查看权限，如果需要查看任务，请联系任务创建人【${owner?.name || ''}】`, 'info');
      return;
    }

    // Find the weekId for this task
    const weekId = task.targetWeeks?.[0] || null;
    setTaskModal({
      isOpen: true,
      weekId,
      mode: 'edit',
      data: task
    });
  };

  const visibleDepartments = useMemo(() => getVisibleDepartments(currentUser, state.departments, state.systemRoles || []), [currentUser, state.departments, state.systemRoles]);

  const flatDepts = useMemo(() => {
    const list: Department[] = [];
    const collect = (depts: Department[]) => {
      depts.forEach(d => {
        list.push(d);
        if (d.subDepartments) collect(d.subDepartments);
      });
    };
    collect(visibleDepartments);
    return list;
  }, [visibleDepartments]);

  const selectedDept = useMemo(
    () => flatDepts.find(d => d.id === selectedDeptId) || null,
    [flatDepts, selectedDeptId]
  );
  const canEditReview = useMemo(() => {
    if (!currentUser || !selectedDept || !permissions.update) return false;
    return canManageReview(selectedDept, currentUser, state.systemRoles || [], state.departments);
  }, [currentUser, selectedDept, permissions.update, state.systemRoles, state.departments]);

  const groupedAvailableKRs = useMemo(() => {
    return createTaskOkrGroups({
      companyOKRs: state.strategy.companyOKRs,
      departments: state.departments,
      currentUser,
      ownerId: taskModal.data.ownerId,
      users: state.users,
      isAdmin: isAdminUser(currentUser, state.systemRoles || []),
      startDate: taskModal.data.startDate,
      dueDate: taskModal.data.dueDate,
      fallbackWeekId: taskModal.weekId
    });
  }, [
    state.strategy.companyOKRs,
    state.departments,
    state.users,
    state.systemRoles,
    currentUser,
    taskModal.data.ownerId,
    taskModal.data.startDate,
    taskModal.data.dueDate,
    taskModal.weekId
  ]);

  const currentDraftSnapshot = useMemo(() => createReviewDraftSnapshot({
    content: reviewContent,
    score: reviewScore,
    okrReviews
  }), [reviewContent, reviewScore, okrReviews]);

  const hasDraftChanges = useMemo(
    () => hasReviewDraftChanges(loadedDraftSnapshot, currentDraftSnapshot),
    [loadedDraftSnapshot, currentDraftSnapshot]
  );

  const getDeptTasksForSelection = React.useCallback(() => {
    if (!selectedDeptId) {
      return [];
    }

    const nextTasks: PADEntry[] = [];
    const seen = new Set<string>();

    (state.tasks || []).forEach(task => {
      const inPeriod = activeTab === 'weekly'
        ? isTaskInWeeklyPeriod(task.targetWeeks, selectedWeek)
        : activeTab === 'monthly'
          ? isTaskInMonthlyPeriod(task.targetWeeks, selectedMonth)
          : false;

      if (!inPeriod) return;
      if (!canViewTask(task, currentUser, state.users, state.systemRoles || [], state.departments)) return;

      const taskDeptId = task.departmentId || state.users.find(u => u.id === task.ownerId)?.departmentId;
      if (taskDeptId === selectedDeptId && !seen.has(task.id)) {
        seen.add(task.id);
        nextTasks.push(task);
      }
    });

    return createTaskOwnerSections(
      nextTasks,
      state.users,
      getDepartmentManagerUserIds(selectedDept, state.users)
    ).map((section) => section.task);
  }, [
    activeTab,
    currentUser,
    selectedDept,
    selectedDeptId,
    selectedMonth,
    selectedWeek,
    state.departments,
    state.systemRoles,
    state.tasks,
    state.users
  ]);

  const hasTaskDeliverableChanges = useMemo(
    () => deptTasks.some((task) => {
      const latestTask = state.tasks.find((entry) => entry.id === task.id);
      return (latestTask?.deliverable || '') !== (task.deliverable || '');
    }),
    [deptTasks, state.tasks]
  );

  const hasUnsavedChanges = hasDraftChanges || hasTaskDeliverableChanges;

  const discardReviewDraft = useMemo(
    () => () => {
      clearToast();
      setReviewContent(loadedDraftSnapshot.content);
      setReviewScore(loadedDraftSnapshot.score);
      setOkrReviews(loadedDraftSnapshot.okrReviews);
      setDeptTasks(getDeptTasksForSelection());
      setIsDirty(false);
    },
    [clearToast, getDeptTasksForSelection, loadedDraftSnapshot, setIsDirty]
  );

  const { attemptLeave, LeaveModal } = useLeaveGuard(hasUnsavedChanges, {
    onDiscard: discardReviewDraft
  });

  useEffect(() => {
    setIsDirty(hasUnsavedChanges);
  }, [hasUnsavedChanges, setIsDirty]);

  useEffect(() => {
    return () => {
      setIsDirty(false);
    };
  }, [setIsDirty]);

  const currentPeriodKey = useMemo(
    () => (
      activeTab === 'weekly'
        ? selectedWeek
        : activeTab === 'monthly'
          ? selectedMonth
          : selectedQuarter
    ),
    [activeTab, selectedWeek, selectedMonth, selectedQuarter]
  );

  // Load existing review when selection changes
  useEffect(() => {
    if (!selectedDept) {
      const emptySnapshot = createReviewDraftSnapshot();
      setReviewContent(emptySnapshot.content);
      setReviewScore(emptySnapshot.score);
      setOkrReviews(emptySnapshot.okrReviews);
      setLoadedDraftSnapshot(emptySnapshot);
      return;
    }

    const reviews = selectedDept.reviews?.[currentPeriodKey] || [];
    const latestReview = reviews.length > 0 ? reviews[reviews.length - 1] : null;

    const nextSnapshot = createReviewDraftSnapshot(latestReview ? {
      content: latestReview.content || '',
      score: latestReview.score || 0,
      okrReviews: latestReview.okrDetails || {}
    } : undefined);

    setReviewContent(nextSnapshot.content);
    setReviewScore(nextSnapshot.score);
    setOkrReviews(nextSnapshot.okrReviews);
    setLoadedDraftSnapshot(nextSnapshot);
  }, [selectedDept, currentPeriodKey]);

  const changeReviewTab = (nextTab: 'weekly' | 'monthly' | 'quarterly') => {
    if (nextTab === activeTab) return;
    attemptLeave(() => setActiveTab(nextTab));
  };

  const changeSelectedDepartment = (nextDeptId: string) => {
    if ((selectedDeptId || '') === nextDeptId) return;
    attemptLeave(() => setSelectedDeptId(nextDeptId || null));
  };

  const changeSelectedMonthValue = (nextMonth: string) => {
    if (selectedMonth === nextMonth) return;
    attemptLeave(() => setSelectedMonth(nextMonth));
  };

  const changeSelectedQuarterValue = (nextQuarter: string) => {
    if (selectedQuarter === nextQuarter) return;
    attemptLeave(() => setSelectedQuarter(nextQuarter));
  };

  const changeSelectedWeekValue = (nextWeek: string) => {
    if (selectedWeek === nextWeek) return;
    attemptLeave(() => setSelectedWeek(nextWeek));
  };

  const submitReview = async () => {
    if (!selectedDeptId) return;
    if (!canEditReview) {
      showToast('当前部门复盘仅可查看，不能修改。', 'info');
      return;
    }
    
    const newEntry: ReviewEntry = {
        id: `rev-${Date.now()}`,
        date: Date.now(),
        content: reviewContent,
        score: reviewScore,
        reviewer: currentUser?.name || 'Admin', 
        okrDetails: okrReviews
    };

    const periodKey = currentPeriodKey;

    const updateDeptRecursive = (depts: Department[]): Department[] => {
      return depts.map(d => {
        if (d.id === selectedDeptId) {
          const currentReviews = d.reviews || {};
          return { ...d, reviews: { ...currentReviews, [periodKey]: [newEntry] } };
        }
        if (d.subDepartments) {
          return { ...d, subDepartments: updateDeptRecursive(d.subDepartments) };
        }
        return d;
      });
    };

    const syncedDeptTasks = syncTaskReviewsToTasks(deptTasks, okrReviews);
    const syncedTaskMap = new Map(syncedDeptTasks.map((task) => [task.id, task]));
    const candidateTaskIds = syncedDeptTasks
      .filter((task) => {
        // 跳过当前用户无权管理的任务。同步层会把不在 okrReviews 中的任务 taskReview 置为空字符串，
        // 导致他人任务（数据库中已有复盘内容）被误判为"有变更"，属于假阳性，直接跳过。
        if (currentUser && !canManageTask(task, currentUser, state.systemRoles || [], state.departments)) return false;
        const currentTask = state.tasks.find((entry) => entry.id === task.id);
        if (!currentTask) return false;
        return (currentTask.deliverable || '') !== (task.deliverable || '')
          || (currentTask.taskReview || '') !== (task.taskReview || '')
          || (currentTask.taskReviewScore ?? 0) !== (task.taskReviewScore ?? 0);
      })
      .map((task) => task.id);

    try {
      const latestChangedTasks = candidateTaskIds.length > 0
        ? await Promise.all(candidateTaskIds.map(async (taskId) => {
            try {
              return await getTaskById(taskId);
            } catch {
              return state.tasks.find((entry) => entry.id === taskId) || syncedTaskMap.get(taskId)!;
            }
          }))
        : [];

      const unauthorizedTask = currentUser
        ? latestChangedTasks.find((task) => !canManageTask(task, currentUser, state.systemRoles || [], state.departments))
        : null;

      if (unauthorizedTask) {
        showToast(`任务「${unauthorizedTask.title}」属于他人，您无权限修改其实际成果，请联系任务负责人提交复盘。`, 'error');
        return;
      }

      const changedTaskMap = new Map(
        latestChangedTasks
          .map((latestTask) => {
            const syncedTask = syncedTaskMap.get(latestTask.id);
            if (!syncedTask) return null;

            const nextTask = {
              ...latestTask,
              deliverable: syncedTask.deliverable || '',
              taskReview: syncedTask.taskReview || '',
              taskReviewScore: syncedTask.taskReviewScore ?? 0
            };

            const hasChanged = (latestTask.deliverable || '') !== (nextTask.deliverable || '')
              || (latestTask.taskReview || '') !== (nextTask.taskReview || '')
              || (latestTask.taskReviewScore ?? 0) !== (nextTask.taskReviewScore ?? 0);

            return hasChanged ? [latestTask.id, nextTask] as [string, PADEntry] : null;
          })
          .filter((entry): entry is [string, PADEntry] => Boolean(entry))
      );

      const nextAllTasks = changedTaskMap.size > 0
        ? state.tasks.map((task) => changedTaskMap.get(task.id) ?? task)
        : state.tasks;

      if (changedTaskMap.size > 0) {
        await persistTaskEntries(nextAllTasks, Array.from(changedTaskMap.values()), 'update');
      }
    } catch (error: any) {
      showToast(getUserFacingError(error, '任务复盘保存失败，请稍后重试'), 'error');
      return;
    }

    const updatedDepts = updateDeptRecursive(state.departments);
    setDepartments(updatedDepts);

    const success = await handleSave(['departments']);
    if (success) {
      setDeptTasks(syncedDeptTasks);
      setLoadedDraftSnapshot(currentDraftSnapshot);
      setIsDirty(false);
      showToast('复盘报告已提交并保存成功', 'success');
    }
  };

  const handleNumberInput = (val: string, setter: (n: number) => void, max: number = 100) => {
    // Remove any non-digit characters to prevent negative signs or other text
    let cleaned = val.replace(/\D/g, '');
    // Remove leading zeros unless the value is just "0"
    cleaned = cleaned.replace(/^0+(?=\d)/, '');
    
    if (cleaned === '') {
      setter(0);
      return;
    }
    
    const num = Math.min(max, Math.max(0, Number(cleaned)));
    setter(num);
  };

  // Load tasks automatically when selection changes
  useEffect(() => {
    loadDeptTasks();
  }, [selectedDeptId, selectedWeek, selectedMonth, selectedQuarter, activeTab, state.tasks, state.users, state.systemRoles, currentUser]);

  const currentPeriodLabel = currentPeriodKey;

  const getWeeksForMonth = (monthKey: string) => {
    const [yearPart, monthPart] = monthKey.split('-M');
    const year = Number(yearPart);
    const month = Number(monthPart);
    if (!year || !month) return [];

    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));
    const periods: string[] = [];
    const cursor = new Date(startDate);

    while (cursor <= endDate) {
      const d = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
      const weekKey = `${d.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`;
      if (!periods.includes(weekKey)) {
        periods.push(weekKey);
      }
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }

    return periods;
  };

  const monthlyWeekReviews = useMemo(() => {
    if (!selectedDept || activeTab !== 'monthly') return [];
    return getWeeksForMonth(selectedMonth).map((weekKey) => ({
      period: weekKey,
      review: selectedDept.reviews?.[weekKey]?.[0] || null
    }));
  }, [activeTab, selectedDept, selectedMonth]);

  const appendContentToSummary = (sectionTitle: string, sectionContent: string) => {
    const managedTitles = ['本期任务汇总', '本月周复盘记录汇总', '月度复盘记录汇总', '季度复盘记录汇总'];
    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normalized = sectionContent.trim();
    const nextContent = normalized ? `${sectionTitle}：\n${normalized}` : `${sectionTitle}：\n暂无内容`;
    const otherTitles = managedTitles.filter((title) => title !== sectionTitle).map(escapeRegex);
    const nextTitlePattern = otherTitles.length > 0 ? `(?=\\n\\n(?:${otherTitles.join('|')})：\\n|$)` : '(?=$)';
    const sectionPattern = new RegExp(`${escapeRegex(sectionTitle)}：\\n[\\s\\S]*?${nextTitlePattern}`, 'g');
    const cleaned = reviewContent
      .replace(sectionPattern, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    updateReviewContent(cleaned ? `${cleaned}\n\n${nextContent}` : nextContent);
  };

  const getReviewStatusLabel = (status?: string) => {
    if (status === 'at-risk') return '有风险';
    if (status === 'behind') return '滞后';
    return '正常推进';
  };

  const getAverageKrProgress = (okr: OKR, review?: ObjectiveReview) => {
    const krCount = okr.keyResults?.length || 0;
    const totalKrProgress = okr.keyResults?.reduce((sum, _kr, idx) => sum + (Number(review?.krReviews?.[idx]?.progress) || 0), 0) || 0;
    return krCount > 0 ? Math.round(totalKrProgress / krCount) : 0;
  };

  const getSummaryKrAverageScore = (items: Array<{ okr: OKR; review?: ObjectiveReview | null }>) => {
    let totalKrProgress = 0;
    let krCount = 0;

    items.forEach(({ okr, review }) => {
      (okr.keyResults || []).forEach((_kr, idx) => {
        totalKrProgress += Number(review?.krReviews?.[idx]?.progress) || 0;
        krCount += 1;
      });
    });

    return krCount > 0 ? Math.round(totalKrProgress / krCount) : 0;
  };

  const buildOkrReviewSummary = (items: Array<{ okr: OKR & { period?: string }; review?: ObjectiveReview | null; prefix?: string }>) => {
    if (items.length === 0) return '暂无 OKR 记录';

    return items.map(({ okr, review, prefix }, index) => {
      const effectiveReview = review || { progress: 0, krReviews: [], lessonsLearned: '', methodology: '', nextSteps: '' };
      const krSummary = (okr.keyResults || []).map((kr, krIndex) => {
        const krReview = effectiveReview.krReviews?.[krIndex];
        return [
          `  ${krIndex + 1}. ${kr}`,
          `     进度：${Number(krReview?.progress) || 0}%`,
          `     状态：${getReviewStatusLabel(krReview?.status)}`,
          `     执行情况：${krReview?.comment?.trim() || '暂无记录'}`
        ].join('\n');
      }).join('\n');

      return [
        `${index + 1}. ${prefix ? `${prefix} - ` : ''}${okr.objective || '未命名 OKR'}`,
        `周期：${okr.period || '未标记'}`,
        `KR 完成度汇总：${getAverageKrProgress(okr, effectiveReview)}%`,
        `KR 执行情况和进度：`,
        krSummary || '  暂无 KR',
        `经验教训：${effectiveReview.lessonsLearned?.trim() || '暂无记录'}`,
        `方法论沉淀：${effectiveReview.methodology?.trim() || '暂无记录'}`,
        `下一步计划：${effectiveReview.nextSteps?.trim() || '暂无记录'}`
      ].join('\n');
    }).join('\n\n');
  };

  const getMonthsForQuarter = (quarterKey: string) => {
    const [yearPart, quarterPart] = quarterKey.split('-Q');
    const year = Number(yearPart);
    const quarter = Number(quarterPart);
    if (!year || !quarter) return [];

    const startMonth = (quarter - 1) * 3 + 1;
    return [startMonth, startMonth + 1, startMonth + 2].map((month) => `${year}-M${month.toString().padStart(2, '0')}`);
  };

  const formatMonthKeyLabel = (monthKey: string, includeYear = false) => {
    const [yearPart, monthPart] = monthKey.split('-M');
    const month = Number(monthPart);
    if (!month) return monthKey;
    return includeYear ? `${yearPart}年${month}月` : `${month}月`;
  };

  const getSummaryReadDescription = () => {
    if (activeTab === 'monthly') {
      return `读取当前月份（${formatMonthKeyLabel(selectedMonth, true)}）的所有 KR 执行情况、进度、经验教训、方法论沉淀和下一步计划到总结。`;
    }
    if (activeTab === 'quarterly') {
      return '读取当前页面的 KR 执行情况、进度和复盘沉淀到总结。';
    }
    return '';
  };

  const appendMonthlyAdjustmentSummary = () => {
    const summaryItems = currentOkrs.map((okr) => ({
      okr,
      review: okrReviews[okr.id]
    }));
    const summary = buildOkrReviewSummary(summaryItems);
    appendContentToSummary('月度复盘记录汇总', summary);
    setReviewScore(getSummaryKrAverageScore(summaryItems));
    showToast('已将月度复盘记录汇总到总结中', 'success');
  };

  const appendQuarterlyAdjustmentSummary = () => {
    const summaryItems = currentOkrs.map((okr) => ({
      okr,
      review: okrReviews[okr.id]
    }));

    const summary = buildOkrReviewSummary(summaryItems);
    appendContentToSummary('季度复盘记录汇总', summary);
    setReviewScore(getSummaryKrAverageScore(summaryItems));
    showToast('已将季度复盘记录汇总到总结中', 'success');
  };

  const appendAdjustmentSummaryToReview = () => {
    if (!canEditReview) return;
    if (activeTab === 'monthly') {
      appendMonthlyAdjustmentSummary();
      return;
    }
    if (activeTab === 'quarterly') {
      appendQuarterlyAdjustmentSummary();
    }
  };

  const loadDeptTasks = React.useCallback(() => {
    setDeptTasks(getDeptTasksForSelection());
  }, [getDeptTasksForSelection]);
  const currentOkrs = useMemo(() => {
    if (!selectedDeptId) return [];
    const dept = flatDepts.find(d => d.id === selectedDeptId);
    if (!dept) return [];
    
    const year = parseInt(currentPeriodLabel.split('-')[0]);
    
    let quarter = 'Q1';
    if (activeTab === 'quarterly') {
      quarter = currentPeriodLabel.split('-Q')[1] ? `Q${currentPeriodLabel.split('-Q')[1]}` : 'Q1';
    } else if (activeTab === 'monthly') {
      const month = parseInt(currentPeriodLabel.split('-M')[1]);
      if (month >= 4 && month <= 6) quarter = 'Q2';
      else if (month >= 7 && month <= 9) quarter = 'Q3';
      else if (month >= 10) quarter = 'Q4';
    } else {
      const week = parseInt(currentPeriodLabel.split('-W')[1]);
      if (week >= 14 && week <= 26) quarter = 'Q2';
      else if (week >= 27 && week <= 39) quarter = 'Q3';
      else if (week >= 40) quarter = 'Q4';
    }

    const okrs: any[] = [];
    if (dept.okrs?.[year]) {
      Object.entries(dept.okrs[year]).forEach(([period, list]: [string, any[]]) => {
        if (period === quarter) {
          (list || []).forEach(o => okrs.push({ ...o, period }));
        }
      });
    }
    return okrs;
  }, [selectedDeptId, currentPeriodLabel, flatDepts, activeTab]);

  useEffect(() => {
    setCurrentQuarterlyOkrIndex(0);
  }, [activeTab, selectedDeptId, selectedWeek, selectedMonth, selectedQuarter]);

  useEffect(() => {
    if (currentOkrs.length === 0) {
      setCurrentQuarterlyOkrIndex(0);
      return;
    }
    if (currentQuarterlyOkrIndex > currentOkrs.length - 1) {
      setCurrentQuarterlyOkrIndex(currentOkrs.length - 1);
    }
  }, [currentOkrs, currentQuarterlyOkrIndex]);

  const currentQuarterlyOkr = currentOkrs[currentQuarterlyOkrIndex] || null;
  const monthlyWeekReviewStats = useMemo(() => {
    const reviewedCount = monthlyWeekReviews.filter(({ review }) => Boolean(review)).length;
    return {
      total: monthlyWeekReviews.length,
      reviewed: reviewedCount,
      pending: Math.max(monthlyWeekReviews.length - reviewedCount, 0)
    };
  }, [monthlyWeekReviews]);
  const renderTaskReviewCard = (task: PADEntry) => {
    const { evaluation, score } = readTaskReviewState(okrReviews, task);
    const owner = state.users.find(u => u.id === task.ownerId);

    return (
      <div key={task.id} className="w-full bg-white p-5 rounded-[1.75rem] border border-slate-100 shadow-sm">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 cursor-pointer hover:opacity-80" onClick={() => handleTaskClick(task)}>
                <span className="text-sm font-bold text-indigo-600 hover:underline break-all">{task.title}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-black ${
                  task.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                  task.status === 'in-progress' ? 'bg-blue-100 text-blue-700' :
                  task.status === 'paused' ? 'bg-orange-100 text-orange-700' :
                  task.status === 'terminated' ? 'bg-red-100 text-red-700' :
                  'bg-slate-200 text-slate-700'
                }`}>
                  {task.status === 'completed' ? '已完成' :
                   task.status === 'in-progress' ? '处理中' :
                   task.status === 'paused' ? '暂停' :
                   task.status === 'terminated' ? '终止' :
                   task.status === 'submitted' ? '已提交' : '草稿'}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-500 font-medium">
                {task.startDate ? new Date(task.startDate).toLocaleDateString() : '-'} 至 {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '-'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {owner && (
                <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-full border border-slate-100">
                  <div className="w-5 h-5 rounded-full bg-brand-100 flex items-center justify-center text-[10px] font-black text-brand-600">
                    {owner.name.charAt(0)}
                  </div>
                  <span className="text-[10px] font-bold text-slate-600">{owner.name}</span>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex-1">
              <div className="mb-2 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">预期成果</label>
              </div>
              <textarea
                placeholder="输入该任务的预期成果..."
                className="w-full min-h-[100px] max-h-72 resize-y bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-sm font-medium text-slate-700 outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all leading-6"
                value={task.deliverable || ''}
                disabled={!canEditReview}
                onChange={e => {
                  setDeptTasks((prevTasks) => prevTasks.map((entry) => (
                    entry.id === task.id
                      ? { ...entry, deliverable: e.target.value }
                      : entry
                  )));
                }}
              />
            </div>

            <div className="flex-1">
              <div className="mb-2 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">实际成果</label>
              </div>
              <textarea 
                placeholder="输入该任务的实际成果..."
                className="w-full min-h-[100px] max-h-72 resize-y bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-sm font-medium text-slate-700 outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all leading-6"
                value={evaluation}
                disabled={!canEditReview}
                onChange={e => {
                  updateOkrReviews(
                    updateTaskReviewState(okrReviews, task, {
                      evaluation: e.target.value,
                    })
                  );
                }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderWeeklyReviewCard = (item: { period: string; review: ReviewEntry | null }) => {
    const { period, review } = item;

    return (
      <div
        key={period}
        onClick={() => attemptLeave(() => {
          setActiveTab('weekly');
          setSelectedWeek(period);
        })}
        className="w-full bg-white p-5 rounded-[1.75rem] border border-slate-100 shadow-sm hover:border-brand-300 hover:shadow-md transition-all cursor-pointer group"
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-black text-slate-700">{period}</span>
          {review ? (
            <span className="text-[10px] font-bold px-2 py-1 rounded-md bg-emerald-50 text-emerald-600">已复盘</span>
          ) : (
            <span className="text-[10px] font-bold px-2 py-1 rounded-md bg-slate-100 text-slate-500">未复盘</span>
          )}
        </div>
        {review ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl font-black text-brand-600">{review.score}</span>
              <span className="text-xs text-slate-400 font-bold">/ 100 分</span>
            </div>
            <p className="text-sm leading-6 text-slate-500 line-clamp-3 min-h-[72px]">{review.content}</p>
          </>
        ) : (
          <div className="h-[104px] flex items-center text-slate-300">
            <span className="text-xs font-bold">点击发起该周复盘</span>
          </div>
        )}
        <div className="mt-4 flex items-center justify-end text-brand-600 opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="text-xs font-bold mr-1">{review ? '查看周复盘' : '去复盘'}</span>
          <ChevronRight size={14} />
        </div>
      </div>
    );
  };

  const returnToReviewDashboard = () => {
    navigate(location.state?.from || '/okr-review', {
      state: {
        selectedDeptId
      }
    });
  };

  return (
    <div className="h-full flex flex-col gap-6 overflow-hidden">
      <div className="bg-white p-6 rounded-[2.5rem] border shadow-sm flex flex-col md:flex-row justify-between items-center shrink-0">
        <div className="flex items-center gap-4">
          {location.state?.from && (
            <button 
              onClick={() => attemptLeave(returnToReviewDashboard)}
              className="p-3 bg-slate-50 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-2xl transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
          )}
          <div className="p-3 bg-brand-50 text-brand-600 rounded-2xl"><ClipboardCheck size={24}/></div>
          <div>
            <h3 className="text-xl font-black text-slate-800">复盘中心</h3>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">工作复盘中心</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex bg-slate-100 p-1 rounded-2xl">
             <button 
               onClick={() => changeReviewTab('weekly')}
               className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === 'weekly' ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500'}`}
             >
               周度复盘
             </button>
             <button 
               onClick={() => changeReviewTab('monthly')}
               className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === 'monthly' ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500'}`}
             >
               月度复盘
             </button>
             <button 
               onClick={() => changeReviewTab('quarterly')}
               className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === 'quarterly' ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500'}`}
             >
               季度复盘
             </button>
          </div>
            <button 
              onClick={submitReview} 
              disabled={isSaving || !hasUnsavedChanges || !canEditReview} 
              className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase flex items-center gap-2 transition-all shadow-md ${hasUnsavedChanges ? 'bg-brand-600 text-white hover:bg-brand-700 shadow-brand-100' : 'bg-slate-100 text-slate-400 cursor-default'}`}
            >
              {isSaving ? <Loader2 className="animate-spin" size={16}/> : <Save size={16} />} 
              {isDirty ? '提交复盘' : '已是最新'}
            </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar pb-12">
        <div className="max-w-5xl mx-auto space-y-8 py-6">
          <div className="bg-white p-8 rounded-[3rem] border shadow-sm">
            <div className="flex flex-col md:flex-row gap-6 items-center justify-between mb-8">
               <div className="flex gap-3">
                  <div className="flex items-center bg-slate-50 border rounded-xl px-4 py-2 gap-2">
                    <Building2 size={14} className="text-slate-400"/>
                    <select className="bg-transparent text-xs font-bold outline-none text-slate-600" value={selectedDeptId || ''} onChange={e => changeSelectedDepartment(e.target.value)}>
                      <option value="">选择复盘部门...</option>
                      {flatDepts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  
                  {activeTab === 'monthly' ? (
                    <div className="flex items-center bg-slate-50 border rounded-xl px-4 py-2 gap-2">
                      <Calendar size={14} className="text-slate-400"/>
                      <select 
                        className="bg-transparent text-xs font-bold outline-none text-slate-600"
                        value={selectedMonth.split('-')[0]}
                        onChange={e => changeSelectedMonthValue(`${e.target.value}-M${selectedMonth.split('-M')[1]}`)}
                      >
                        {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}年</option>)}
                      </select>
                      <span className="text-slate-300">/</span>
                      <select 
                        className="bg-transparent text-xs font-bold outline-none text-slate-600"
                        value={parseInt(selectedMonth.split('-M')[1])}
                        onChange={e => changeSelectedMonthValue(`${selectedMonth.split('-')[0]}-M${e.target.value.toString().padStart(2, '0')}`)}
                      >
                        {Array.from({length: 12}, (_, i) => i + 1).map(m => (
                          <option key={m} value={m}>{m}月</option>
                        ))}
                      </select>
                    </div>
                  ) : activeTab === 'quarterly' ? (
                    <div className="flex items-center bg-slate-50 border rounded-xl px-4 py-2 gap-2">
                      <Calendar size={14} className="text-slate-400"/>
                      <select
                        className="bg-transparent text-xs font-bold outline-none text-slate-600"
                        value={selectedQuarter.split('-')[0]}
                        onChange={e => changeSelectedQuarterValue(`${e.target.value}-Q${selectedQuarter.split('-Q')[1]}`)}
                      >
                        {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}年</option>)}
                      </select>
                      <span className="text-slate-300">/</span>
                      <select
                        className="bg-transparent text-xs font-bold outline-none text-slate-600"
                        value={parseInt(selectedQuarter.split('-Q')[1])}
                        onChange={e => changeSelectedQuarterValue(`${selectedQuarter.split('-')[0]}-Q${e.target.value}`)}
                      >
                        {[1, 2, 3, 4].map(q => (
                          <option key={q} value={q}>Q{q}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="flex items-center bg-slate-50 border rounded-xl px-4 py-2 gap-2">
                      <Calendar size={14} className="text-slate-400"/>
                      <input 
                        type="week"
                        className="bg-transparent text-xs font-bold outline-none text-slate-600"
                        value={selectedWeek}
                        onChange={e => changeSelectedWeekValue(e.target.value)}
                      />
                    </div>
                  )}
               </div>
            </div>

            {selectedDeptId ? (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
                 {/* Overall Review */}
                 <div className="space-y-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                       <div className="flex flex-col gap-1">
                         <h4 className="text-sm font-black text-slate-700 uppercase tracking-widest flex items-center gap-2"><Target size={16}/> 整体复盘总结</h4>
                         {(activeTab === 'monthly' || activeTab === 'quarterly') && (
                           <p className="max-w-3xl text-xs font-medium leading-relaxed text-slate-400">
                             {getSummaryReadDescription()}
                           </p>
                         )}
                       </div>
                       <div className="flex flex-wrap items-center gap-2">
                          {(activeTab === 'monthly' || activeTab === 'quarterly') && (
                            <button
                              type="button"
                              disabled={!canEditReview}
                              onClick={appendAdjustmentSummaryToReview}
                              className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-bold hover:bg-indigo-100 transition-colors flex items-center gap-1 disabled:opacity-50 disabled:hover:bg-indigo-50"
                            >
                              <Download size={14} />
                              读取记录到总结
                            </button>
                          )}
                          <div className="flex items-center gap-2 bg-slate-50 px-3 py-1 rounded-xl border">
                            <span className="text-[10px] font-black text-slate-400 uppercase">综合评分</span>
                            <input 
                                type="text" 
                                className="w-12 bg-transparent text-sm font-black text-brand-600 outline-none text-right"
                                value={reviewScore === 0 ? 0 : reviewScore || ''}
                                disabled={!canEditReview}
                                onChange={e => {
                                  if (e.target.value === '') {
                                    updateReviewScore('' as any);
                                    return;
                                  }
                                  handleNumberInput(e.target.value, updateReviewScore, 100)
                                }}
                                onFocus={e => e.target.select()}
                              />
                            <span className="text-xs font-bold text-slate-300">/ 100</span>
                          </div>
                       </div>
                    </div>
                    <textarea 
                      className="w-full min-h-[13rem] md:min-h-[16rem] p-6 bg-slate-50 border border-slate-100 rounded-[2rem] text-sm font-bold text-slate-700 outline-none focus:border-brand-300 focus:bg-white transition-all resize-y leading-relaxed"
                      placeholder="输入本周期整体复盘总结..."
                      value={reviewContent}
                      disabled={!canEditReview}
                      onChange={e => updateReviewContent(e.target.value)}
                    />
                 </div>

                 {/* Review Detail */}
                 <div className="space-y-6">
                    {(activeTab === 'quarterly' || (activeTab === 'monthly' && reviewSubTab === 'okrs')) && currentOkrs.length > 1 && (
                      <div className="rounded-[2rem] border border-slate-200 bg-white px-4 py-3 shadow-sm">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => setCurrentQuarterlyOkrIndex((prev) => Math.max(0, prev - 1))}
                            disabled={currentQuarterlyOkrIndex === 0}
                            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-500 transition-colors enabled:hover:border-brand-200 enabled:hover:bg-brand-50 enabled:hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label="上一条季度OKR"
                          >
                            <ChevronLeft size={18} />
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-400">季度 OKR 切换</div>
                            <div className="mt-1 truncate text-sm font-black text-slate-700">
                              {currentQuarterlyOkr?.objective || '暂无季度 OKR'}
                            </div>
                          </div>
                          <div className="rounded-full bg-brand-50 px-3 py-1 text-xs font-black text-brand-600">
                            {currentQuarterlyOkrIndex + 1} / {currentOkrs.length}
                          </div>
                          <button
                            type="button"
                            onClick={() => setCurrentQuarterlyOkrIndex((prev) => Math.min(currentOkrs.length - 1, prev + 1))}
                            disabled={currentQuarterlyOkrIndex === currentOkrs.length - 1}
                            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-500 transition-colors enabled:hover:border-brand-200 enabled:hover:bg-brand-50 enabled:hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label="下一条季度OKR"
                          >
                            <ChevronRight size={18} />
                          </button>
                        </div>
                      </div>
                    )}

                    {activeTab === 'monthly' && (
                      <div className="sticky top-0 z-10 -mx-2 rounded-[1.75rem] border border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div className="flex items-center gap-4 overflow-x-auto">
                          <button
                            className={`flex items-center gap-2 pb-2 text-sm font-black uppercase tracking-widest transition-colors ${reviewSubTab === 'okrs' ? 'text-brand-600 border-b-2 border-brand-600' : 'text-slate-400 hover:text-slate-600'}`}
                            onClick={() => attemptLeave(() => setReviewSubTab('okrs'))}
                          >
                            {selectedMonth ? `${parseInt(selectedMonth.split('-')[1].replace('M', ''))}月 OKR` : '月度 OKR'}
                            <span className={`rounded-full px-2 py-0.5 text-[10px] ${reviewSubTab === 'okrs' ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-500'}`}>
                              {currentOkrs.length}
                            </span>
                          </button>
                          <button
                            className={`flex items-center gap-2 pb-2 text-sm font-black uppercase tracking-widest transition-colors ${reviewSubTab === 'weekly-records' ? 'text-brand-600 border-b-2 border-brand-600' : 'text-slate-400 hover:text-slate-600'}`}
                            onClick={() => attemptLeave(() => setReviewSubTab('weekly-records'))}
                          >
                            周复盘记录
                            <span className={`rounded-full px-2 py-0.5 text-[10px] ${reviewSubTab === 'weekly-records' ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-500'}`}>
                              {monthlyWeekReviews.length}
                            </span>
                          </button>
                        </div>
                          <p className="text-xs font-medium text-slate-400">
                            月度复盘支持分区浏览 OKR 与周复盘记录，避免内容过长影响查看。
                          </p>
                        </div>
                      </div>
                    )}

                    {activeTab === 'weekly' && (
                      <div className="space-y-4">
                        <div className="flex flex-wrap justify-end gap-2 mb-2">
                          <button
                            onClick={loadDeptTasks}
                            className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors flex items-center gap-1"
                          >
                            <RefreshCw size={14} />
                            读取任务
                          </button>
                          <button
                            disabled={!canEditReview}
                            onClick={() => {
                              if (!canEditReview) return;
                              const taskSummary = deptTasks.length > 0
                                ? deptTasks.map((task, index) => {
                                    const { evaluation } = readTaskReviewState(okrReviews, task);
                                    const expected = task.deliverable?.trim() || '暂无预期成果';
                                    const actual = evaluation.trim() || task.taskReview?.trim() || '暂无实际成果';
                                    return `${index + 1}. 任务标题：${task.title}\n预期成果：${expected}\n实际成果：${actual}`;
                                  }).join('\n\n')
                                : '暂无关联任务';
                              appendContentToSummary('本期任务汇总', taskSummary);
                              showToast('已将任务读取到总结中', 'success');
                            }}
                            className="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-bold hover:bg-indigo-100 transition-colors flex items-center gap-1"
                          >
                            <Download size={14} />
                            读取任务到总结
                          </button>
                        </div>
                        <div className="pb-2">
                          {deptTasks.length === 0 ? (
                            <div className="text-center py-8 text-slate-400 text-sm italic font-medium">暂无关联任务</div>
                          ) : (
                            <div className="flex flex-col gap-4">
                              {deptTasks.map(task => renderTaskReviewCard(task))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {activeTab === 'monthly' && reviewSubTab === 'weekly-records' && (
                      <div className="space-y-4 rounded-[2rem] border border-slate-200 bg-slate-50/80 p-4 md:p-5">
                        <div className="flex flex-col gap-4 rounded-[1.5rem] border border-white/70 bg-white px-4 py-4 shadow-sm">
                          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                            <div>
                              <div className="text-xs font-black uppercase tracking-[0.24em] text-slate-400">周复盘记录面板</div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <div className="rounded-2xl bg-brand-50 px-4 py-3 text-brand-600">
                                <div className="text-[10px] font-black uppercase tracking-widest">周数</div>
                                <div className="mt-1 text-xl font-black">{monthlyWeekReviewStats.total}</div>
                              </div>
                              <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-emerald-600">
                                <div className="text-[10px] font-black uppercase tracking-widest">已复盘</div>
                                <div className="mt-1 text-xl font-black">{monthlyWeekReviewStats.reviewed}</div>
                              </div>
                              <div className="rounded-2xl bg-slate-100 px-4 py-3 text-slate-600">
                                <div className="text-[10px] font-black uppercase tracking-widest">待处理</div>
                                <div className="mt-1 text-xl font-black">{monthlyWeekReviewStats.pending}</div>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="pb-2">
                          {monthlyWeekReviews.length === 0 ? (
                            <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-white text-center py-8 text-slate-400 text-sm italic font-medium">本月暂无周复盘记录</div>
                          ) : (
                            <div className="flex flex-col gap-4">
                              {monthlyWeekReviews.map(item => renderWeeklyReviewCard(item))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {(activeTab === 'quarterly' || (activeTab === 'monthly' && reviewSubTab === 'okrs')) && (
                      <div className="space-y-6">
                        {currentQuarterlyOkr ? (() => {
                          const okr = currentQuarterlyOkr;
                          const currentReview = okrReviews[okr.id] || { progress: 0, krReviews: [], lessonsLearned: '', methodology: '', nextSteps: '' };

                          return (
                            <div key={okr.id} className="bg-slate-50/50 rounded-[2.5rem] p-8 border border-slate-100">
                         <div className="flex items-center gap-3 mb-6">
                            <span className="bg-white border text-slate-500 text-[10px] font-black px-2 py-1 rounded uppercase">{okr.period}</span>
                            <h5 className="font-bold text-slate-800 flex-1">{okr.objective}</h5>
                            <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-xl border">
                               <span className="text-[10px] font-black text-slate-400 uppercase">进度汇总</span>
                               <span className="w-12 text-sm font-black text-brand-600 text-right">
                                 {(() => {
                                   const krCount = okr.keyResults?.length || 0;
                                   const totalKrProgress = okr.keyResults?.reduce((sum: number, _: any, idx: number) => sum + (currentReview.krReviews?.[idx]?.progress || 0), 0) || 0;
                                   return krCount > 0 ? Math.round(totalKrProgress / krCount) : 0;
                                 })()}
                               </span>
                               <span className="text-xs font-bold text-slate-300">%</span>
                            </div>
                         </div>

                         {/* KR Reviews */}
                         <div className="space-y-4 mb-6">
                            {okr.keyResults.map((kr: string, idx: number) => {
                             const krReview = currentReview.krReviews?.[idx] || { comment: '', progress: 0, status: 'on-track' };
                             return (
                               <div key={idx} className="bg-white p-4 rounded-xl border border-slate-100">
                                 <div className="flex gap-4 items-start">
                                   <p className="w-1/4 shrink-0 text-xs font-bold text-slate-600 pt-2">{kr}</p>
                                   <div className="flex-1">
                                     <textarea 
                                       placeholder="输入 KR 执行情况..."
                                       className="w-full bg-slate-50 border-none rounded-lg px-3 py-2 text-xs font-medium text-slate-600 outline-none focus:ring-1 focus:ring-brand-200 resize-y min-h-[120px]"
                                       value={krReview.comment || ''}
                                       disabled={!canEditReview}
                                       onChange={e => {
                                         const newKrReviews = [...(currentReview.krReviews || [])];
                                         while(newKrReviews.length <= idx) newKrReviews.push({ comment: '', progress: 0, status: 'on-track' });
                                         newKrReviews[idx] = { ...newKrReviews[idx], comment: e.target.value };
                                         updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, krReviews: newKrReviews } });
                                       }}
                                     />
                                   </div>
                                   <div className="flex flex-col gap-2 mt-2">
                                     <select 
                                       className={`w-24 shrink-0 text-[10px] font-black uppercase px-2 py-1 rounded border outline-none ${
                                         krReview.status === 'at-risk' ? 'bg-red-50 text-red-600 border-red-100' :
                                         krReview.status === 'behind' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                                         'bg-emerald-50 text-emerald-600 border-emerald-100'
                                       }`}
                                       value={krReview.status || 'on-track'}
                                       disabled={!canEditReview}
                                       onChange={e => {
                                         const newKrReviews = [...(currentReview.krReviews || [])];
                                         while(newKrReviews.length <= idx) newKrReviews.push({ comment: '', progress: 0, status: 'on-track' });
                                         newKrReviews[idx] = { ...newKrReviews[idx], status: e.target.value as any };
                                         updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, krReviews: newKrReviews } });
                                       }}
                                     >
                                       <option value="on-track">正常推进</option>
                                       <option value="at-risk">有风险</option>
                                       <option value="behind">滞后</option>
                                     </select>
                                     <div className="w-24 shrink-0 flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-lg">
                                       <span className="text-[10px] text-slate-400">进度</span>
                                       <input 
                                           type="text"
                                           className="w-full bg-transparent text-xs font-bold text-slate-600 outline-none text-right"
                                           value={krReview.progress === 0 ? 0 : krReview.progress || ''}
                                           disabled={!canEditReview}
                                           onChange={e => {
                                             if (e.target.value === '') {
                                                const newKrReviews = [...(currentReview.krReviews || [])];
                                                while(newKrReviews.length <= idx) newKrReviews.push({ comment: '', progress: 0, status: 'on-track' });
                                                newKrReviews[idx] = { ...newKrReviews[idx], progress: '' as any };
                                                updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, krReviews: newKrReviews } });
                                                return;
                                             }
                                             handleNumberInput(e.target.value, (val) => {
                                               const newKrReviews = [...(currentReview.krReviews || [])];
                                               while(newKrReviews.length <= idx) newKrReviews.push({ comment: '', progress: 0, status: 'on-track' });
                                               newKrReviews[idx] = { ...newKrReviews[idx], progress: val };
                                               updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, krReviews: newKrReviews } });
                                             });
                                           }}
                                           onFocus={e => e.target.select()}
                                         />
                                       <span className="text-[10px] text-slate-400">%</span>
                                     </div>
                                   </div>
                                 </div>
                               </div>
                             );
                           })}
                         </div>
                         
                         {(() => {
                           const krCount = okr.keyResults?.length || 0;
                           const totalKrProgress = okr.keyResults?.reduce((sum: number, _: any, idx: number) => sum + (currentReview.krReviews?.[idx]?.progress || 0), 0) || 0;
                           const averageKrProgress = krCount > 0 ? Math.round(totalKrProgress / krCount) : 0;
                           
                           return (
                             <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                                <div className="space-y-2">
                                   <label className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-1"><PieChart size={12}/> KR 完成度汇总</label>
                                   <div className="w-full h-24 bg-slate-50 border border-slate-200 rounded-2xl flex flex-col items-center justify-center">
                                      <div className="text-2xl font-black text-brand-600">{averageKrProgress}%</div>
                                      <div className="text-[10px] text-slate-400 mt-1">根据所有 KR 进度计算</div>
                                   </div>
                                </div>
                                <div className="space-y-2">
                                   <label className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-1"><MessageSquare size={12}/> 经验教训</label>
                                   <textarea 
                                     className="w-full h-24 p-4 bg-white border border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-brand-300 resize-none"
                                     value={currentReview.lessonsLearned || ''}
                                     disabled={!canEditReview}
                                     onChange={e => updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, lessonsLearned: e.target.value } })}
                                   />
                                </div>
                                <div className="space-y-2">
                                   <label className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-1"><FileText size={12}/> 方法论沉淀</label>
                                   <textarea 
                                     className="w-full h-24 p-4 bg-white border border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-brand-300 resize-none"
                                     value={currentReview.methodology || ''}
                                     disabled={!canEditReview}
                                     onChange={e => updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, methodology: e.target.value } })}
                                   />
                                </div>
                                <div className="space-y-2">
                                   <label className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-1"><TrendingUp size={12}/> 下一步计划</label>
                                   <textarea 
                                     className="w-full h-24 p-4 bg-white border border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-brand-300 resize-none"
                                     value={currentReview.nextSteps || ''}
                                     disabled={!canEditReview}
                                     onChange={e => updateOkrReviews({ ...okrReviews, [okr.id]: { ...currentReview, nextSteps: e.target.value } })}
                                   />
                                </div>
                             </div>
                           );
                         })()}
                      </div>
                      );
                    })() : (
                      <div className="text-center py-10 text-slate-400 italic">该部门在所选周期内暂无 OKR 数据</div>
                    )}
                 </div>
                 )}
                 </div>

                 <div className="flex items-center gap-4 pt-6 border-t border-slate-100">
                 </div>
              </div>
            ) : (
              <div className="text-center py-20 text-slate-400 flex flex-col items-center gap-4">
                 <Building2 size={48} className="opacity-20"/>
                 <p className="font-bold">请选择一个部门开始复盘</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <PageToast
        visible={!!toastState}
        message={toastState?.message || ''}
        type={toastState?.type}
        onClose={clearToast}
      />

      {LeaveModal}

      {/* Task Modal (Read Only) */}
      <TaskModal
        isOpen={taskModal.isOpen}
        onClose={() => {
          clearToast();
          setTaskModal({ ...taskModal, isOpen: false });
        }}
        data={taskModal.data}
        setData={(newData) => setTaskModal({ ...taskModal, data: newData })}
        onSave={saveTask}
        isSaving={isSaving}
        onDelete={handleDeleteTask}
        users={state.users}
        departments={state.departments}
        groupedAvailableKRs={groupedAvailableKRs}
        mode={taskModal.mode}
        readOnly={!canManageTask(taskModal.data as PADEntry, currentUser, state.systemRoles || [], state.departments)}
        currentUser={currentUser}
        isAdmin={isAdminUser(currentUser, state.systemRoles || [])}
      />
    </div>
  );
};

export default ReviewView;
