-- MCP keyset pagination for visible tasks and the three personal workbench columns.
-- This migration is additive. It does not modify existing website RPC signatures.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_workbench_page_metadata(p_rows JSONB, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := jsonb_array_length(COALESCE(p_rows, '[]'::JSONB));
  v_items JSONB := COALESCE(p_rows, '[]'::JSONB);
  v_last JSONB;
  v_has_more BOOLEAN;
BEGIN
  v_has_more := v_count > p_limit;
  IF v_has_more THEN
    v_items := p_rows - (v_count - 1);
    v_last := v_items -> (p_limit - 1);
  ELSIF v_count > 0 THEN
    v_last := v_items -> (v_count - 1);
  END IF;
  RETURN jsonb_build_object(
    'items', v_items,
    'hasMore', v_has_more,
    'nextCursor', CASE WHEN NOT v_has_more OR v_last IS NULL THEN NULL ELSE jsonb_build_object(
      'updatedAt', v_last->'updated_at', 'id', v_last->'id'
    ) END,
    'truncated', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_get_personal_workbench_page(
  p_limit INTEGER DEFAULT 50,
  p_today_cursor_updated_at BIGINT DEFAULT NULL,
  p_today_cursor_id TEXT DEFAULT NULL,
  p_this_week_id TEXT DEFAULT NULL,
  p_this_week_cursor_updated_at BIGINT DEFAULT NULL,
  p_this_week_cursor_id TEXT DEFAULT NULL,
  p_next_week_id TEXT DEFAULT NULL,
  p_next_week_cursor_updated_at BIGINT DEFAULT NULL,
  p_next_week_cursor_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_now BIGINT := (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
  v_today_raw JSONB;
  v_this_week_raw JSONB;
  v_next_week_raw JSONB;
BEGIN
  v_user_id := public.current_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;
  IF p_this_week_id IS NULL OR p_this_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
     OR p_next_week_id IS NULL OR p_next_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 工作台周次无效';
  END IF;
  IF (p_today_cursor_updated_at IS NULL) <> (p_today_cursor_id IS NULL)
     OR (p_this_week_cursor_updated_at IS NULL) <> (p_this_week_cursor_id IS NULL)
     OR (p_next_week_cursor_updated_at IS NULL) <> (p_next_week_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 工作台游标必须成对提供';
  END IF;

  WITH personal AS (
    SELECT t.*
    FROM public.tasks AS t
    WHERE t.owner_id = v_user_id
       OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(v_user_id)
       OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(v_user_id)
  ), page AS (
    SELECT *
    FROM personal
    WHERE start_date IS NOT NULL AND due_date IS NOT NULL
      AND v_now BETWEEN start_date AND due_date
      AND (p_today_cursor_updated_at IS NULL
        OR updated_at < p_today_cursor_updated_at
        OR (updated_at = p_today_cursor_updated_at AND id < p_today_cursor_id))
    ORDER BY updated_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT jsonb_agg(to_jsonb(page) ORDER BY page.updated_at DESC, page.id DESC)
  INTO v_today_raw
  FROM page;

  WITH personal AS (
    SELECT t.*
    FROM public.tasks AS t
    WHERE t.owner_id = v_user_id
       OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(v_user_id)
       OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(v_user_id)
  ), page AS (
    SELECT *
    FROM personal
    WHERE COALESCE(target_weeks, '[]'::JSONB) @> jsonb_build_array(p_this_week_id)
      AND (p_this_week_cursor_updated_at IS NULL
        OR updated_at < p_this_week_cursor_updated_at
        OR (updated_at = p_this_week_cursor_updated_at AND id < p_this_week_cursor_id))
    ORDER BY updated_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT jsonb_agg(to_jsonb(page) ORDER BY page.updated_at DESC, page.id DESC)
  INTO v_this_week_raw
  FROM page;

  WITH personal AS (
    SELECT t.*
    FROM public.tasks AS t
    WHERE t.owner_id = v_user_id
       OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(v_user_id)
       OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(v_user_id)
  ), page AS (
    SELECT *
    FROM personal
    WHERE COALESCE(target_weeks, '[]'::JSONB) @> jsonb_build_array(p_next_week_id)
      AND (p_next_week_cursor_updated_at IS NULL
        OR updated_at < p_next_week_cursor_updated_at
        OR (updated_at = p_next_week_cursor_updated_at AND id < p_next_week_cursor_id))
    ORDER BY updated_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT jsonb_agg(to_jsonb(page) ORDER BY page.updated_at DESC, page.id DESC)
  INTO v_next_week_raw
  FROM page;

  RETURN jsonb_build_object(
    'userId', v_user_id,
    'limit', v_limit,
    'today', public.mcp_workbench_page_metadata(COALESCE(v_today_raw, '[]'::JSONB), v_limit),
    'thisWeek', public.mcp_workbench_page_metadata(COALESCE(v_this_week_raw, '[]'::JSONB), v_limit),
    'nextWeek', public.mcp_workbench_page_metadata(COALESCE(v_next_week_raw, '[]'::JSONB), v_limit)
  );
END;
$$;

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
  v_rows JSONB;
BEGIN
  IF public.current_user_id() IS NULL THEN
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

  WITH page AS (
    SELECT t.*
    FROM public.tasks AS t
    JOIN public.get_current_user_visible_task_ids() AS visible ON visible.id = t.id
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

  RETURN public.mcp_workbench_page_metadata(COALESCE(v_rows, '[]'::JSONB), v_limit);
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_get_personal_workbench_page(INTEGER, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_workbench_page_metadata(JSONB, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_visible_tasks_page(INTEGER, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.mcp_get_personal_workbench_page(INTEGER, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_visible_tasks_page(INTEGER, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO authenticated;

COMMIT;
