-- Follow-up fix: atomically synchronize task review fields and the review-center card.
-- Additive only. This migration does not alter existing RLS policies, triggers, or website RPCs.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_update_pad_task_with_review_sync(
  p_task_id TEXT,
  p_changes JSONB,
  p_review_period_key TEXT,
  p_review_key TEXT,
  p_kr_index INTEGER,
  p_expected_row_version BIGINT,
  p_expected_department_row_version BIGINT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_id TEXT;
  old_task public.tasks;
  new_task public.tasks;
  department_row public.departments;
  log_id BIGINT;
  prior_status TEXT;
  prior_result JSONB;
  result JSONB;
  key_name TEXT;
  item TEXT;
  value_text TEXT;
  start_value BIGINT;
  due_value BIGINT;
  owner_department_id TEXT;
  expected_review_key TEXT;
  expected_kr_index INTEGER;
  separator_index INTEGER;
  period_reviews JSONB;
  latest_index INTEGER;
  old_entry JSONB;
  new_entry JSONB;
  old_okr_details JSONB;
  old_objective_review JSONB;
  kr_reviews JSONB;
  old_kr_review JSONB;
  task_evaluations JSONB;
  task_scores JSONB;
  new_kr_review JSONB;
  new_objective_review JSONB;
  new_okr_details JSONB;
  new_period_reviews JSONB;
  new_reviews JSONB;
  old_evaluation TEXT;
  old_score INTEGER;
  next_evaluation TEXT;
  next_score INTEGER;
  review_only BOOLEAN;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;
  IF p_task_id IS NULL OR length(btrim(p_task_id)) = 0
     OR p_review_period_key IS NULL
     OR p_review_period_key !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
     OR p_review_key IS NULL OR length(btrim(p_review_key)) = 0
     OR p_kr_index IS NULL OR p_kr_index < 0 OR p_kr_index > 100
     OR p_expected_row_version IS NULL OR p_expected_row_version < 0
     OR p_expected_department_row_version IS NULL OR p_expected_department_row_version < 0 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘同步参数无效';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::jsonb THEN
    RAISE EXCEPTION 'MCP_VALIDATION: changes 不能为空';
  END IF;
  IF NOT (p_changes ? 'task_review' OR p_changes ? 'task_review_score') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘同步必须包含 task_review 或 task_review_score';
  END IF;
  IF p_changes ? 'department_id' OR p_changes ? 'departmentId' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: MCP 不允许移动任务所属部门';
  END IF;
  IF p_changes ? 'aligned_kr_id' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 更新复盘时不能同时修改 aligned_kr_id，请重新预览';
  END IF;
  review_only := (p_changes - 'task_review' - 'task_review_score') = '{}'::jsonb;

  current_id := public.current_user_id();
  IF current_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;

  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (current_id, 'commit_update_pad_task', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
  RETURNING id INTO log_id;
  IF log_id IS NULL THEN
    SELECT status, result_summary INTO prior_status, prior_result
    FROM public.mcp_write_log
    WHERE user_id = current_id AND tool_name = 'commit_update_pad_task' AND request_id = p_request_id;
    IF prior_status = 'success' THEN
      RETURN jsonb_build_object('replayed', true, 'result', prior_result);
    END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;

  -- Lock order is task then department, matching this RPC's validation order.
  SELECT * INTO old_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF old_task.id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 任务不存在或当前账号无权修改';
  END IF;
  IF NOT (
    public.is_admin()
    OR (
      (
        (
          review_only
          AND public.has_menu_permission('okr-review', 'update')
        )
        OR (
          NOT review_only
          AND (
            public.has_menu_permission('task-center', 'update')
            OR public.has_menu_permission('execution', 'update')
          )
          AND public.current_user_can_manage_task(
            old_task.department_id, old_task.owner_id, old_task.participant_ids, old_task.approver_ids
          )
        )
      )
      AND public.current_user_can_edit_department_reviews(old_task.department_id)
    )
  ) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限修改任务或目标部门复盘';
  END IF;
  IF old_task.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改';
  END IF;

  SELECT * INTO department_row
  FROM public.departments
  WHERE id = old_task.department_id
  FOR UPDATE;
  IF department_row.id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 任务所属部门不存在或当前账号无权查看';
  END IF;
  IF department_row.row_version <> p_expected_department_row_version THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改';
  END IF;
  IF old_task.target_weeks IS NULL
     OR NOT (old_task.target_weeks @> jsonb_build_array(p_review_period_key)) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: reviewPeriodKey 不是该任务的目标周次';
  END IF;

  separator_index := strpos(COALESCE(old_task.aligned_kr_id, ''), '-kr-');
  IF separator_index > 0 THEN
    expected_review_key := substr(old_task.aligned_kr_id, 1, separator_index - 1);
    BEGIN
      expected_kr_index := substr(old_task.aligned_kr_id, separator_index + 4)::INTEGER;
    EXCEPTION WHEN invalid_text_representation THEN
      expected_kr_index := -1;
    END;
  ELSE
    expected_review_key := '__task__:' || old_task.id;
    expected_kr_index := 0;
  END IF;
  IF p_review_key <> expected_review_key OR p_kr_index <> expected_kr_index THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘槽位与任务的 aligned_kr_id 不匹配';
  END IF;

  FOR key_name IN SELECT jsonb_object_keys(p_changes)
  LOOP
    IF key_name NOT IN (
      'title', 'status', 'priority', 'target_weeks',
      'start_date', 'due_date', 'tags', 'participant_ids', 'approver_ids',
      'plan', 'action', 'deliverable', 'task_review', 'task_review_score', 'owner_id'
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: changes 包含不允许的字段 %', key_name;
    END IF;
  END LOOP;
  IF p_changes ? 'title'
     AND (COALESCE(length(btrim(p_changes->>'title')), 0) = 0 OR length(p_changes->>'title') > 200) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: title 必填且长度不能超过 200';
  END IF;
  IF p_changes ? 'status' AND p_changes->>'status' = 'submitted' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 提交任务必须使用 submit_pad_task';
  END IF;
  IF p_changes ? 'status'
     AND p_changes->>'status' NOT IN ('draft', 'in-progress', 'paused', 'approved', 'completed', 'terminated') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: status 无效';
  END IF;
  IF p_changes ? 'priority' AND COALESCE(p_changes->>'priority', '') NOT IN ('high', 'medium', 'low') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: priority 无效';
  END IF;
  IF p_changes ? 'target_weeks' THEN
    IF jsonb_typeof(p_changes->'target_weeks') <> 'array' OR jsonb_array_length(p_changes->'target_weeks') > 53 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 必须是最多 53 项的数组';
    END IF;
    IF NOT (p_changes->'target_weeks' @> jsonb_build_array(p_review_period_key)) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: 更新后 target_weeks 必须保留 reviewPeriodKey';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(p_changes->'target_weeks')
    LOOP
      IF item !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
        RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 包含无效周次';
      END IF;
    END LOOP;
  END IF;
  FOREACH value_text IN ARRAY ARRAY['plan', 'action', 'deliverable', 'task_review']
  LOOP
    IF p_changes ? value_text AND length(p_changes->>value_text) > 2000 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: % 长度不能超过 2000', value_text;
    END IF;
  END LOOP;
  IF p_changes ? 'task_review_score'
     AND ((p_changes->>'task_review_score') !~ '^\d+$'
       OR (p_changes->>'task_review_score')::INTEGER < 0
       OR (p_changes->>'task_review_score')::INTEGER > 100) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: task_review_score 必须在 0 到 100 之间';
  END IF;
  IF p_changes ? 'tags' THEN
    IF jsonb_typeof(p_changes->'tags') <> 'array' OR jsonb_array_length(p_changes->'tags') > 12 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: tags 必须是最多 12 项的数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(p_changes->'tags')
    LOOP
      IF length(item) > 32 THEN
        RAISE EXCEPTION 'MCP_VALIDATION: 单个 tag 长度不能超过 32';
      END IF;
    END LOOP;
  END IF;
  IF p_changes ? 'participant_ids' THEN
    IF jsonb_typeof(p_changes->'participant_ids') <> 'array' OR jsonb_array_length(p_changes->'participant_ids') > 50 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: participant_ids 必须是最多 50 项的用户 ID 数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(p_changes->'participant_ids')
    LOOP
      IF length(btrim(item)) = 0 OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = item) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: participant_ids 包含不存在的用户';
      END IF;
    END LOOP;
  END IF;
  IF p_changes ? 'approver_ids' THEN
    IF jsonb_typeof(p_changes->'approver_ids') <> 'array' OR jsonb_array_length(p_changes->'approver_ids') > 20 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: approver_ids 必须是最多 20 项的用户 ID 数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(p_changes->'approver_ids')
    LOOP
      IF length(btrim(item)) = 0 OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = item) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: approver_ids 包含不存在的用户';
      END IF;
    END LOOP;
  END IF;
  start_value := old_task.start_date;
  due_value := old_task.due_date;
  IF p_changes ? 'start_date' THEN
    IF p_changes->>'start_date' IS NOT NULL AND p_changes->>'start_date' !~ '^\d+$' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: start_date 必须是时间戳';
    END IF;
    start_value := NULLIF(p_changes->>'start_date', '')::BIGINT;
  END IF;
  IF p_changes ? 'due_date' THEN
    IF p_changes->>'due_date' IS NOT NULL AND p_changes->>'due_date' !~ '^\d+$' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: due_date 必须是时间戳';
    END IF;
    due_value := NULLIF(p_changes->>'due_date', '')::BIGINT;
  END IF;
  IF start_value IS NOT NULL AND due_value IS NOT NULL AND due_value < start_value THEN
    RAISE EXCEPTION 'MCP_VALIDATION: due_date 不能早于 start_date';
  END IF;
  IF p_changes ? 'owner_id' THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 非管理员不能修改任务负责人';
    END IF;
    SELECT department_id INTO owner_department_id FROM public.users WHERE id = p_changes->>'owner_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MCP_VALIDATION: owner_id 不存在';
    END IF;
  END IF;

  period_reviews := COALESCE(department_row.reviews, '{}'::jsonb) -> p_review_period_key;
  IF jsonb_typeof(period_reviews) <> 'array' OR jsonb_array_length(period_reviews) = 0 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 目标复盘周期不存在，请先保存该周期复盘记录';
  END IF;
  latest_index := jsonb_array_length(period_reviews) - 1;
  old_entry := COALESCE(period_reviews -> latest_index, '{}'::jsonb);
  old_okr_details := CASE WHEN jsonb_typeof(old_entry->'okrDetails') = 'object' THEN old_entry->'okrDetails' ELSE '{}'::jsonb END;
  old_objective_review := CASE WHEN jsonb_typeof(old_okr_details->p_review_key) = 'object' THEN old_okr_details->p_review_key ELSE '{}'::jsonb END;
  kr_reviews := CASE WHEN jsonb_typeof(old_objective_review->'krReviews') = 'array' THEN old_objective_review->'krReviews' ELSE '[]'::jsonb END;
  IF jsonb_array_length(kr_reviews) <= p_kr_index THEN
    SELECT kr_reviews || jsonb_agg(
      jsonb_build_object('comment', '', 'progress', 0, 'status', 'on-track') ORDER BY slot_index
    )
    INTO kr_reviews
    FROM generate_series(jsonb_array_length(kr_reviews), p_kr_index) AS slot_index;
  END IF;
  old_kr_review := COALESCE(kr_reviews -> p_kr_index, '{}'::jsonb);
  task_evaluations := CASE
    WHEN jsonb_typeof(old_kr_review->'taskEvaluations') = 'object' THEN old_kr_review->'taskEvaluations'
    ELSE '{}'::jsonb
  END;
  task_scores := CASE
    WHEN jsonb_typeof(old_kr_review->'taskScores') = 'object' THEN old_kr_review->'taskScores'
    ELSE '{}'::jsonb
  END;
  old_evaluation := COALESCE(old_kr_review->'taskEvaluations'->>old_task.id, old_task.task_review, '');
  IF COALESCE(old_kr_review->'taskScores'->>old_task.id, '') ~ '^\d+$' THEN
    old_score := (old_kr_review->'taskScores'->>old_task.id)::INTEGER;
  ELSE
    old_score := COALESCE(old_task.task_review_score, 0);
  END IF;
  next_evaluation := CASE WHEN p_changes ? 'task_review' THEN COALESCE(p_changes->>'task_review', '') ELSE COALESCE(old_task.task_review, '') END;
  next_score := CASE WHEN p_changes ? 'task_review_score' THEN (p_changes->>'task_review_score')::INTEGER ELSE COALESCE(old_task.task_review_score, 0) END;

  UPDATE public.tasks
  SET
    title = CASE WHEN p_changes ? 'title' THEN btrim(p_changes->>'title') ELSE old_task.title END,
    status = CASE WHEN p_changes ? 'status' THEN p_changes->>'status' ELSE old_task.status END,
    priority = CASE WHEN p_changes ? 'priority' THEN p_changes->>'priority' ELSE old_task.priority END,
    owner_id = CASE WHEN p_changes ? 'owner_id' THEN p_changes->>'owner_id' ELSE old_task.owner_id END,
    target_weeks = CASE WHEN p_changes ? 'target_weeks' THEN p_changes->'target_weeks' ELSE old_task.target_weeks END,
    start_date = CASE WHEN p_changes ? 'start_date' THEN NULLIF(p_changes->>'start_date', '')::BIGINT ELSE old_task.start_date END,
    due_date = CASE WHEN p_changes ? 'due_date' THEN NULLIF(p_changes->>'due_date', '')::BIGINT ELSE old_task.due_date END,
    tags = CASE WHEN p_changes ? 'tags' THEN p_changes->'tags' ELSE old_task.tags END,
    participant_ids = CASE WHEN p_changes ? 'participant_ids' THEN p_changes->'participant_ids' ELSE old_task.participant_ids END,
    approver_ids = CASE WHEN p_changes ? 'approver_ids' THEN p_changes->'approver_ids' ELSE old_task.approver_ids END,
    plan = CASE WHEN p_changes ? 'plan' THEN NULLIF(p_changes->>'plan', '') ELSE old_task.plan END,
    action = CASE WHEN p_changes ? 'action' THEN NULLIF(p_changes->>'action', '') ELSE old_task.action END,
    deliverable = CASE WHEN p_changes ? 'deliverable' THEN NULLIF(p_changes->>'deliverable', '') ELSE old_task.deliverable END,
    task_review = CASE WHEN p_changes ? 'task_review' THEN NULLIF(p_changes->>'task_review', '') ELSE old_task.task_review END,
    task_review_score = CASE WHEN p_changes ? 'task_review_score' THEN next_score ELSE old_task.task_review_score END,
    row_version = old_task.row_version + 1
  WHERE id = old_task.id AND row_version = p_expected_row_version
  RETURNING * INTO new_task;
  IF new_task.id IS NULL THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改';
  END IF;

  new_kr_review := jsonb_set(COALESCE(old_kr_review, '{}'::jsonb), ARRAY['taskEvaluations'], jsonb_set(task_evaluations, ARRAY[old_task.id], to_jsonb(next_evaluation), true), true);
  new_kr_review := jsonb_set(new_kr_review, ARRAY['taskScores'], jsonb_set(task_scores, ARRAY[old_task.id], to_jsonb(next_score), true), true);
  new_objective_review := jsonb_set(COALESCE(old_objective_review, '{}'::jsonb), ARRAY['krReviews'], jsonb_set(kr_reviews, ARRAY[p_kr_index::TEXT], new_kr_review, true), true);
  new_okr_details := jsonb_set(old_okr_details, ARRAY[p_review_key], new_objective_review, true);
  new_entry := jsonb_set(old_entry, ARRAY['okrDetails'], new_okr_details, true);
  new_period_reviews := jsonb_set(period_reviews, ARRAY[latest_index::TEXT], new_entry, true);
  new_reviews := jsonb_set(COALESCE(department_row.reviews, '{}'::jsonb), ARRAY[p_review_period_key], new_period_reviews, true);

  UPDATE public.departments
  SET reviews = new_reviews,
      row_version = department_row.row_version + 1
  WHERE id = department_row.id AND row_version = p_expected_department_row_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改';
  END IF;

  result := jsonb_build_object(
    'replayed', false,
    'task', jsonb_build_object(
      'id', new_task.id, 'title', new_task.title, 'status', new_task.status,
      'ownerId', new_task.owner_id, 'departmentId', new_task.department_id,
      'taskReview', new_task.task_review, 'taskReviewScore', new_task.task_review_score,
      'rowVersion', new_task.row_version
    ),
    'reviewSync', jsonb_build_object(
      'departmentId', department_row.id, 'periodKey', p_review_period_key,
      'reviewKey', p_review_key, 'krIndex', p_kr_index,
      'evaluation', next_evaluation, 'score', next_score,
      'rowVersion', department_row.row_version + 1
    ),
    'rowVersion', new_task.row_version,
    'departmentRowVersion', department_row.row_version + 1
  );
  INSERT INTO public.mcp_audit_log (
    user_id, tool_name, request_id, action, object_type, object_id,
    status, before_summary, after_summary
  )
  VALUES (
    current_id, 'commit_update_pad_task', p_request_id, 'update', 'task', old_task.id,
    'success',
    jsonb_build_object(
      'task', jsonb_build_object('id', old_task.id, 'taskReview', old_task.task_review, 'taskReviewScore', old_task.task_review_score, 'rowVersion', old_task.row_version),
      'departmentReview', jsonb_build_object('departmentId', department_row.id, 'periodKey', p_review_period_key, 'reviewKey', p_review_key, 'krIndex', p_kr_index, 'evaluation', old_evaluation, 'score', old_score, 'rowVersion', department_row.row_version)
    ),
    jsonb_build_object(
      'task', jsonb_build_object('id', new_task.id, 'taskReview', new_task.task_review, 'taskReviewScore', new_task.task_review_score, 'rowVersion', new_task.row_version),
      'departmentReview', jsonb_build_object('departmentId', department_row.id, 'periodKey', p_review_period_key, 'reviewKey', p_review_key, 'krIndex', p_kr_index, 'evaluation', next_evaluation, 'score', next_score, 'rowVersion', department_row.row_version + 1)
    )
  );
  UPDATE public.mcp_write_log
  SET status = 'success', result_summary = result, completed_at = public.audit_now_ms()
  WHERE id = log_id;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_update_pad_task_with_review_sync(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task_with_review_sync(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT)
  TO authenticated;

COMMIT;
