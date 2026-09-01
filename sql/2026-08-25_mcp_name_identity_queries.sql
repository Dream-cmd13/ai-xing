-- Phase two additive, read-only identity and team-query RPCs.
-- Apply only to the configured test Supabase project after impact approval.
BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_resolve_users_by_name(
  p_name TEXT,
  p_department_name TEXT DEFAULT NULL,
  p_purpose TEXT DEFAULT 'query'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
DECLARE
  v_name TEXT := btrim(p_name);
  v_department_name TEXT := NULLIF(btrim(p_department_name), '');
  v_rows JSONB;
  v_count INTEGER;
  v_department_count INTEGER;
BEGIN
  IF v_name IS NULL OR v_name = '' OR p_purpose IS NULL
     OR p_purpose NOT IN ('owner', 'participant', 'approver', 'query') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid identity reference';
  END IF;

  IF v_department_name IS NOT NULL THEN
    SELECT count(*)::INTEGER INTO v_department_count
    FROM public.departments d
    WHERE btrim(d.name) = v_department_name
      AND (
        public.is_admin()
        OR p_purpose IN ('participant', 'approver')
        OR public.current_user_has_department_visibility(d.id)
      );
    IF v_department_count = 0 THEN RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible'; END IF;
    IF v_department_count > 1 THEN RAISE EXCEPTION 'MCP_DEPARTMENT_NAME_AMBIGUOUS: duplicate visible departments'; END IF;
  END IF;

  SELECT count(*)::INTEGER, jsonb_agg(jsonb_build_object(
    'user_id', u.id, 'name', u.name, 'role', u.role,
    'department_id', u.department_id, 'department_name', d.name
  ) ORDER BY u.id)
  INTO v_count, v_rows
  FROM public.users u
  LEFT JOIN public.departments d ON d.id = u.department_id
  WHERE btrim(u.name) = v_name
    AND (v_department_name IS NULL OR btrim(d.name) = v_department_name)
    AND (
      public.is_admin()
      OR p_purpose IN ('participant', 'approver')
      OR (public.is_employee() AND u.id = public.current_user_id())
      OR (public.is_manager() AND p_purpose = 'owner' AND u.department_id = public.current_user_department_id())
      OR (public.is_manager() AND p_purpose = 'query' AND public.current_user_has_department_visibility(u.department_id))
    );

  IF v_count = 0 THEN RAISE EXCEPTION 'MCP_USER_NOT_FOUND: no visible exact match'; END IF;
  IF v_count > 1 AND v_department_name IS NULL THEN RAISE EXCEPTION 'MCP_USER_NAME_AMBIGUOUS: department required'; END IF;
  IF v_count > 1 THEN RAISE EXCEPTION 'MCP_USER_NAME_AMBIGUOUS: duplicate department match'; END IF;
  RETURN jsonb_build_object('user', v_rows->0);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_query_user_tasks(
  p_user_id TEXT,
  p_relation TEXT DEFAULT 'owner',
  p_month_start BIGINT DEFAULT NULL,
  p_month_end BIGINT DEFAULT NULL,
  p_week_id TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_offset INTEGER := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 1000);
  v_user JSONB;
  v_tasks JSONB;
  v_total INTEGER;
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = '' OR p_relation IS NULL
     OR p_relation NOT IN ('owner', 'participant', 'approver', 'any') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid task query';
  END IF;
  IF (p_month_start IS NULL) <> (p_month_end IS NULL)
     OR (p_month_start IS NOT NULL AND p_month_end <= p_month_start)
     OR (p_week_id IS NOT NULL AND p_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$')
     OR (p_query IS NOT NULL AND length(p_query) > 100)
     OR (p_status IS NOT NULL AND length(p_status) > 64) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid task filters';
  END IF;
  SELECT jsonb_build_object('user_id', u.id, 'name', u.name, 'role', u.role,
    'department_id', u.department_id, 'department_name', d.name)
  INTO v_user
  FROM public.users u LEFT JOIN public.departments d ON d.id = u.department_id
  WHERE u.id = p_user_id
    AND (
      public.is_admin()
      OR (public.is_employee() AND u.id = public.current_user_id())
      OR (public.is_manager() AND public.current_user_has_department_visibility(u.department_id))
    );
  IF v_user IS NULL THEN RAISE EXCEPTION 'MCP_PERMISSION_DENIED: target user is not visible'; END IF;

  WITH visible AS (
    SELECT t.*,
      COALESCE(t.department_id, task_owner_user.department_id) AS resolved_department_id,
      (SELECT d.name
       FROM public.departments d
       WHERE d.id = COALESCE(t.department_id, task_owner_user.department_id)) AS task_department_name
    FROM public.tasks t
    LEFT JOIN public.users task_owner_user ON task_owner_user.id = t.owner_id
    WHERE (
      public.is_admin()
      OR (
        public.is_employee()
        AND (
          t.owner_id = public.current_user_id()
          OR t.participant_ids @> jsonb_build_array(public.current_user_id())
          OR t.approver_ids @> jsonb_build_array(public.current_user_id())
        )
      )
      OR (
        public.is_manager()
        AND public.current_user_has_department_visibility(COALESCE(t.department_id, task_owner_user.department_id))
      )
    )
      AND CASE p_relation
        WHEN 'owner' THEN t.owner_id = p_user_id
        WHEN 'participant' THEN t.participant_ids @> jsonb_build_array(p_user_id)
        WHEN 'approver' THEN t.approver_ids @> jsonb_build_array(p_user_id)
        ELSE t.owner_id = p_user_id OR t.participant_ids @> jsonb_build_array(p_user_id) OR t.approver_ids @> jsonb_build_array(p_user_id)
      END
      AND (p_week_id IS NULL OR t.target_weeks @> jsonb_build_array(p_week_id))
      AND (p_status IS NULL OR t.status = p_status)
      AND (p_query IS NULL OR t.title ILIKE '%' || p_query || '%')
      AND (
        p_month_start IS NULL
        OR (
          t.start_date IS NOT NULL
          AND p_month_end IS NOT NULL
          AND t.start_date < p_month_end
          AND (t.due_date IS NULL OR t.due_date >= p_month_start)
        )
        OR (
          t.start_date IS NULL
          AND p_week_id IS NOT NULL
          AND t.target_weeks @> jsonb_build_array(p_week_id)
        )
      )
  ), counted AS (SELECT count(*)::INTEGER AS total FROM visible), page AS (
    SELECT jsonb_build_object(
      'id', id, 'title', title, 'status', status, 'priority', priority,
      'department_id', resolved_department_id, 'department_name', task_department_name,
      'owner_name', (SELECT u.name FROM public.users u WHERE u.id = owner_id),
      'owner_department_name', (SELECT d.name FROM public.departments d JOIN public.users u ON u.department_id = d.id WHERE u.id = owner_id),
      'aligned_kr_id', aligned_kr_id, 'target_weeks', target_weeks,
      'start_date', start_date, 'due_date', due_date, 'tags', tags,
      'relation_matches', array_remove(ARRAY[
        CASE WHEN owner_id = p_user_id THEN 'owner' END,
        CASE WHEN participant_ids @> jsonb_build_array(p_user_id) THEN 'participant' END,
        CASE WHEN approver_ids @> jsonb_build_array(p_user_id) THEN 'approver' END
      ]::TEXT[], NULL),
      'updated_at', updated_at, 'row_version', row_version
    ) AS item
    FROM visible ORDER BY updated_at DESC, id DESC OFFSET v_offset LIMIT v_limit
  )
  SELECT counted.total, COALESCE((SELECT jsonb_agg(item) FROM page), '[]'::jsonb)
  INTO v_total, v_tasks FROM counted;
  RETURN jsonb_build_object('user', v_user, 'tasks', COALESCE(v_tasks, '[]'::jsonb), 'total', v_total,
    'limit', v_limit, 'offset', v_offset, 'hasMore', v_offset + jsonb_array_length(COALESCE(v_tasks, '[]'::jsonb)) < v_total);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_get_weekly_review_gaps(
  p_week_id TEXT,
  p_department_id TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_offset INTEGER := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 1000);
  v_groups JSONB;
  v_total INTEGER;
BEGIN
  IF p_week_id IS NULL OR p_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN RAISE EXCEPTION 'MCP_VALIDATION: invalid week'; END IF;
  WITH candidates AS (
    SELECT t.id AS task_id, t.title, t.status, t.updated_at,
      COALESCE(t.department_id, task_owner_user.department_id) AS task_department_id,
      task_department.name AS task_department_name,
      t.target_weeks, u.id AS user_id, u.name, u.role, u.department_id, owner_department.name AS department_name,
      COALESCE(t.task_review, '') AS task_review,
      COALESCE(card.card_evaluation, '') AS card_evaluation,
      COALESCE(card.card_present, false) AS card_present
    FROM public.tasks t
    JOIN public.users u ON u.id = t.owner_id
    LEFT JOIN public.users task_owner_user ON task_owner_user.id = t.owner_id
    LEFT JOIN public.departments task_department ON task_department.id = COALESCE(t.department_id, task_owner_user.department_id)
    LEFT JOIN public.departments owner_department ON owner_department.id = u.department_id
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN jsonb_array_length(COALESCE(task_department.reviews -> p_week_id, '[]'::jsonb)) > 0 THEN
          (((task_department.reviews -> p_week_id)
            -> (jsonb_array_length(task_department.reviews -> p_week_id) - 1)
            -> 'okrDetails'
            -> (CASE WHEN position('-kr-' IN COALESCE(t.aligned_kr_id, '')) > 0
              AND split_part(t.aligned_kr_id, '-kr-', 2) ~ '^\d+$'
              THEN split_part(t.aligned_kr_id, '-kr-', 1) ELSE '__task__:' || t.id END)
            -> 'krReviews'
            -> (CASE WHEN position('-kr-' IN COALESCE(t.aligned_kr_id, '')) > 0
              AND split_part(t.aligned_kr_id, '-kr-', 2) ~ '^\d+$'
              THEN split_part(t.aligned_kr_id, '-kr-', 2)::INTEGER ELSE 0 END)
            -> 'taskEvaluations'
            ->> t.id) IS NOT NULL)
        ELSE false END AS card_present,
        CASE WHEN jsonb_array_length(COALESCE(task_department.reviews -> p_week_id, '[]'::jsonb)) > 0 THEN
          COALESCE(((task_department.reviews -> p_week_id)
            -> (jsonb_array_length(task_department.reviews -> p_week_id) - 1)
            -> 'okrDetails'
            -> (CASE WHEN position('-kr-' IN COALESCE(t.aligned_kr_id, '')) > 0
              AND split_part(t.aligned_kr_id, '-kr-', 2) ~ '^\d+$'
              THEN split_part(t.aligned_kr_id, '-kr-', 1) ELSE '__task__:' || t.id END)
            -> 'krReviews'
            -> (CASE WHEN position('-kr-' IN COALESCE(t.aligned_kr_id, '')) > 0
              AND split_part(t.aligned_kr_id, '-kr-', 2) ~ '^\d+$'
              THEN split_part(t.aligned_kr_id, '-kr-', 2)::INTEGER ELSE 0 END)
            -> 'taskEvaluations'
            ->> t.id), '')
        ELSE '' END AS card_evaluation
    ) card ON true
    WHERE t.target_weeks @> jsonb_build_array(p_week_id)
      AND (p_department_id IS NULL OR COALESCE(t.department_id, task_owner_user.department_id) = p_department_id)
      AND (
        public.is_admin()
        OR (public.is_employee() AND t.owner_id = public.current_user_id())
        OR (
          public.is_manager()
          AND public.current_user_has_department_visibility(COALESCE(t.department_id, task_owner_user.department_id))
        )
      )
  ), gaps AS (
    SELECT * FROM candidates WHERE btrim(card_evaluation) = '' OR NOT card_present
  ), grouped AS (
    SELECT user_id, name, role, department_id, department_name,
      jsonb_agg(jsonb_build_object('id', task_id, 'title', title, 'status', status,
        'department_id', task_department_id, 'department_name', task_department_name,
        'target_weeks', target_weeks,
        'reviewState', CASE WHEN NOT card_present THEN 'missing' ELSE 'blank' END,
        'taskReview', task_review, 'cardEvaluation', card_evaluation,
        'inconsistent', btrim(task_review) <> '' AND btrim(card_evaluation) = '') ORDER BY updated_at DESC, task_id DESC) AS tasks
    FROM gaps
    GROUP BY user_id, name, role, department_id, department_name
  ), page AS (
    SELECT jsonb_build_object('user', jsonb_build_object(
      'user_id', user_id, 'name', name, 'role', role, 'department_id', department_id, 'department_name', department_name),
      'tasks', tasks) AS item
    FROM grouped ORDER BY name OFFSET v_offset LIMIT v_limit
  )
  SELECT (SELECT count(*)::INTEGER FROM grouped), COALESCE((SELECT jsonb_agg(item) FROM page), '[]'::jsonb)
  INTO v_total, v_groups;
  RETURN jsonb_build_object('weekId', p_week_id, 'groups', COALESCE(v_groups, '[]'::jsonb),
    'total', v_total, 'limit', v_limit, 'offset', v_offset,
    'hasMore', v_offset + jsonb_array_length(COALESCE(v_groups, '[]'::jsonb)) < v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_resolve_users_by_name(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_query_user_tasks(TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_weekly_review_gaps(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_resolve_users_by_name(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_query_user_tasks(TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_weekly_review_gaps(TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

-- L2 rollback (manual, after exporting any operational evidence):
-- REVOKE EXECUTE ON FUNCTION public.mcp_resolve_users_by_name(TEXT, TEXT, TEXT) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION public.mcp_query_user_tasks(TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION public.mcp_get_weekly_review_gaps(TEXT, TEXT, INTEGER, INTEGER) FROM authenticated;
-- DROP FUNCTION public.mcp_resolve_users_by_name(TEXT, TEXT, TEXT);
-- DROP FUNCTION public.mcp_query_user_tasks(TEXT, TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, INTEGER, INTEGER);
-- DROP FUNCTION public.mcp_get_weekly_review_gaps(TEXT, TEXT, INTEGER, INTEGER);

COMMIT;
