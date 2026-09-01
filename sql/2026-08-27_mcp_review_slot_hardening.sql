-- MCP review-slot validation and bounded review synchronization.
-- Additive follow-up. Apply after 2026-08-26_mcp_p1_hardening.sql.
-- The historical implementation is retained behind a revoked implementation name;
-- authenticated callers can execute only the validating wrapper below.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_validate_task_aligned_kr_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_match TEXT[];
  v_index INTEGER;
BEGIN
  IF NEW.aligned_kr_id IS NULL OR btrim(NEW.aligned_kr_id) = '' THEN
    RETURN NEW;
  END IF;
  IF length(NEW.aligned_kr_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: aligned_kr_id 格式无效';
  END IF;
  v_match := regexp_match(NEW.aligned_kr_id, '^(.+)-kr-([0-9]+)$');
  IF v_match IS NULL OR btrim(v_match[1]) = '' OR length(v_match[2]) > 3 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: aligned_kr_id 格式无效';
  END IF;
  BEGIN
    v_index := v_match[2]::INTEGER;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'MCP_VALIDATION: KR 下标无效';
  END;
  IF v_index < 0 OR v_index > 100 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: KR 下标超出允许范围';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'mcp_validate_task_aligned_kr_id_trigger'
      AND tgrelid = 'public.tasks'::regclass
  ) THEN
    CREATE TRIGGER mcp_validate_task_aligned_kr_id_trigger
      BEFORE INSERT OR UPDATE OF aligned_kr_id ON public.tasks
      FOR EACH ROW EXECUTE FUNCTION public.mcp_validate_task_aligned_kr_id();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_validate_task_review_slot(
  p_task_id TEXT,
  p_period_key TEXT,
  p_review_key TEXT,
  p_kr_index INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.tasks;
  v_department public.departments;
  v_reviews JSONB;
  v_period_reviews JSONB;
  v_entry JSONB;
  v_okr_details JSONB;
  v_objective_review JSONB;
  v_kr_reviews JSONB;
  v_match TEXT[];
  v_expected_key TEXT;
  v_expected_index INTEGER;
  v_match_count INTEGER := 0;
  v_min_kr_count INTEGER;
  v_max_kr_count INTEGER;
  v_kr_count INTEGER := 0;
  v_period_year TEXT;
  v_period_quarter TEXT;
  v_period_week INTEGER;
BEGIN
  IF p_task_id IS NULL OR btrim(p_task_id) = ''
     OR p_period_key IS NULL OR p_period_key !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
     OR p_review_key IS NULL OR btrim(p_review_key) = ''
     OR p_kr_index IS NULL OR p_kr_index < 0 OR p_kr_index > 100 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'REVIEW_SLOT_INVALID');
  END IF;
  v_period_year := split_part(p_period_key, '-', 1);
  v_period_week := split_part(p_period_key, 'W', 2)::INTEGER;
  v_period_quarter := CASE
    WHEN v_period_week <= 13 THEN 'Q1'
    WHEN v_period_week <= 26 THEN 'Q2'
    WHEN v_period_week <= 39 THEN 'Q3'
    ELSE 'Q4'
  END;

  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TASK_NOT_FOUND');
  END IF;

  IF v_task.aligned_kr_id IS NULL OR btrim(v_task.aligned_kr_id) = '' THEN
    v_expected_key := '__task__:' || v_task.id;
    v_expected_index := 0;
  ELSE
    v_match := regexp_match(v_task.aligned_kr_id, '^(.+)-kr-([0-9]+)$');
    IF v_match IS NULL OR btrim(v_match[1]) = '' OR length(v_match[2]) > 3 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ALIGNED_KR_ID_INVALID');
    END IF;
    BEGIN
      v_expected_index := v_match[2]::INTEGER;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'KR_INDEX_OUT_OF_RANGE');
    END;
    v_expected_key := v_match[1];
    IF v_expected_index < 0 OR v_expected_index > 100 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'KR_INDEX_OUT_OF_RANGE');
    END IF;
  END IF;

  IF p_review_key <> v_expected_key OR p_kr_index <> v_expected_index THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'REVIEW_SLOT_MISMATCH');
  END IF;

  IF v_task.aligned_kr_id IS NOT NULL AND btrim(v_task.aligned_kr_id) <> '' THEN
    SELECT count(*)::INTEGER, min(kr_count)::INTEGER, max(kr_count)::INTEGER
      INTO v_match_count, v_min_kr_count, v_max_kr_count
    FROM (
      SELECT okr->>'id' AS objective_id,
        CASE WHEN jsonb_typeof(okr->'keyResults') = 'array'
          THEN jsonb_array_length(okr->'keyResults') ELSE 0 END AS kr_count
      FROM public.strategy AS s
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(s.company_okrs) = 'object' THEN s.company_okrs ELSE '{}'::JSONB END
      ) AS company_year(year_key, year_value)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(company_year.year_value) = 'array' THEN company_year.year_value ELSE '[]'::JSONB END
      ) AS company_okr(okr)
      CROSS JOIN LATERAL (SELECT company_okr.okr) AS company_row(okr)
      WHERE company_year.year_key = v_period_year
        AND company_row.okr->>'id' = v_expected_key
      UNION ALL
      SELECT okr->>'id' AS objective_id,
        CASE WHEN jsonb_typeof(okr->'keyResults') = 'array'
          THEN jsonb_array_length(okr->'keyResults') ELSE 0 END AS kr_count
      FROM public.departments AS d
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(d.okrs) = 'object' THEN d.okrs ELSE '{}'::JSONB END
      ) AS department_year(year_key, year_value)
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(department_year.year_value) = 'object' THEN department_year.year_value ELSE '{}'::JSONB END
      ) AS department_period(period_key, period_value)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(department_period.period_value) = 'array' THEN department_period.period_value ELSE '[]'::JSONB END
      ) AS department_okr(okr)
      CROSS JOIN LATERAL (SELECT department_okr.okr) AS department_row(okr)
      WHERE department_year.year_key = v_period_year
        AND department_period.period_key = v_period_quarter
        AND d.id = v_task.department_id
        AND department_row.okr->>'id' = v_expected_key
    ) AS matching_okrs;

    IF v_match_count = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'KR_NOT_FOUND');
    END IF;
    IF v_match_count <> 1 OR v_min_kr_count <> v_max_kr_count THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'KR_AMBIGUOUS');
    END IF;
    v_kr_count := COALESCE(v_max_kr_count, 0);
    IF v_kr_count > 101 OR v_expected_index >= v_kr_count THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'KR_INDEX_OUT_OF_RANGE', 'krCount', v_kr_count);
    END IF;
  END IF;

  SELECT * INTO v_department FROM public.departments WHERE id = v_task.department_id FOR UPDATE;
  IF v_department.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'DEPARTMENT_NOT_FOUND');
  END IF;
  v_reviews := COALESCE(v_department.reviews, '{}'::JSONB);
  IF jsonb_typeof(v_reviews) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'REVIEWS_FORMAT_INVALID');
  END IF;
  v_period_reviews := v_reviews -> p_period_key;
  IF jsonb_typeof(v_period_reviews) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'REVIEW_PERIOD_FORMAT_INVALID');
  END IF;
  IF jsonb_array_length(v_period_reviews) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'REVIEW_PERIOD_MISSING');
  END IF;
  v_entry := v_period_reviews -> (jsonb_array_length(v_period_reviews) - 1);
  IF jsonb_typeof(v_entry) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'REVIEW_ENTRY_FORMAT_INVALID');
  END IF;
  v_okr_details := v_entry -> 'okrDetails';
  IF v_okr_details IS NULL THEN
    v_okr_details := '{}'::JSONB;
  ELSIF jsonb_typeof(v_okr_details) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'OKR_DETAILS_FORMAT_INVALID');
  END IF;
  v_objective_review := v_okr_details -> p_review_key;
  IF v_objective_review IS NULL THEN
    v_objective_review := '{}'::JSONB;
  ELSIF jsonb_typeof(v_objective_review) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'OBJECTIVE_REVIEW_FORMAT_INVALID');
  END IF;
  v_kr_reviews := v_objective_review -> 'krReviews';
  IF v_kr_reviews IS NULL THEN
    v_kr_reviews := '[]'::JSONB;
  ELSIF jsonb_typeof(v_kr_reviews) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'KR_REVIEWS_FORMAT_INVALID');
  END IF;
  IF jsonb_array_length(v_kr_reviews) > 101
     OR (v_task.aligned_kr_id IS NOT NULL AND jsonb_array_length(v_kr_reviews) > v_kr_count) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'KR_REVIEWS_OUT_OF_RANGE', 'krCount', v_kr_count);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'reviewKey', v_expected_key, 'krIndex', v_expected_index,
    'krCount', v_kr_count, 'initialized', jsonb_array_length(v_kr_reviews) = 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_read_task_review_card(
  p_reviews JSONB,
  p_period_key TEXT,
  p_aligned_kr_id TEXT,
  p_task_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_period JSONB;
  v_entry JSONB;
  v_okr_details JSONB;
  v_objective_review JSONB;
  v_kr_reviews JSONB;
  v_kr_review JSONB;
  v_evaluations JSONB;
  v_value TEXT;
  v_key TEXT;
  v_index INTEGER;
  v_match TEXT[];
BEGIN
  IF p_period_key IS NULL OR p_period_key !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'REVIEW_PERIOD_INVALID', 'cardEvaluation', '');
  END IF;
  IF p_aligned_kr_id IS NULL OR btrim(p_aligned_kr_id) = '' THEN
    v_key := '__task__:' || COALESCE(p_task_id, 'unknown');
    v_index := 0;
  ELSE
    v_match := regexp_match(p_aligned_kr_id, '^(.+)-kr-([0-9]+)$');
    IF v_match IS NULL OR btrim(v_match[1]) = '' OR length(v_match[2]) > 3 THEN
      RETURN jsonb_build_object('state', 'invalid', 'reason', 'ALIGNED_KR_ID_INVALID', 'cardEvaluation', '');
    END IF;
    BEGIN
      v_index := v_match[2]::INTEGER;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('state', 'invalid', 'reason', 'KR_INDEX_OUT_OF_RANGE', 'cardEvaluation', '');
    END;
    IF v_index < 0 OR v_index > 100 THEN
      RETURN jsonb_build_object('state', 'invalid', 'reason', 'KR_INDEX_OUT_OF_RANGE', 'cardEvaluation', '');
    END IF;
    v_key := v_match[1];
  END IF;

  IF p_reviews IS NULL OR jsonb_typeof(p_reviews) <> 'object' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'REVIEWS_FORMAT_INVALID', 'cardEvaluation', '');
  END IF;
  v_period := p_reviews -> p_period_key;
  IF v_period IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'cardEvaluation', '');
  END IF;
  IF jsonb_typeof(v_period) <> 'array' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'REVIEW_PERIOD_FORMAT_INVALID', 'cardEvaluation', '');
  END IF;
  IF jsonb_array_length(v_period) = 0 THEN
    RETURN jsonb_build_object('state', 'missing', 'cardEvaluation', '');
  END IF;
  v_entry := v_period -> (jsonb_array_length(v_period) - 1);
  IF jsonb_typeof(v_entry) <> 'object' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'REVIEW_ENTRY_FORMAT_INVALID', 'cardEvaluation', '');
  END IF;
  v_okr_details := v_entry -> 'okrDetails';
  IF v_okr_details IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'cardEvaluation', '');
  END IF;
  IF jsonb_typeof(v_okr_details) <> 'object' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'OKR_DETAILS_FORMAT_INVALID', 'cardEvaluation', '');
  END IF;
  v_objective_review := v_okr_details -> v_key;
  IF v_objective_review IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'cardEvaluation', '');
  END IF;
  IF jsonb_typeof(v_objective_review) <> 'object' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'OBJECTIVE_REVIEW_FORMAT_INVALID', 'cardEvaluation', '');
  END IF;
  v_kr_reviews := v_objective_review -> 'krReviews';
  IF v_kr_reviews IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'cardEvaluation', '');
  END IF;
  IF jsonb_typeof(v_kr_reviews) <> 'array' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'KR_REVIEWS_FORMAT_INVALID', 'cardEvaluation', '');
  END IF;
  IF v_index >= jsonb_array_length(v_kr_reviews) THEN
    RETURN jsonb_build_object('state', 'missing', 'cardEvaluation', '');
  END IF;
  v_kr_review := v_kr_reviews -> v_index;
  IF jsonb_typeof(v_kr_review) <> 'object' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'KR_REVIEW_FORMAT_INVALID', 'cardEvaluation', '');
  END IF;
  v_evaluations := v_kr_review -> 'taskEvaluations';
  IF v_evaluations IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'cardEvaluation', '');
  END IF;
  IF jsonb_typeof(v_evaluations) <> 'object' THEN
    RETURN jsonb_build_object('state', 'invalid', 'reason', 'TASK_EVALUATIONS_FORMAT_INVALID', 'cardEvaluation', '');
  END IF;
  v_value := v_evaluations ->> p_task_id;
  IF v_value IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'cardEvaluation', '');
  END IF;
  IF btrim(v_value) = '' THEN
    RETURN jsonb_build_object('state', 'blank', 'cardEvaluation', '');
  END IF;
  RETURN jsonb_build_object('state', 'present', 'cardEvaluation', v_value);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_get_weekly_review_gaps(
  p_week_id TEXT,
  p_department_id TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_offset INTEGER := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 1000);
  v_groups JSONB;
  v_total INTEGER;
BEGIN
  IF p_week_id IS NULL OR p_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid week';
  END IF;
  WITH candidates AS (
    SELECT t.id AS task_id, t.title, t.status, t.updated_at,
      COALESCE(t.department_id, owner_user.department_id) AS task_department_id,
      task_department.name AS task_department_name,
      t.target_weeks, u.id AS user_id, u.name, u.role, u.department_id, owner_department.name AS department_name,
      COALESCE(t.task_review, '') AS task_review,
      card.state AS card_state,
      COALESCE(card.card_evaluation, '') AS card_evaluation,
      card.reason AS card_reason
    FROM public.tasks AS t
    JOIN public.users AS u ON u.id = t.owner_id
    LEFT JOIN public.users AS owner_user ON owner_user.id = t.owner_id
    LEFT JOIN public.departments AS task_department ON task_department.id = COALESCE(t.department_id, owner_user.department_id)
    LEFT JOIN public.departments AS owner_department ON owner_department.id = u.department_id
    LEFT JOIN LATERAL (
      SELECT
        card_value->>'state' AS state,
        card_value->>'cardEvaluation' AS card_evaluation,
        card_value->>'reason' AS reason
      FROM (
        SELECT public.mcp_read_task_review_card(
          task_department.reviews, p_week_id, t.aligned_kr_id, t.id
        ) AS card_value
      ) AS safe_card
    ) AS card ON true
    WHERE jsonb_typeof(t.target_weeks) = 'array'
      AND t.target_weeks @> jsonb_build_array(p_week_id)
      AND (p_department_id IS NULL OR COALESCE(t.department_id, owner_user.department_id) = p_department_id)
      AND (
        public.is_admin()
        OR (public.is_employee() AND t.owner_id = public.current_user_id())
        OR (public.is_manager() AND public.current_user_has_department_visibility(COALESCE(t.department_id, owner_user.department_id)))
      )
  ), gaps AS (
    SELECT * FROM candidates WHERE card_state IN ('missing', 'blank', 'invalid')
  ), grouped AS (
    SELECT user_id, name, role, department_id, department_name,
      jsonb_agg(jsonb_build_object(
        'id', task_id, 'title', title, 'status', status,
        'department_id', task_department_id, 'department_name', task_department_name,
        'target_weeks', target_weeks,
        'reviewState', card_state, 'reviewReason', card_reason,
        'taskReview', task_review, 'cardEvaluation', card_evaluation,
        'inconsistent', card_state = 'blank' AND btrim(task_review) <> ''
      ) ORDER BY updated_at DESC, task_id DESC) AS tasks
    FROM gaps
    GROUP BY user_id, name, role, department_id, department_name
  ), page AS (
    SELECT jsonb_build_object(
      'user', jsonb_build_object('user_id', user_id, 'name', name, 'role', role,
        'department_id', department_id, 'department_name', department_name),
      'tasks', tasks
    ) AS item
    FROM grouped ORDER BY name OFFSET v_offset LIMIT v_limit
  )
  SELECT (SELECT count(*)::INTEGER FROM grouped),
    COALESCE((SELECT jsonb_agg(item) FROM page), '[]'::JSONB)
  INTO v_total, v_groups;
  RETURN jsonb_build_object(
    'weekId', p_week_id, 'groups', COALESCE(v_groups, '[]'::JSONB),
    'total', v_total, 'limit', v_limit, 'offset', v_offset,
    'hasMore', v_offset + jsonb_array_length(COALESCE(v_groups, '[]'::JSONB)) < v_total
  );
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)') IS NOT NULL
     AND to_regprocedure('public.mcp_update_pad_task_with_review_sync_impl_20260827(text,jsonb,text,text,integer,bigint,bigint,text)') IS NULL THEN
    ALTER FUNCTION public.mcp_update_pad_task_with_review_sync(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT)
      RENAME TO mcp_update_pad_task_with_review_sync_impl_20260827;
  END IF;
  IF to_regprocedure('public.mcp_update_pad_task_with_review_sync_impl_20260827(text,jsonb,text,text,integer,bigint,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'MCP_VALIDATION: review-sync implementation is missing; apply the 2026-08-25 review-sync migration first';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_update_pad_task_with_review_sync(
  p_task_id TEXT,
  p_changes JSONB,
  p_review_period_key TEXT,
  p_review_key TEXT,
  p_kr_index INTEGER,
  p_expected_row_version BIGINT,
  p_expected_department_row_version BIGINT,
  p_request_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot JSONB;
  v_current_id TEXT;
  v_prior_result JSONB;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;

  v_current_id := public.current_user_id();
  IF v_current_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;

  SELECT result_summary INTO v_prior_result
  FROM public.mcp_write_log
  WHERE user_id = v_current_id
    AND tool_name = 'commit_update_pad_task'
    AND request_id = p_request_id
    AND status = 'success';
  IF FOUND THEN
    RETURN jsonb_build_object('replayed', true, 'result', v_prior_result);
  END IF;

  v_slot := public.mcp_validate_task_review_slot(
    p_task_id, p_review_period_key, p_review_key, p_kr_index
  );
  IF COALESCE((v_slot->>'ok')::BOOLEAN, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘数据或 KR 槽位无效（%）', COALESCE(v_slot->>'reason', 'REVIEW_SLOT_INVALID');
  END IF;
  RETURN public.mcp_update_pad_task_with_review_sync_impl_20260827(
    p_task_id, p_changes, p_review_period_key, p_review_key, p_kr_index,
    p_expected_row_version, p_expected_department_row_version, p_request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_validate_task_review_slot(TEXT, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_validate_task_aligned_kr_id()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_read_task_review_card(JSONB, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_weekly_review_gaps(TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_with_review_sync_impl_20260827(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_with_review_sync(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task_with_review_sync(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_weekly_review_gaps(TEXT, TEXT, INTEGER, INTEGER)
  TO authenticated;

COMMIT;
