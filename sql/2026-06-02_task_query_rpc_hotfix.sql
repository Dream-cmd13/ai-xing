-- Hotfix: avoid slow task list reads for non-admin users by moving bulk list reads
-- from table RLS to SECURITY DEFINER RPCs that resolve current-user context once.
-- Note:
-- 1. Supabase SQL editor may close the session unexpectedly when a long multi-function
--    script is wrapped in a single explicit transaction.
-- 2. Keep this file transaction-free so it can be executed as a whole or function-by-function.
-- 3. Recommended rollout order:
--    - get_my_task_list_page
--    - get_my_workbench_tasks
--    - get_current_user_visible_task_ids
--    - get_visible_task_list_page
--    - get_visible_tasks_full

CREATE OR REPLACE FUNCTION public.get_current_user_visible_task_ids()
RETURNS TABLE (
  id TEXT
) AS $$
DECLARE
  v_current_user_id TEXT;
  v_is_admin BOOLEAN;
BEGIN
  IF auth.uid() IS NULL AND public.current_auth_username() IS NULL THEN
    RAISE EXCEPTION '未登录，无法读取任务';
  END IF;

  v_current_user_id := public.current_user_id();
  v_is_admin := public.is_admin();

  IF v_is_admin THEN
    RETURN QUERY
    SELECT task_row.id
    FROM public.tasks task_row;
    RETURN;
  END IF;

  IF v_current_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH visible_departments AS (
    SELECT department_row.id
    FROM public.departments department_row
    WHERE public.current_user_has_department_visibility(department_row.id)
  )
  SELECT DISTINCT task_row.id
  FROM public.tasks task_row
  LEFT JOIN public.users owner_user
    ON task_row.department_id IS NULL
   AND owner_user.id = task_row.owner_id
  LEFT JOIN visible_departments visible_department
    ON visible_department.id = COALESCE(task_row.department_id, owner_user.department_id)
  WHERE task_row.created_by = v_current_user_id
     OR task_row.owner_id = v_current_user_id
     OR COALESCE(task_row.participant_ids, '[]'::jsonb) @> jsonb_build_array(v_current_user_id)
     OR COALESCE(task_row.approver_ids, '[]'::jsonb) @> jsonb_build_array(v_current_user_id)
     OR visible_department.id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Task center: my tasks list page
CREATE OR REPLACE FUNCTION public.get_my_task_list_page(
  p_offset INTEGER DEFAULT 0,
  p_limit INTEGER DEFAULT 101
)
RETURNS TABLE (
  id TEXT,
  created_by TEXT,
  title TEXT,
  status TEXT,
  priority TEXT,
  owner_id TEXT,
  department_id TEXT,
  aligned_kr_id TEXT,
  target_weeks JSONB,
  start_date BIGINT,
  due_date BIGINT,
  tags JSONB,
  participant_ids JSONB,
  approver_ids JSONB,
  updated_at BIGINT,
  row_version BIGINT
) AS $$
DECLARE
  v_current_user_id TEXT;
BEGIN
  IF auth.uid() IS NULL AND public.current_auth_username() IS NULL THEN
    RAISE EXCEPTION '未登录，无法读取任务';
  END IF;

  v_current_user_id := public.current_user_id();
  IF v_current_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    task_row.id,
    task_row.created_by,
    task_row.title,
    task_row.status,
    task_row.priority,
    task_row.owner_id,
    task_row.department_id,
    task_row.aligned_kr_id,
    task_row.target_weeks,
    task_row.start_date,
    task_row.due_date,
    task_row.tags,
    task_row.participant_ids,
    task_row.approver_ids,
    task_row.updated_at,
    task_row.row_version
  FROM public.tasks task_row
  WHERE task_row.created_by = v_current_user_id
     OR task_row.owner_id = v_current_user_id
     OR COALESCE(task_row.participant_ids, '[]'::jsonb) @> jsonb_build_array(v_current_user_id)
     OR COALESCE(task_row.approver_ids, '[]'::jsonb) @> jsonb_build_array(v_current_user_id)
  ORDER BY task_row.updated_at DESC
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  LIMIT GREATEST(COALESCE(p_limit, 0), 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Task center: visible organization tasks list page
CREATE OR REPLACE FUNCTION public.get_visible_task_list_page(
  p_offset INTEGER DEFAULT 0,
  p_limit INTEGER DEFAULT 101
)
RETURNS TABLE (
  id TEXT,
  created_by TEXT,
  title TEXT,
  status TEXT,
  priority TEXT,
  owner_id TEXT,
  department_id TEXT,
  aligned_kr_id TEXT,
  target_weeks JSONB,
  start_date BIGINT,
  due_date BIGINT,
  tags JSONB,
  participant_ids JSONB,
  approver_ids JSONB,
  updated_at BIGINT,
  row_version BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    task_row.id,
    task_row.created_by,
    task_row.title,
    task_row.status,
    task_row.priority,
    task_row.owner_id,
    task_row.department_id,
    task_row.aligned_kr_id,
    task_row.target_weeks,
    task_row.start_date,
    task_row.due_date,
    task_row.tags,
    task_row.participant_ids,
    task_row.approver_ids,
    task_row.updated_at,
    task_row.row_version
  FROM public.tasks task_row
  JOIN public.get_current_user_visible_task_ids() visible_task
    ON visible_task.id = task_row.id
  ORDER BY task_row.updated_at DESC
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  LIMIT GREATEST(COALESCE(p_limit, 0), 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Execution / weekly / review pages: visible tasks full payload
CREATE OR REPLACE FUNCTION public.get_visible_tasks_full()
RETURNS TABLE (
  id TEXT,
  created_by TEXT,
  title TEXT,
  status TEXT,
  priority TEXT,
  owner_id TEXT,
  department_id TEXT,
  aligned_kr_id TEXT,
  target_weeks JSONB,
  start_date BIGINT,
  due_date BIGINT,
  tags JSONB,
  participant_ids JSONB,
  approver_ids JSONB,
  logs JSONB,
  plan TEXT,
  action TEXT,
  deliverable TEXT,
  task_review TEXT,
  task_review_score INTEGER,
  updated_at BIGINT,
  row_version BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    task_row.id,
    task_row.created_by,
    task_row.title,
    task_row.status,
    task_row.priority,
    task_row.owner_id,
    task_row.department_id,
    task_row.aligned_kr_id,
    task_row.target_weeks,
    task_row.start_date,
    task_row.due_date,
    task_row.tags,
    task_row.participant_ids,
    task_row.approver_ids,
    task_row.logs,
    task_row.plan,
    task_row.action,
    task_row.deliverable,
    task_row.task_review,
    task_row.task_review_score,
    task_row.updated_at,
    task_row.row_version
  FROM public.tasks task_row
  JOIN public.get_current_user_visible_task_ids() visible_task
    ON visible_task.id = task_row.id
  ORDER BY task_row.updated_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Workbench: current user's relevant tasks
CREATE OR REPLACE FUNCTION public.get_my_workbench_tasks()
RETURNS TABLE (
  id TEXT,
  created_by TEXT,
  title TEXT,
  status TEXT,
  priority TEXT,
  owner_id TEXT,
  department_id TEXT,
  aligned_kr_id TEXT,
  target_weeks JSONB,
  start_date BIGINT,
  due_date BIGINT,
  tags JSONB,
  participant_ids JSONB,
  approver_ids JSONB,
  logs JSONB,
  plan TEXT,
  action TEXT,
  deliverable TEXT,
  task_review TEXT,
  task_review_score INTEGER,
  updated_at BIGINT,
  row_version BIGINT
) AS $$
DECLARE
  v_current_user_id TEXT;
BEGIN
  IF auth.uid() IS NULL AND public.current_auth_username() IS NULL THEN
    RAISE EXCEPTION '未登录，无法读取任务';
  END IF;

  v_current_user_id := public.current_user_id();
  IF v_current_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    task_row.id,
    task_row.created_by,
    task_row.title,
    task_row.status,
    task_row.priority,
    task_row.owner_id,
    task_row.department_id,
    task_row.aligned_kr_id,
    task_row.target_weeks,
    task_row.start_date,
    task_row.due_date,
    task_row.tags,
    task_row.participant_ids,
    task_row.approver_ids,
    task_row.logs,
    task_row.plan,
    task_row.action,
    task_row.deliverable,
    task_row.task_review,
    task_row.task_review_score,
    task_row.updated_at,
    task_row.row_version
  FROM public.tasks task_row
  WHERE task_row.owner_id = v_current_user_id
     OR COALESCE(task_row.participant_ids, '[]'::jsonb) @> jsonb_build_array(v_current_user_id)
     OR COALESCE(task_row.approver_ids, '[]'::jsonb) @> jsonb_build_array(v_current_user_id)
  ORDER BY task_row.updated_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
