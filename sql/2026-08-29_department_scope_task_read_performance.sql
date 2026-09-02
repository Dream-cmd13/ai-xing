-- Short-circuit scoped task reads on the precomputed visible department ID.
-- This preserves relationship fallbacks while avoiding repeated identity RPCs.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_get_department_tasks_page(
  p_department_id TEXT,
  p_scope TEXT DEFAULT 'auto',
  p_week_id TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
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
  v_scope JSONB;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_current_user_id TEXT := public.current_user_id();
  v_is_admin BOOLEAN := public.is_admin();
  v_items JSONB;
  v_count INTEGER;
  v_total INTEGER := 0;
  v_has_more BOOLEAN := FALSE;
BEGIN
  IF p_week_id IS NOT NULL AND p_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: weekId 无效';
  END IF;
  IF (p_cursor_updated_at IS NULL) <> (p_cursor_id IS NULL)
     OR length(COALESCE(p_query, '')) > 100
     OR length(COALESCE(p_status, '')) > 64 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 部门任务分页参数无效';
  END IF;

  v_scope := public.mcp_collect_department_scope_ids(p_department_id, p_scope);
  WITH nodes AS MATERIALIZED (
    SELECT node_id, node_name
    FROM public.mcp_department_tree_nodes()
  ), scope_ids AS MATERIALIZED (
    SELECT value AS id
    FROM jsonb_array_elements_text(COALESCE(v_scope->'ids', '[]'::JSONB))
  ), visible_scope_ids AS MATERIALIZED (
    SELECT id
    FROM scope_ids
    WHERE public.mcp_current_user_can_see_department_node(id)
  ), ranked AS (
    SELECT DISTINCT ON (t.id)
      t.id, t.created_by, t.title, t.status, t.priority, t.owner_id, t.department_id,
      t.aligned_kr_id, t.target_weeks, t.start_date, t.due_date, t.tags,
      t.participant_ids, t.approver_ids, t.updated_at, t.row_version,
      owner_user.name AS owner_name,
      COALESCE(node.node_name, department_row.name, owner_node.node_name) AS department_name,
      COALESCE(t.department_id, owner_user.department_id) AS resolved_department_id
    FROM public.tasks t
    LEFT JOIN public.users owner_user ON owner_user.id = t.owner_id
    LEFT JOIN public.departments department_row ON department_row.id = t.department_id
    LEFT JOIN nodes node ON node.node_id = t.department_id
    LEFT JOIN nodes owner_node ON owner_node.node_id = owner_user.department_id
    JOIN scope_ids s ON s.id = COALESCE(t.department_id, owner_user.department_id)
    LEFT JOIN visible_scope_ids visible_scope ON visible_scope.id = s.id
    WHERE (
      visible_scope.id IS NOT NULL
      OR v_is_admin
      OR t.created_by = v_current_user_id
      OR t.owner_id = v_current_user_id
      OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
      OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
    )
      AND (p_week_id IS NULL OR COALESCE(t.target_weeks, '[]'::JSONB) @> jsonb_build_array(p_week_id))
      AND (p_status IS NULL OR t.status = p_status)
      AND (p_query IS NULL OR p_query = '' OR t.title ILIKE '%' || p_query || '%')
      AND (p_cursor_updated_at IS NULL OR t.updated_at < p_cursor_updated_at
        OR (t.updated_at = p_cursor_updated_at AND t.id < p_cursor_id))
    ORDER BY t.id, t.updated_at DESC
  ), counted AS (
    SELECT ranked.*, count(*) OVER ()::INTEGER AS total_count
    FROM ranked
  ), page AS (
    SELECT *
    FROM counted
    ORDER BY updated_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'created_by', created_by, 'title', title, 'status', status, 'priority', priority,
    'owner_id', owner_id, 'owner_name', owner_name, 'department_id', resolved_department_id,
    'department_name', department_name, 'aligned_kr_id', aligned_kr_id,
    'target_weeks', COALESCE(target_weeks, '[]'::JSONB), 'start_date', start_date, 'due_date', due_date,
    'tags', COALESCE(tags, '[]'::JSONB), 'participant_ids', COALESCE(participant_ids, '[]'::JSONB),
    'approver_ids', COALESCE(approver_ids, '[]'::JSONB), 'updated_at', updated_at, 'row_version', row_version
  ) ORDER BY updated_at DESC, id DESC), '[]'::JSONB),
    count(*)::INTEGER,
    COALESCE(max(total_count), 0)
  INTO v_items, v_count, v_total
  FROM page;

  v_has_more := v_count > v_limit;
  IF v_has_more THEN
    v_items := v_items - (v_count - 1);
    v_count := v_limit;
  END IF;

  RETURN jsonb_build_object(
    'department', v_scope->'department',
    'scope', v_scope->>'scope',
    'items', v_items,
    'total', v_total,
    'hasMore', v_has_more,
    'nextCursor', CASE WHEN jsonb_array_length(v_items) > 0 AND v_has_more THEN
      jsonb_build_object(
        'updatedAt', (v_items->(jsonb_array_length(v_items)-1)->>'updated_at')::BIGINT,
        'id', v_items->(jsonb_array_length(v_items)-1)->>'id'
      )
      ELSE NULL END,
    'truncated', FALSE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.web_get_visible_tasks_scope_v2(
  p_department_id TEXT,
  p_week_ids TEXT[],
  p_limit INTEGER DEFAULT 2000,
  p_scope TEXT DEFAULT 'auto'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_scope JSONB;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 2000);
  v_current_user_id TEXT := public.current_user_id();
  v_is_admin BOOLEAN := public.is_admin();
  v_items JSONB;
  v_count INTEGER;
BEGIN
  IF p_week_ids IS NULL OR cardinality(p_week_ids) = 0 OR cardinality(p_week_ids) > 53
    OR EXISTS (
      SELECT 1
      FROM unnest(p_week_ids) week_id
      WHERE week_id IS NULL OR week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
    ) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务范围参数无效';
  END IF;

  v_scope := public.mcp_collect_department_scope_ids(p_department_id, p_scope);
  WITH scope_ids AS MATERIALIZED (
    SELECT value AS id
    FROM jsonb_array_elements_text(COALESCE(v_scope->'ids', '[]'::JSONB))
  ), visible_scope_ids AS MATERIALIZED (
    SELECT id
    FROM scope_ids
    WHERE public.mcp_current_user_can_see_department_node(id)
  ), bounded AS (
    SELECT DISTINCT ON (t.id)
      t.*,
      COALESCE(t.department_id, owner_user.department_id) AS resolved_department_id
    FROM public.tasks t
    LEFT JOIN public.users owner_user ON owner_user.id = t.owner_id
    JOIN scope_ids s ON s.id = COALESCE(t.department_id, owner_user.department_id)
    LEFT JOIN visible_scope_ids visible_scope ON visible_scope.id = s.id
    WHERE COALESCE(t.target_weeks, '[]'::JSONB) ?| p_week_ids
      AND (
        visible_scope.id IS NOT NULL
        OR v_is_admin
        OR t.created_by = v_current_user_id
        OR t.owner_id = v_current_user_id
        OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
        OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(v_current_user_id)
      )
    ORDER BY t.id, t.updated_at DESC
  ), page AS (
    SELECT *
    FROM bounded
    ORDER BY updated_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.updated_at DESC, page.id DESC), '[]'::JSONB),
    count(*)::INTEGER
  INTO v_items, v_count
  FROM page;

  IF v_count > v_limit THEN
    v_items := v_items - (v_count - 1);
  END IF;

  RETURN jsonb_build_object(
    'items', v_items,
    'truncated', v_count > v_limit,
    'totalReturned', LEAST(v_count, v_limit),
    'scope', v_scope->>'scope'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_get_department_tasks_page(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.web_get_visible_tasks_scope_v2(TEXT, TEXT[], INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_get_department_tasks_page(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.web_get_visible_tasks_scope_v2(TEXT, TEXT[], INTEGER, TEXT)
  TO authenticated;

-- Manual rollback: restore both RPC definitions from
-- 2026-08-29_nested_department_scope.sql and restore their grants.

COMMIT;
