-- Task center paging must apply the department scope before LIMIT.
-- This is additive and keeps the existing task-list RPC available for rollback.

BEGIN;

CREATE OR REPLACE FUNCTION public.web_get_task_center_page(
  p_department_id TEXT DEFAULT NULL,
  p_scope TEXT DEFAULT 'all',
  p_status TEXT DEFAULT NULL,
  p_priority TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 100,
  p_cursor_updated_at BIGINT DEFAULT NULL,
  p_cursor_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_current_user_id TEXT := public.current_user_id();
  v_is_admin BOOLEAN := public.is_admin();
  v_scope_name TEXT := lower(COALESCE(NULLIF(btrim(p_scope), ''), 'all'));
  v_scope JSONB;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
  v_items JSONB := '[]'::JSONB;
  v_page_count INTEGER := 0;
  v_total BIGINT := 0;
  v_has_more BOOLEAN := FALSE;
  v_last JSONB;
BEGIN
  IF v_current_user_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;

  IF length(COALESCE(p_department_id, '')) > 128
     OR length(COALESCE(p_status, '')) > 64
     OR length(COALESCE(p_priority, '')) > 64
     OR length(COALESCE(p_query, '')) > 100
     OR (p_cursor_updated_at IS NULL) <> (p_cursor_id IS NULL)
     OR v_scope_name NOT IN ('all', 'auto', 'exact', 'subtree') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务中心分页参数无效';
  END IF;

  IF p_department_id IS NULL THEN
    IF v_scope_name <> 'all' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: 未选择部门时范围必须为 all';
    END IF;
    v_scope := jsonb_build_object('scope', 'all', 'ids', '[]'::JSONB);
  ELSE
    IF v_scope_name = 'all' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: 选择部门后范围不能为 all';
    END IF;
    v_scope := public.mcp_collect_department_scope_ids(p_department_id, v_scope_name);
  END IF;

  -- The filtered CTE is materialized before the cursor and LIMIT. This is the
  -- critical boundary that prevents a global first page from hiding a small
  -- department's tasks.
  WITH all_nodes AS MATERIALIZED (
    SELECT node_id
    FROM public.mcp_department_tree_nodes()
  ), requested_scope_ids AS MATERIALIZED (
    SELECT value AS id
    FROM jsonb_array_elements_text(COALESCE(v_scope->'ids', '[]'::JSONB))
  ), visible_scope_ids AS MATERIALIZED (
    SELECT node.node_id AS id
    FROM all_nodes node
    JOIN requested_scope_ids requested ON requested.id = node.node_id
    WHERE public.mcp_current_user_can_see_department_node(node.node_id)
  ), visible_all_ids AS MATERIALIZED (
    SELECT node.node_id AS id
    FROM all_nodes node
    WHERE public.mcp_current_user_can_see_department_node(node.node_id)
  ), filtered AS MATERIALIZED (
    SELECT
      task_row.*,
      COALESCE(task_row.department_id, owner_user.department_id) AS resolved_department_id
    FROM public.tasks task_row
    LEFT JOIN public.users owner_user
      ON owner_user.id = task_row.owner_id
    LEFT JOIN visible_scope_ids scoped
      ON scoped.id = COALESCE(task_row.department_id, owner_user.department_id)
    LEFT JOIN visible_all_ids visible_all
      ON visible_all.id = COALESCE(task_row.department_id, owner_user.department_id)
    WHERE (p_department_id IS NULL OR scoped.id IS NOT NULL)
      AND (
        v_is_admin
        OR task_row.created_by = v_current_user_id
        OR task_row.owner_id = v_current_user_id
        OR COALESCE(task_row.participant_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
        OR COALESCE(task_row.approver_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
        OR (p_department_id IS NULL AND visible_all.id IS NOT NULL)
        OR (p_department_id IS NOT NULL AND scoped.id IS NOT NULL)
      )
      AND (p_status IS NULL OR task_row.status = p_status)
      AND (p_priority IS NULL OR task_row.priority = p_priority)
      AND (
        p_query IS NULL OR p_query = ''
        OR task_row.title ILIKE '%' || p_query || '%'
        OR owner_user.name ILIKE '%' || p_query || '%'
      )
  ), counted AS MATERIALIZED (
    SELECT filtered.*, count(*) OVER ()::BIGINT AS total_count
    FROM filtered
  ), page AS (
    SELECT *
    FROM counted
    WHERE p_cursor_updated_at IS NULL
       OR updated_at < p_cursor_updated_at
       OR (updated_at = p_cursor_updated_at AND id < p_cursor_id)
    ORDER BY updated_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', id,
      'created_by', created_by,
      'title', title,
      'status', status,
      'priority', priority,
      'owner_id', owner_id,
      'department_id', resolved_department_id,
      'aligned_kr_id', aligned_kr_id,
      'target_weeks', COALESCE(target_weeks, '[]'::JSONB),
      'start_date', start_date,
      'due_date', due_date,
      'tags', COALESCE(tags, '[]'::JSONB),
      'participant_ids', COALESCE(participant_ids, '[]'::JSONB),
      'approver_ids', COALESCE(approver_ids, '[]'::JSONB),
      'updated_at', updated_at,
      'row_version', row_version
    ) ORDER BY updated_at DESC, id DESC), '[]'::JSONB),
    count(*)::INTEGER,
    COALESCE((SELECT max(total_count) FROM counted), 0)
  INTO v_items, v_page_count, v_total
  FROM page;

  v_has_more := v_page_count > v_limit;
  IF v_has_more THEN
    v_items := v_items - (v_page_count - 1);
    v_last := v_items -> (jsonb_array_length(v_items) - 1);
  ELSIF jsonb_array_length(v_items) > 0 THEN
    v_last := v_items -> (jsonb_array_length(v_items) - 1);
  END IF;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'hasMore', v_has_more,
    'nextCursor', CASE WHEN v_has_more AND v_last IS NOT NULL THEN jsonb_build_object(
      'updatedAt', v_last->'updated_at',
      'id', v_last->'id'
    ) ELSE NULL END,
    'scope', COALESCE(v_scope->>'scope', v_scope_name),
    'truncated', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.web_get_task_center_page(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.web_get_task_center_page(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT)
  TO authenticated;

-- Keep readiness false until this task-center contract is present as well as
-- the existing OKR and review contracts.
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
      AND to_regprocedure('public.web_get_task_center_page(text,text,text,text,text,integer,bigint,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_company_okrs(integer,boolean)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_department_okrs(text,integer,text,boolean,integer)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_department_okrs_scope_v2(text,text,integer,text,boolean,integer)') IS NOT NULL
      AND to_regprocedure('public.mcp_normalize_okr_entry(jsonb)') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'mcp_internal')
      AND EXISTS (SELECT 1 FROM mcp_internal.schema_migrations WHERE version = '2026-08-31_mcp_okr_contract_hardening' AND status = 'success')
      AND EXISTS (SELECT 1 FROM mcp_internal.schema_migrations WHERE version = '2026-08-31_mcp_okr_task_attachment_fix' AND status = 'success')
      AND EXISTS (SELECT 1 FROM mcp_internal.schema_migrations WHERE version = '2026-08-31_mcp_okr_task_attachment_json_fallback' AND status = 'success')
    ) THEN 'ready' ELSE 'degraded' END,
    'migrationVersion', (
      SELECT version FROM mcp_internal.schema_migrations
      WHERE status = 'success' ORDER BY applied_at DESC LIMIT 1
    ),
    'companyOkrsRpc', to_regprocedure('public.mcp_get_company_okrs(integer,boolean)') IS NOT NULL,
    'departmentOkrsRpc', to_regprocedure('public.mcp_get_department_okrs(text,integer,text,boolean,integer)') IS NOT NULL,
    'scopedDepartmentOkrsRpc', to_regprocedure('public.mcp_get_department_okrs_scope_v2(text,text,integer,text,boolean,integer)') IS NOT NULL,
    'okrNormalizer', to_regprocedure('public.mcp_normalize_okr_entry(jsonb)') IS NOT NULL,
    'taskCenterRpc', to_regprocedure('public.web_get_task_center_page(text,text,text,text,text,integer,bigint,text)') IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.mcp_get_readiness() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_get_readiness() TO anon, authenticated;

COMMIT;
