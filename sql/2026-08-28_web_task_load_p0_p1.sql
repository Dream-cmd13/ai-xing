-- Web task loading optimization.
-- This migration is appended after the already-applied 2026-08-27 ledger.
-- MCP keyset pagination remains capped at 50 rows for MCP clients.

BEGIN;

CREATE OR REPLACE FUNCTION public.web_get_visible_tasks_full(
  p_limit INTEGER DEFAULT 10000
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 10000), 1), 10000);
  v_items JSONB := '[]'::JSONB;
  v_count INTEGER := 0;
BEGIN
  IF public.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;

  WITH bounded AS (
    SELECT *
    FROM public.get_visible_tasks_full()
    ORDER BY updated_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(bounded) ORDER BY bounded.updated_at DESC, bounded.id DESC), '[]'::JSONB),
         count(*)::INTEGER
    INTO v_items, v_count
  FROM bounded;

  IF v_count > v_limit THEN
    v_items := v_items - (v_count - 1);
  END IF;

  RETURN jsonb_build_object(
    'items', v_items,
    'truncated', v_count > v_limit,
    'totalReturned', LEAST(v_count, v_limit)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.web_get_visible_tasks_scope(
  p_department_id TEXT,
  p_week_ids TEXT[],
  p_limit INTEGER DEFAULT 2000
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_current_user_id TEXT := public.current_user_id();
  v_is_admin BOOLEAN := public.is_admin();
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 2000);
  v_items JSONB := '[]'::JSONB;
  v_count INTEGER := 0;
BEGIN
  IF v_current_user_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;
  IF p_department_id IS NULL OR btrim(p_department_id) = '' OR length(p_department_id) > 128
     OR p_week_ids IS NULL OR cardinality(p_week_ids) = 0 OR cardinality(p_week_ids) > 53
     OR EXISTS (
       SELECT 1
       FROM unnest(p_week_ids) AS week_id
       WHERE week_id IS NULL OR week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
     ) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务范围参数无效';
  END IF;

  IF v_is_admin THEN
    WITH bounded AS (
      SELECT task_row.*
      FROM public.tasks AS task_row
      LEFT JOIN public.users AS owner_user
        ON task_row.department_id IS NULL
       AND owner_user.id = task_row.owner_id
      WHERE COALESCE(task_row.department_id, owner_user.department_id) = p_department_id
        AND COALESCE(task_row.target_weeks, '[]'::JSONB) ?| p_week_ids
      ORDER BY task_row.updated_at DESC, task_row.id DESC
      LIMIT v_limit + 1
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(bounded) ORDER BY bounded.updated_at DESC, bounded.id DESC), '[]'::JSONB),
           count(*)::INTEGER
      INTO v_items, v_count
    FROM bounded;
  ELSE
    WITH visible_departments AS MATERIALIZED (
      SELECT department_row.id
      FROM public.departments AS department_row
      WHERE public.current_user_has_department_visibility(department_row.id)
    ), bounded AS (
      SELECT task_row.*
      FROM public.tasks AS task_row
      LEFT JOIN public.users AS owner_user
        ON task_row.department_id IS NULL
       AND owner_user.id = task_row.owner_id
      LEFT JOIN visible_departments AS visible_department
        ON visible_department.id = COALESCE(task_row.department_id, owner_user.department_id)
      WHERE COALESCE(task_row.department_id, owner_user.department_id) = p_department_id
        AND COALESCE(task_row.target_weeks, '[]'::JSONB) ?| p_week_ids
        AND (
          task_row.created_by = v_current_user_id
          OR task_row.owner_id = v_current_user_id
          OR COALESCE(task_row.participant_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
          OR COALESCE(task_row.approver_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
          OR visible_department.id IS NOT NULL
        )
      ORDER BY task_row.updated_at DESC, task_row.id DESC
      LIMIT v_limit + 1
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(bounded) ORDER BY bounded.updated_at DESC, bounded.id DESC), '[]'::JSONB),
           count(*)::INTEGER
      INTO v_items, v_count
    FROM bounded;
  END IF;

  IF v_count > v_limit THEN
    v_items := v_items - (v_count - 1);
  END IF;

  RETURN jsonb_build_object(
    'items', v_items,
    'truncated', v_count > v_limit,
    'totalReturned', LEAST(v_count, v_limit)
  );
END;
$$;

-- Replace the page implementation without changing its MCP signature. The
-- visibility predicates stay in the same query, so each page avoids joining a
-- freshly materialized full visible-id set.
CREATE OR REPLACE FUNCTION public.mcp_get_visible_tasks_page(
  p_limit INTEGER DEFAULT 50,
  p_cursor_updated_at BIGINT DEFAULT NULL,
  p_cursor_id TEXT DEFAULT NULL,
  p_department_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_week_id TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_current_user_id TEXT := public.current_user_id();
  v_is_admin BOOLEAN := public.is_admin();
  v_rows JSONB;
BEGIN
  IF v_current_user_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;
  IF p_week_id IS NOT NULL AND p_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: weekId 无效';
  END IF;
  IF (p_cursor_updated_at IS NULL) <> (p_cursor_id IS NULL)
     OR length(COALESCE(p_department_id, '')) > 128
     OR length(COALESCE(p_status, '')) > 64
     OR length(COALESCE(p_query, '')) > 100 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 分页参数无效';
  END IF;

  IF v_is_admin THEN
    WITH page AS (
      SELECT t.*
      FROM public.tasks AS t
      WHERE (p_department_id IS NULL OR t.department_id = p_department_id)
        AND (p_status IS NULL OR t.status = p_status)
        AND (p_week_id IS NULL OR COALESCE(t.target_weeks, '[]'::JSONB) @> jsonb_build_array(p_week_id))
        AND (p_query IS NULL OR p_query = '' OR t.title ILIKE '%' || p_query || '%')
        AND (p_cursor_updated_at IS NULL
          OR t.updated_at < p_cursor_updated_at
          OR (t.updated_at = p_cursor_updated_at AND t.id < p_cursor_id))
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT v_limit + 1
    )
    SELECT jsonb_agg(to_jsonb(page) ORDER BY page.updated_at DESC, page.id DESC)
      INTO v_rows
    FROM page;
  ELSE
    WITH visible_departments AS MATERIALIZED (
      SELECT department_row.id
      FROM public.departments AS department_row
      WHERE public.current_user_has_department_visibility(department_row.id)
    ), page AS (
      SELECT t.*
      FROM public.tasks AS t
      LEFT JOIN public.users AS owner_user
        ON t.department_id IS NULL
       AND owner_user.id = t.owner_id
      LEFT JOIN visible_departments AS visible_department
        ON visible_department.id = COALESCE(t.department_id, owner_user.department_id)
      WHERE (
          t.created_by = v_current_user_id
          OR t.owner_id = v_current_user_id
          OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
          OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
          OR visible_department.id IS NOT NULL
        )
        AND (p_department_id IS NULL OR t.department_id = p_department_id)
        AND (p_status IS NULL OR t.status = p_status)
        AND (p_week_id IS NULL OR COALESCE(t.target_weeks, '[]'::JSONB) @> jsonb_build_array(p_week_id))
        AND (p_query IS NULL OR p_query = '' OR t.title ILIKE '%' || p_query || '%')
        AND (p_cursor_updated_at IS NULL
          OR t.updated_at < p_cursor_updated_at
          OR (t.updated_at = p_cursor_updated_at AND t.id < p_cursor_id))
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT v_limit + 1
    )
    SELECT jsonb_agg(to_jsonb(page) ORDER BY page.updated_at DESC, page.id DESC)
      INTO v_rows
    FROM page;
  END IF;

  RETURN public.mcp_workbench_page_metadata(COALESCE(v_rows, '[]'::JSONB), v_limit);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_get_readiness()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'status', CASE WHEN (
      to_regprocedure('public.mcp_get_personal_workbench_page(integer,bigint,text,text,bigint,text,text,bigint,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_visible_tasks_page(integer,bigint,text,text,text,text,text)') IS NOT NULL
      AND to_regprocedure('public.web_get_visible_tasks_full(integer)') IS NOT NULL
      AND to_regprocedure('public.web_get_visible_tasks_scope(text,text[],integer)') IS NOT NULL
      AND to_regprocedure('public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)') IS NOT NULL
    ) THEN 'ready' ELSE 'degraded' END,
    'migrationVersion', CASE WHEN to_regprocedure('public.web_get_visible_tasks_full(integer)') IS NOT NULL
      THEN '2026-08-28' ELSE '2026-08-27' END,
    'personalWorkbenchRpc', to_regprocedure('public.mcp_get_personal_workbench_page(integer,bigint,text,text,bigint,text,text,bigint,text)') IS NOT NULL,
    'visibleTasksRpc', to_regprocedure('public.mcp_get_visible_tasks_page(integer,bigint,text,text,text,text,text)') IS NOT NULL,
    'webTaskFullRpc', to_regprocedure('public.web_get_visible_tasks_full(integer)') IS NOT NULL,
    'webTaskScopeRpc', to_regprocedure('public.web_get_visible_tasks_scope(text,text[],integer)') IS NOT NULL,
    'reviewSyncRpc', to_regprocedure('public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)') IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.web_get_visible_tasks_full(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.web_get_visible_tasks_scope(TEXT, TEXT[], INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_readiness() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.web_get_visible_tasks_full(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.web_get_visible_tasks_scope(TEXT, TEXT[], INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_readiness() TO anon, authenticated;

COMMIT;
