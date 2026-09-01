-- Canonical task validation and task-user enrichment privilege hardening.
-- Existing checksummed migrations remain unchanged; public RPC signatures stay stable.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_validate_task_changes(
  p_changes JSONB,
  p_allow_submitted BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_item JSONB;
  v_text TEXT;
  v_start BIGINT;
  v_due BIGINT;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::JSONB THEN
    RAISE EXCEPTION 'MCP_VALIDATION: changes 必须是非空对象';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
    IF v_key NOT IN (
      'department_id', 'owner_id', 'title', 'status', 'priority', 'aligned_kr_id',
      'target_weeks', 'start_date', 'due_date', 'tags', 'participant_ids',
      'approver_ids', 'plan', 'action', 'deliverable', 'task_review', 'task_review_score'
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: changes 包含不允许的字段 %', v_key;
    END IF;
  END LOOP;

  IF p_changes ? 'title' AND (
    jsonb_typeof(p_changes->'title') <> 'string'
    OR length(btrim(p_changes->>'title')) = 0
    OR length(p_changes->>'title') > 200
  ) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: title 长度必须在 1 到 200 个字符之间';
  END IF;

  IF p_changes ? 'status' THEN
    IF jsonb_typeof(p_changes->'status') <> 'string'
       OR p_changes->>'status' NOT IN ('draft', 'submitted', 'approved', 'completed', 'in-progress', 'paused', 'terminated') THEN
      RAISE EXCEPTION 'MCP_VALIDATION: status 无效';
    END IF;
    IF p_changes->>'status' = 'submitted' AND NOT p_allow_submitted THEN
      RAISE EXCEPTION 'MCP_VALIDATION: submitted 状态只能通过提交接口设置';
    END IF;
  END IF;

  IF p_changes ? 'priority' AND (
    jsonb_typeof(p_changes->'priority') <> 'string'
    OR p_changes->>'priority' NOT IN ('high', 'medium', 'low')
  ) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: priority 无效';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['department_id', 'owner_id'] LOOP
    IF p_changes ? v_key AND (
      jsonb_typeof(p_changes->v_key) <> 'string'
      OR length(btrim(p_changes->>v_key)) = 0
      OR length(p_changes->>v_key) > 128
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: % 无效', v_key;
    END IF;
  END LOOP;

  IF p_changes ? 'aligned_kr_id' AND jsonb_typeof(p_changes->'aligned_kr_id') <> 'null' THEN
    IF jsonb_typeof(p_changes->'aligned_kr_id') <> 'string'
       OR length(p_changes->>'aligned_kr_id') > 128
       OR (
         p_changes->>'aligned_kr_id' <> ''
         AND p_changes->>'aligned_kr_id' !~ '^.+-kr-(?:[0-9]|[1-9][0-9]|100)$'
       ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: aligned_kr_id 格式或 KR 下标无效';
    END IF;
  END IF;

  IF p_changes ? 'target_weeks' THEN
    IF jsonb_typeof(p_changes->'target_weeks') <> 'array'
       OR jsonb_array_length(p_changes->'target_weeks') > 53 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 必须是最多 53 项的数组';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_changes->'target_weeks') LOOP
      IF jsonb_typeof(v_item) <> 'string'
         OR (v_item #>> '{}') !~ '^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$' THEN
        RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 包含无效周次';
      END IF;
    END LOOP;
    IF (
      SELECT count(*) <> count(DISTINCT value)
      FROM jsonb_array_elements_text(p_changes->'target_weeks') AS week(value)
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 不允许重复';
    END IF;
  END IF;

  IF p_changes ? 'tags' THEN
    IF jsonb_typeof(p_changes->'tags') <> 'array' OR jsonb_array_length(p_changes->'tags') > 12 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: tags 必须是最多 12 项的数组';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_changes->'tags') LOOP
      IF jsonb_typeof(v_item) <> 'string' OR length(v_item #>> '{}') > 32 THEN
        RAISE EXCEPTION 'MCP_VALIDATION: tags 单项长度不能超过 32 个字符';
      END IF;
    END LOOP;
  END IF;

  FOREACH v_key IN ARRAY ARRAY['participant_ids', 'approver_ids'] LOOP
    IF p_changes ? v_key THEN
      IF jsonb_typeof(p_changes->v_key) <> 'array'
         OR jsonb_array_length(p_changes->v_key) > (CASE WHEN v_key = 'participant_ids' THEN 50 ELSE 20 END) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: % 数组长度无效', v_key;
      END IF;
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_changes->v_key) LOOP
        IF jsonb_typeof(v_item) <> 'string' THEN
          RAISE EXCEPTION 'MCP_VALIDATION: % 必须只包含用户 ID', v_key;
        END IF;
        v_text := v_item #>> '{}';
        IF length(btrim(v_text)) = 0 OR length(v_text) > 128
           OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_text) THEN
          RAISE EXCEPTION 'MCP_VALIDATION: % 包含无效用户 ID', v_key;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  FOREACH v_key IN ARRAY ARRAY['plan', 'action', 'deliverable', 'task_review'] LOOP
    IF p_changes ? v_key AND jsonb_typeof(p_changes->v_key) <> 'null' AND (
      jsonb_typeof(p_changes->v_key) <> 'string' OR length(p_changes->>v_key) > 2000
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: % 长度不能超过 2000 个字符', v_key;
    END IF;
  END LOOP;

  IF p_changes ? 'task_review_score' AND jsonb_typeof(p_changes->'task_review_score') <> 'null' AND (
    jsonb_typeof(p_changes->'task_review_score') <> 'number'
    OR (p_changes->>'task_review_score') !~ '^\d+$'
    OR (p_changes->>'task_review_score')::INTEGER NOT BETWEEN 0 AND 100
  ) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: task_review_score 必须是 0 到 100 的整数';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['start_date', 'due_date'] LOOP
    IF p_changes ? v_key AND jsonb_typeof(p_changes->v_key) <> 'null' AND (
      jsonb_typeof(p_changes->v_key) <> 'number'
      OR (p_changes->>v_key) !~ '^\d+$'
      OR length(p_changes->>v_key) > 19
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: % 必须是非负整数时间戳', v_key;
    END IF;
  END LOOP;
  IF p_changes ? 'start_date' AND jsonb_typeof(p_changes->'start_date') <> 'null' THEN
    v_start := (p_changes->>'start_date')::BIGINT;
  END IF;
  IF p_changes ? 'due_date' AND jsonb_typeof(p_changes->'due_date') <> 'null' THEN
    v_due := (p_changes->>'due_date')::BIGINT;
  END IF;
  IF v_start IS NOT NULL AND v_due IS NOT NULL AND v_due < v_start THEN
    RAISE EXCEPTION 'MCP_VALIDATION: due_date 不能早于 start_date';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_validate_task_row_contract()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.mcp_validate_task_changes(jsonb_build_object(
    'department_id', NEW.department_id,
    'owner_id', NEW.owner_id,
    'title', NEW.title,
    'status', NEW.status,
    'priority', NEW.priority,
    'aligned_kr_id', to_jsonb(NEW.aligned_kr_id),
    'target_weeks', COALESCE(NEW.target_weeks, '[]'::JSONB),
    'start_date', to_jsonb(NEW.start_date),
    'due_date', to_jsonb(NEW.due_date),
    'tags', COALESCE(NEW.tags, '[]'::JSONB),
    'participant_ids', COALESCE(NEW.participant_ids, '[]'::JSONB),
    'approver_ids', COALESCE(NEW.approver_ids, '[]'::JSONB),
    'plan', to_jsonb(NEW.plan),
    'action', to_jsonb(NEW.action),
    'deliverable', to_jsonb(NEW.deliverable),
    'task_review', to_jsonb(NEW.task_review),
    'task_review_score', to_jsonb(NEW.task_review_score)
  ), TRUE);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mcp_validate_task_row_contract_trigger ON public.tasks;
CREATE TRIGGER mcp_validate_task_row_contract_trigger
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.mcp_validate_task_row_contract();

DO $$
BEGIN
  IF to_regprocedure('public.mcp_update_pad_task_impl_20260901(text,jsonb,bigint,text)') IS NULL THEN
    ALTER FUNCTION public.mcp_update_pad_task(TEXT, JSONB, BIGINT, TEXT)
      RENAME TO mcp_update_pad_task_impl_20260901;
  END IF;
  IF to_regprocedure('public.mcp_update_pad_task_scoped_impl_20260901(text,jsonb,bigint,text)') IS NULL THEN
    ALTER FUNCTION public.mcp_update_pad_task_scoped(TEXT, JSONB, BIGINT, TEXT)
      RENAME TO mcp_update_pad_task_scoped_impl_20260901;
  END IF;
  IF to_regprocedure('public.mcp_review_sync_impl_20260901(text,jsonb,text,text,integer,bigint,bigint,text)') IS NULL THEN
    ALTER FUNCTION public.mcp_update_pad_task_with_review_sync(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT)
      RENAME TO mcp_review_sync_impl_20260901;
  END IF;
  IF to_regprocedure('public.mcp_review_sync_scoped_impl_20260901(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])') IS NULL THEN
    ALTER FUNCTION public.mcp_update_pad_task_with_review_sync_scoped(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT, TEXT, TEXT[])
      RENAME TO mcp_review_sync_scoped_impl_20260901;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_update_pad_task(
  p_task_id TEXT, p_changes JSONB, p_expected_row_version BIGINT, p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.mcp_validate_task_changes(p_changes, FALSE);
  RETURN public.mcp_update_pad_task_impl_20260901(p_task_id, p_changes, p_expected_row_version, p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_update_pad_task_scoped(
  p_task_id TEXT, p_changes JSONB, p_expected_row_version BIGINT, p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.mcp_validate_task_changes(p_changes, FALSE);
  RETURN public.mcp_update_pad_task_scoped_impl_20260901(p_task_id, p_changes, p_expected_row_version, p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_update_pad_task_with_review_sync(
  p_task_id TEXT, p_changes JSONB, p_review_period_key TEXT, p_review_key TEXT,
  p_kr_index INTEGER, p_expected_row_version BIGINT,
  p_expected_department_row_version BIGINT, p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.mcp_validate_task_changes(p_changes, FALSE);
  RETURN public.mcp_review_sync_impl_20260901(
    p_task_id, p_changes, p_review_period_key, p_review_key, p_kr_index,
    p_expected_row_version, p_expected_department_row_version, p_request_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_update_pad_task_with_review_sync_scoped(
  p_task_id TEXT, p_changes JSONB, p_review_period_key TEXT, p_review_key TEXT,
  p_kr_index INTEGER, p_expected_row_version BIGINT,
  p_expected_department_row_version BIGINT, p_request_id TEXT,
  p_department_root_id TEXT, p_department_node_path TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.mcp_validate_task_changes(p_changes, FALSE);
  RETURN public.mcp_review_sync_scoped_impl_20260901(
    p_task_id, p_changes, p_review_period_key, p_review_key, p_kr_index,
    p_expected_row_version, p_expected_department_row_version, p_request_id,
    p_department_root_id, p_department_node_path
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_task_users_for_tasks(p_task_ids TEXT[])
RETURNS TABLE (
  id TEXT, auth_id UUID, username TEXT, name TEXT, role TEXT, department_id TEXT,
  pad_permissions JSONB, reviews JSONB, system_role_ids JSONB, custom_permissions JSONB,
  updated_at BIGINT, row_version BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  v_is_admin := public.is_admin();
  RETURN QUERY
  WITH selected_tasks AS (
    SELECT task_row.id, task_row.department_id, task_row.created_by, task_row.owner_id,
           task_row.participant_ids, task_row.approver_ids
    FROM public.tasks task_row
    WHERE task_row.id = ANY(COALESCE(p_task_ids, ARRAY[]::TEXT[]))
  ), visible_tasks AS (
    SELECT selected_tasks.*
    FROM selected_tasks
    WHERE v_is_admin OR public.current_user_can_view_task(
      selected_tasks.department_id, selected_tasks.created_by, selected_tasks.owner_id,
      selected_tasks.participant_ids, selected_tasks.approver_ids
    )
  ), related_user_ids AS (
    SELECT visible_tasks.created_by AS user_id FROM visible_tasks WHERE visible_tasks.created_by IS NOT NULL
    UNION SELECT visible_tasks.owner_id FROM visible_tasks WHERE visible_tasks.owner_id IS NOT NULL
    UNION SELECT value FROM visible_tasks
      CROSS JOIN LATERAL public.jsonb_text_values(COALESCE(visible_tasks.participant_ids, '[]'::JSONB))
    UNION SELECT value FROM visible_tasks
      CROSS JOIN LATERAL public.jsonb_text_values(COALESCE(visible_tasks.approver_ids, '[]'::JSONB))
  )
  SELECT DISTINCT user_row.id, user_row.auth_id, user_row.username, user_row.name,
    user_row.role, user_row.department_id, user_row.pad_permissions, user_row.reviews,
    user_row.system_role_ids, user_row.custom_permissions, user_row.updated_at, user_row.row_version
  FROM public.users user_row
  JOIN related_user_ids related_user ON related_user.user_id = user_row.id;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_validate_task_changes(JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_validate_task_row_contract() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_impl_20260901(TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_scoped_impl_20260901(TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_review_sync_impl_20260901(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_review_sync_scoped_impl_20260901(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task(TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_scoped(TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_with_review_sync(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_with_review_sync_scoped(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_current_user_task_users_for_tasks(TEXT[]) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task(TEXT, JSONB, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task_scoped(TEXT, JSONB, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task_with_review_sync(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task_with_review_sync_scoped(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_user_task_users_for_tasks(TEXT[]) TO authenticated;

COMMIT;
