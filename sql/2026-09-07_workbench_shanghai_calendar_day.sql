-- Group personal workbench tasks by inclusive Asia/Shanghai calendar dates.
-- Task timestamps and historical rows remain unchanged.

BEGIN;

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
  v_today DATE := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::DATE;
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
      AND (to_timestamp(start_date / 1000.0) AT TIME ZONE 'Asia/Shanghai')::DATE <= v_today
      AND (to_timestamp(due_date / 1000.0) AT TIME ZONE 'Asia/Shanghai')::DATE >= v_today
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

REVOKE ALL ON FUNCTION public.mcp_get_personal_workbench_page(INTEGER, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_get_personal_workbench_page(INTEGER, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT)
  TO authenticated;

DO $$
DECLARE
  v_function REGPROCEDURE;
  v_readiness_before TEXT;
  v_readiness_after TEXT;
BEGIN
  v_function := to_regprocedure('public.mcp_get_readiness()');
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'MCP_RELEASE_CONTRACT_UPDATE_FAILED: readiness function is missing';
  END IF;

  SELECT pg_get_functiondef(v_function) INTO v_readiness_before;
  v_readiness_after := replace(v_readiness_before, E'\r\n', E'\n');
  v_readiness_after := replace(
    v_readiness_after,
    '2026-09-04-task-title-unbounded',
    '2026-09-07-workbench-shanghai-day'
  );
  v_readiness_after := replace(
    v_readiness_after,
    '80eff4b39e6f90e90738613401edcb7199f2098c0b64ab359899ea47657f4c98',
    '624c3fdb85ce9702e9d7e64b1b9a38f24fcf76b1ecb280172e97ce448d543a97'
  );
  IF position('"2026-09-04_mcp_task_title_contract_fix"' IN v_readiness_after) = 0 THEN
    v_readiness_after := replace(
      v_readiness_after,
      E'"2026-09-03_mcp_task_title_unbounded"\n    ]',
      E'"2026-09-03_mcp_task_title_unbounded",\n      "2026-09-04_mcp_task_title_contract_fix"\n    ]'
    );
  END IF;
  v_readiness_after := replace(
    v_readiness_after,
    '''migrationVersion'', ''2026-09-04_mcp_task_title_contract_fix''',
    '''migrationVersion'', ''2026-09-07_workbench_shanghai_calendar_day'''
  );

  IF position('2026-09-07-workbench-shanghai-day' IN v_readiness_after) = 0
     OR position('624c3fdb85ce9702e9d7e64b1b9a38f24fcf76b1ecb280172e97ce448d543a97' IN v_readiness_after) = 0
     OR position('"2026-09-04_mcp_task_title_contract_fix"' IN v_readiness_after) = 0
     OR position('''migrationVersion'', ''2026-09-07_workbench_shanghai_calendar_day''' IN v_readiness_after) = 0 THEN
    RAISE EXCEPTION 'MCP_RELEASE_CONTRACT_UPDATE_FAILED: readiness contract was not updated';
  END IF;

  IF v_readiness_after <> v_readiness_before THEN
    EXECUTE v_readiness_after;
  END IF;
END;
$$;

COMMIT;
