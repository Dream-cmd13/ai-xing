-- Web review capability and atomic child-department review submission.
-- Additive only: no existing migration or business row is rewritten here.

BEGIN;

CREATE OR REPLACE FUNCTION public.web_get_department_review_capability(
  p_department_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_current_id TEXT := public.current_user_id();
  v_node RECORD;
  v_root_row_version BIGINT;
BEGIN
  IF v_current_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;
  IF p_department_id IS NULL OR btrim(p_department_id) = '' OR length(p_department_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 部门 ID 无效';
  END IF;

  SELECT * INTO v_node
  FROM public.mcp_department_tree_nodes() AS n
  WHERE n.node_id = btrim(p_department_id)
    AND public.mcp_current_user_can_see_department_node(n.node_id)
  ORDER BY n.depth, n.root_id
  LIMIT 1;
  IF v_node.node_id IS NULL THEN
    RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible';
  END IF;

  SELECT d.row_version INTO v_root_row_version
  FROM public.departments AS d
  WHERE d.id = v_node.root_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department root is missing';
  END IF;

  RETURN jsonb_build_object(
    'departmentId', v_node.node_id,
    'rootId', v_node.root_id,
    'nodePath', to_jsonb(v_node.node_path),
    'rowVersion', v_root_row_version,
    'canView', TRUE,
    'canEdit', public.current_user_can_edit_department_reviews(v_node.node_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.web_submit_department_review_scoped(
  p_department_id TEXT,
  p_period_key TEXT,
  p_entry JSONB,
  p_task_updates JSONB,
  p_expected_department_row_version BIGINT,
  p_request_id TEXT,
  p_department_root_id TEXT,
  p_department_node_path TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_id TEXT := public.current_user_id();
  v_node RECORD;
  v_root public.departments;
  v_node_value JSONB;
  v_node_reviews JSONB;
  v_new_sub_departments JSONB;
  v_normalized_entry JSONB;
  v_review_id TEXT;
  v_update JSONB;
  v_update_key TEXT;
  v_changes JSONB;
  v_change_key TEXT;
  v_task_id TEXT;
  v_review_key TEXT;
  v_kr_index INTEGER;
  v_expected_row_version BIGINT;
  v_old_task public.tasks;
  v_new_task public.tasks;
  v_slot_match TEXT[];
  v_expected_review_key TEXT;
  v_expected_kr_index INTEGER;
  v_okr_details JSONB;
  v_objective_review JSONB;
  v_kr_reviews JSONB;
  v_kr_review JSONB;
  v_next_task_review TEXT;
  v_next_task_score INTEGER;
  v_tasks JSONB := '[]'::JSONB;
  v_log_id BIGINT;
  v_prior_status TEXT;
  v_prior_result JSONB;
  v_result JSONB;
BEGIN
  IF v_current_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128
     OR p_department_id IS NULL OR btrim(p_department_id) = '' OR length(p_department_id) > 128
     OR p_department_root_id IS NULL OR btrim(p_department_root_id) = '' OR length(p_department_root_id) > 128
     OR p_department_node_path IS NULL OR cardinality(p_department_node_path) = 0
     OR p_expected_department_row_version IS NULL OR p_expected_department_row_version < 0
     OR p_period_key IS NULL
     OR (p_period_key !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
         AND p_period_key !~ '^\d{4}-M(0[1-9]|1[0-2])$'
         AND p_period_key !~ '^\d{4}-Q[1-4]$')
     OR p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object'
     OR p_task_updates IS NULL OR jsonb_typeof(p_task_updates) <> 'array'
     OR jsonb_array_length(p_task_updates) > 100 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 部门复盘提交参数无效';
  END IF;
  IF length(COALESCE(p_entry->>'content', '')) > 2000 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘总结长度不能超过 2000 个字符';
  END IF;
  IF p_entry ? 'score' AND (
    jsonb_typeof(p_entry->'score') <> 'number'
    OR (p_entry->>'score') !~ '^\d+$'
    OR (p_entry->>'score')::INTEGER NOT BETWEEN 0 AND 100
  ) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: score 必须是 0 到 100 的整数';
  END IF;
  IF p_entry ? 'okrDetails' AND jsonb_typeof(p_entry->'okrDetails') <> 'object' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: okrDetails 必须是对象';
  END IF;
  IF (
    SELECT count(*) <> count(DISTINCT update_value->>'id')
    FROM jsonb_array_elements(p_task_updates) AS updates(update_value)
  ) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: taskUpdates 不允许重复任务';
  END IF;

  SELECT * INTO v_node
  FROM public.mcp_department_tree_nodes() AS n
  WHERE n.node_id = btrim(p_department_id)
    AND public.mcp_current_user_can_see_department_node(n.node_id)
  ORDER BY n.depth, n.root_id
  LIMIT 1;
  IF v_node.node_id IS NULL THEN
    RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible';
  END IF;
  IF p_department_root_id IS DISTINCT FROM v_node.root_id
     OR p_department_node_path IS DISTINCT FROM v_node.node_path THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 部门根节点或节点路径与当前数据不一致';
  END IF;
  IF NOT public.current_user_can_edit_department_reviews(v_node.node_id) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限保存该部门复盘';
  END IF;

  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (v_current_id, 'web_submit_department_review', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
  RETURNING id INTO v_log_id;
  IF v_log_id IS NULL THEN
    SELECT status, result_summary INTO v_prior_status, v_prior_result
    FROM public.mcp_write_log
    WHERE user_id = v_current_id
      AND tool_name = 'web_submit_department_review'
      AND request_id = p_request_id;
    IF v_prior_status = 'success' THEN
      RETURN v_prior_result || jsonb_build_object('replayed', TRUE);
    END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;

  v_okr_details := COALESCE(p_entry->'okrDetails', '{}'::JSONB);

  -- Tasks are always locked in a stable order before the physical department root.
  FOR v_update IN
    SELECT update_value
    FROM jsonb_array_elements(p_task_updates) AS updates(update_value)
    ORDER BY update_value->>'id'
  LOOP
    IF jsonb_typeof(v_update) <> 'object'
       OR jsonb_typeof(v_update->'id') <> 'string'
       OR length(btrim(v_update->>'id')) = 0 OR length(v_update->>'id') > 128
       OR jsonb_typeof(v_update->'expectedRowVersion') <> 'number'
       OR (v_update->>'expectedRowVersion') !~ '^\d+$'
       OR length(v_update->>'expectedRowVersion') > 19
       OR jsonb_typeof(v_update->'reviewKey') <> 'string'
       OR length(btrim(v_update->>'reviewKey')) = 0 OR length(v_update->>'reviewKey') > 160
       OR jsonb_typeof(v_update->'krIndex') <> 'number'
       OR (v_update->>'krIndex') !~ '^\d+$'
       OR (v_update->>'krIndex')::INTEGER NOT BETWEEN 0 AND 100
       OR jsonb_typeof(v_update->'changes') <> 'object'
       OR v_update->'changes' = '{}'::JSONB THEN
      RAISE EXCEPTION 'MCP_VALIDATION: taskUpdates 项无效';
    END IF;
    IF (v_update->>'expectedRowVersion')::NUMERIC > 9223372036854775807 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: expectedRowVersion 超出 BIGINT 范围';
    END IF;
    FOR v_update_key IN SELECT jsonb_object_keys(v_update) LOOP
      IF v_update_key NOT IN ('id', 'expectedRowVersion', 'reviewKey', 'krIndex', 'changes') THEN
        RAISE EXCEPTION 'MCP_VALIDATION: taskUpdates 包含不允许的字段 %', v_update_key;
      END IF;
    END LOOP;

    v_task_id := btrim(v_update->>'id');
    v_expected_row_version := (v_update->>'expectedRowVersion')::BIGINT;
    v_review_key := v_update->>'reviewKey';
    v_kr_index := (v_update->>'krIndex')::INTEGER;
    v_changes := v_update->'changes';

    FOR v_change_key IN SELECT jsonb_object_keys(v_changes) LOOP
      IF v_change_key NOT IN ('deliverable', 'taskReview', 'taskReviewScore') THEN
        RAISE EXCEPTION 'MCP_VALIDATION: changes 包含不允许的字段 %', v_change_key;
      END IF;
    END LOOP;
    IF v_changes ? 'deliverable' AND (
      jsonb_typeof(v_changes->'deliverable') <> 'string'
      OR length(v_changes->>'deliverable') > 2000
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: deliverable 长度不能超过 2000 个字符';
    END IF;
    IF v_changes ? 'taskReview' AND (
      jsonb_typeof(v_changes->'taskReview') <> 'string'
      OR length(v_changes->>'taskReview') > 2000
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: taskReview 长度不能超过 2000 个字符';
    END IF;
    IF v_changes ? 'taskReviewScore' AND (
      jsonb_typeof(v_changes->'taskReviewScore') <> 'number'
      OR (v_changes->>'taskReviewScore') !~ '^\d+$'
      OR (v_changes->>'taskReviewScore')::INTEGER NOT BETWEEN 0 AND 100
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: taskReviewScore 必须是 0 到 100 的整数';
    END IF;

    SELECT * INTO v_old_task
    FROM public.tasks
    WHERE id = v_task_id
    FOR UPDATE;
    IF v_old_task.id IS NULL THEN
      RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 任务不存在或当前账号无权修改';
    END IF;
    IF v_old_task.department_id IS DISTINCT FROM p_department_id THEN
      RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 任务不属于目标部门';
    END IF;
    IF v_old_task.row_version <> v_expected_row_version THEN
      RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改';
    END IF;
    IF p_period_key !~ '^\d{4}-W' OR v_old_task.target_weeks IS NULL
       OR NOT (v_old_task.target_weeks @> jsonb_build_array(p_period_key)) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: periodKey 不是该任务的目标周次';
    END IF;
    IF v_changes ? 'deliverable' AND NOT (
      public.is_admin()
      OR (
        (public.has_menu_permission('task-center', 'update') OR public.has_menu_permission('execution', 'update'))
        AND public.current_user_can_manage_task(
          v_old_task.department_id,
          v_old_task.owner_id,
          v_old_task.participant_ids,
          v_old_task.approver_ids
        )
      )
    ) THEN
      RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限修改任务预期成果';
    END IF;

    IF COALESCE(v_old_task.aligned_kr_id, '') = '' THEN
      v_expected_review_key := '__task__:' || v_old_task.id;
      v_expected_kr_index := 0;
    ELSE
      v_slot_match := regexp_match(v_old_task.aligned_kr_id, '^(.+)-kr-([0-9]|[1-9][0-9]|100)$');
      IF v_slot_match IS NULL THEN
        RAISE EXCEPTION 'MCP_VALIDATION: 任务 alignedKrId 无效';
      END IF;
      v_expected_review_key := v_slot_match[1];
      v_expected_kr_index := v_slot_match[2]::INTEGER;
    END IF;
    IF v_review_key <> v_expected_review_key OR v_kr_index <> v_expected_kr_index THEN
      RAISE EXCEPTION 'MCP_VALIDATION: 复盘槽位与任务 alignedKrId 不匹配';
    END IF;

    IF v_changes ? 'taskReview' OR v_changes ? 'taskReviewScore' THEN
      v_objective_review := v_okr_details->v_review_key;
      IF jsonb_typeof(v_objective_review) <> 'object'
         OR jsonb_typeof(v_objective_review->'krReviews') <> 'array'
         OR jsonb_array_length(v_objective_review->'krReviews') <= v_kr_index THEN
        RAISE EXCEPTION 'MCP_VALIDATION: okrDetails 缺少任务复盘槽位';
      END IF;
      v_kr_reviews := v_objective_review->'krReviews';
      v_kr_review := v_kr_reviews->v_kr_index;
      IF jsonb_typeof(v_kr_review) <> 'object' THEN
        RAISE EXCEPTION 'MCP_VALIDATION: KR 复盘槽位无效';
      END IF;
      IF v_changes ? 'taskReview' AND (
        jsonb_typeof(v_kr_review->'taskEvaluations') <> 'object'
        OR NOT ((v_kr_review->'taskEvaluations') ? v_task_id)
        OR COALESCE(v_kr_review->'taskEvaluations'->>v_task_id, '') <> COALESCE(v_changes->>'taskReview', '')
      ) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: taskEvaluations 与任务实际成果不一致';
      END IF;
      IF v_changes ? 'taskReviewScore' AND (
        jsonb_typeof(v_kr_review->'taskScores') <> 'object'
        OR NOT ((v_kr_review->'taskScores') ? v_task_id)
        OR jsonb_typeof(v_kr_review->'taskScores'->v_task_id) <> 'number'
        OR (v_kr_review->'taskScores'->>v_task_id) !~ '^\d+$'
        OR (v_kr_review->'taskScores'->>v_task_id)::INTEGER <> (v_changes->>'taskReviewScore')::INTEGER
      ) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: taskScores 与任务得分不一致';
      END IF;
    END IF;

    v_next_task_review := CASE
      WHEN v_changes ? 'taskReview' THEN v_changes->>'taskReview'
      ELSE v_old_task.task_review
    END;
    v_next_task_score := CASE
      WHEN v_changes ? 'taskReviewScore' THEN (v_changes->>'taskReviewScore')::INTEGER
      ELSE v_old_task.task_review_score
    END;

    UPDATE public.tasks
    SET deliverable = CASE
          WHEN v_changes ? 'deliverable' THEN NULLIF(v_changes->>'deliverable', '')
          ELSE v_old_task.deliverable
        END,
        task_review = CASE
          WHEN v_changes ? 'taskReview' THEN NULLIF(v_next_task_review, '')
          ELSE v_old_task.task_review
        END,
        task_review_score = CASE
          WHEN v_changes ? 'taskReviewScore' THEN v_next_task_score
          ELSE v_old_task.task_review_score
        END,
        row_version = v_old_task.row_version + 1
    WHERE id = v_old_task.id
      AND row_version = v_expected_row_version
    RETURNING * INTO v_new_task;
    IF v_new_task.id IS NULL THEN
      RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改';
    END IF;
    v_tasks := v_tasks || jsonb_build_array(to_jsonb(v_new_task));
  END LOOP;

  -- The root is locked only after every task lock, matching all review writers.
  SELECT * INTO v_root FROM public.departments
  WHERE id = v_node.root_id
  FOR UPDATE;
  IF v_root.id IS NULL THEN
    RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department root is missing';
  END IF;
  IF v_root.row_version <> p_expected_department_row_version THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改';
  END IF;

  v_review_id := 'rev-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT
    || '-' || substr(md5(random()::TEXT || clock_timestamp()::TEXT || v_current_id), 1, 12);
  v_normalized_entry := jsonb_build_object(
    'id', v_review_id,
    'date', public.audit_now_ms(),
    'content', btrim(COALESCE(p_entry->>'content', '')),
    'score', COALESCE(NULLIF(p_entry->>'score', '')::INTEGER, 0),
    'reviewer', COALESCE((SELECT name FROM public.users WHERE id = v_current_id), v_current_id),
    'okrDetails', v_okr_details
  );

  IF cardinality(v_node.node_path) = 1 THEN
    v_node_reviews := jsonb_set(
      COALESCE(v_root.reviews, '{}'::JSONB),
      ARRAY[p_period_key],
      jsonb_build_array(v_normalized_entry),
      TRUE
    );
    UPDATE public.departments
    SET reviews = v_node_reviews,
        row_version = v_root.row_version + 1
    WHERE id = v_root.id AND row_version = p_expected_department_row_version;
  ELSE
    v_node_value := public.mcp_jsonb_find_department_node(
      COALESCE(v_root.sub_departments, '[]'::JSONB),
      v_node.node_id
    );
    IF v_node_value IS NULL THEN
      RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department node is missing';
    END IF;
    v_node_reviews := jsonb_set(
      COALESCE(v_node_value->'reviews', '{}'::JSONB),
      ARRAY[p_period_key],
      jsonb_build_array(v_normalized_entry),
      TRUE
    );
    v_new_sub_departments := public.mcp_jsonb_set_department_reviews(
      COALESCE(v_root.sub_departments, '[]'::JSONB),
      v_node.node_id,
      v_node_reviews
    );
    UPDATE public.departments
    SET sub_departments = v_new_sub_departments,
        row_version = v_root.row_version + 1
    WHERE id = v_root.id AND row_version = p_expected_department_row_version;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改';
  END IF;

  v_result := jsonb_build_object(
    'replayed', FALSE,
    'departmentId', v_node.node_id,
    'periodKey', p_period_key,
    'reviewEntry', v_normalized_entry,
    'tasks', v_tasks,
    'rootId', v_root.id,
    'rootRowVersion', v_root.row_version + 1
  );

  INSERT INTO public.mcp_audit_log (
    user_id, tool_name, request_id, action, object_type, object_id,
    status, before_summary, after_summary
  ) VALUES (
    v_current_id, 'web_submit_department_review', p_request_id,
    'save_review', 'department_review', v_node.node_id, 'success',
    jsonb_build_object(
      'departmentId', v_node.node_id,
      'rootId', v_root.id,
      'periodKey', p_period_key,
      'rowVersion', v_root.row_version
    ),
    jsonb_build_object(
      'departmentId', v_node.node_id,
      'rootId', v_root.id,
      'periodKey', p_period_key,
      'rowVersion', v_root.row_version + 1,
      'taskCount', jsonb_array_length(v_tasks),
      'reviewId', v_review_id
    )
  );
  UPDATE public.mcp_write_log
  SET status = 'success', result_summary = v_result, completed_at = public.audit_now_ms()
  WHERE id = v_log_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.web_get_department_review_capability(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.web_submit_department_review_scoped(TEXT, TEXT, JSONB, JSONB, BIGINT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.web_get_department_review_capability(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.web_submit_department_review_scoped(TEXT, TEXT, JSONB, JSONB, BIGINT, TEXT, TEXT, TEXT[]) TO authenticated;

COMMIT;
