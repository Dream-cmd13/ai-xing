-- MCP task defaults, safe people projection, and manager submit scope.
-- Test database only. Applying this migration requires explicit approval.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_get_task_people(p_task_ids TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  result JSONB;
BEGIN
  IF public.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;
  IF p_task_ids IS NULL THEN
    RAISE EXCEPTION 'MCP_VALIDATION: taskIds 必须是数组';
  END IF;
  IF cardinality(p_task_ids) > 50 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: taskIds 最多 50 项';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_task_ids) AS task_id(value)
    WHERE length(btrim(COALESCE(task_id.value, ''))) = 0 OR length(task_id.value) > 128
  ) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: taskIds 包含无效任务 ID';
  END IF;

  WITH visible_tasks AS (
    SELECT task_row.id, task_row.owner_id, task_row.participant_ids, task_row.approver_ids
    FROM public.tasks AS task_row
    WHERE task_row.id = ANY(p_task_ids)
      AND public.current_user_can_view_task(
        task_row.department_id,
        task_row.created_by,
        task_row.owner_id,
        task_row.participant_ids,
        task_row.approver_ids
      )
  ), task_people AS (
    SELECT jsonb_build_object(
      'task_id', visible_task.id,
      'owner', jsonb_build_object(
        'id', visible_task.owner_id,
        'name', owner_user.name,
        'department_id', owner_user.department_id,
        'department_name', owner_department.name
      ),
      'participants', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', participant.user_id,
          'name', participant_user.name,
          'department_id', participant_user.department_id,
          'department_name', participant_department.name
        ) ORDER BY participant.ordinality)
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(visible_task.participant_ids) = 'array'
            THEN visible_task.participant_ids ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS participant(user_id, ordinality)
        LEFT JOIN public.users AS participant_user ON participant_user.id = participant.user_id
        LEFT JOIN public.departments AS participant_department ON participant_department.id = participant_user.department_id
      ), '[]'::jsonb),
      'approvers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', approver.user_id,
          'name', approver_user.name,
          'department_id', approver_user.department_id,
          'department_name', approver_department.name
        ) ORDER BY approver.ordinality)
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(visible_task.approver_ids) = 'array'
            THEN visible_task.approver_ids ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS approver(user_id, ordinality)
        LEFT JOIN public.users AS approver_user ON approver_user.id = approver.user_id
        LEFT JOIN public.departments AS approver_department ON approver_department.id = approver_user.department_id
      ), '[]'::jsonb)
    ) AS item
    FROM visible_tasks AS visible_task
    LEFT JOIN public.users AS owner_user ON owner_user.id = visible_task.owner_id
    LEFT JOIN public.departments AS owner_department ON owner_department.id = owner_user.department_id
  )
  SELECT jsonb_build_object('tasks', COALESCE(jsonb_agg(item), '[]'::jsonb))
  INTO result
  FROM task_people;

  RETURN COALESCE(result, jsonb_build_object('tasks', '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_create_pad_task(
  p_task JSONB,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_id TEXT;
  current_department_id TEXT;
  department_id_value TEXT;
  owner_id_value TEXT;
  owner_department_id TEXT;
  task_row public.tasks;
  log_id BIGINT;
  prior_status TEXT;
  prior_result JSONB;
  result JSONB;
  task_id TEXT;
  key_name TEXT;
  item TEXT;
  value_text TEXT;
  start_value BIGINT;
  due_value BIGINT;
  task_input JSONB;
  shanghai_date DATE;
  default_week_id TEXT;
  default_monday DATE;
  default_start_ms BIGINT;
  default_due_ms BIGINT;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;
  IF p_task IS NULL OR jsonb_typeof(p_task) <> 'object' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务参数必须是对象';
  END IF;

  task_input := p_task;
  IF NOT (p_task ? 'target_weeks') AND NOT (p_task ? 'start_date') AND NOT (p_task ? 'due_date') THEN
    shanghai_date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::DATE;
    default_week_id := to_char(shanghai_date, 'IYYY-"W"IW');
    default_monday := date_trunc('week', shanghai_date::TIMESTAMP)::DATE;
    default_start_ms := floor(extract(epoch FROM ((default_monday::TIMESTAMP + TIME '12:00') AT TIME ZONE 'UTC')) * 1000)::BIGINT;
    default_due_ms := default_start_ms + 6 * 24 * 60 * 60 * 1000;
    task_input := task_input || jsonb_build_object(
      'target_weeks', jsonb_build_array(default_week_id),
      'start_date', default_start_ms,
      'due_date', default_due_ms
    );
  END IF;

  FOR key_name IN SELECT jsonb_object_keys(task_input)
  LOOP
    IF key_name NOT IN (
      'department_id', 'title', 'status', 'priority', 'owner_id', 'aligned_kr_id',
      'target_weeks', 'start_date', 'due_date', 'tags', 'participant_ids',
      'approver_ids', 'plan', 'action', 'deliverable'
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: 任务参数包含不允许的字段 %', key_name;
    END IF;
  END LOOP;
  IF COALESCE(length(btrim(task_input->>'title')), 0) = 0 OR length(task_input->>'title') > 200 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: title 必填且长度不能超过 200';
  END IF;
  IF COALESCE(task_input->>'status', 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 创建任务只能使用 draft 状态';
  END IF;
  IF task_input ? 'priority' AND COALESCE(task_input->>'priority', '') NOT IN ('high', 'medium', 'low') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: priority 无效';
  END IF;
  IF task_input ? 'target_weeks' THEN
    IF jsonb_typeof(task_input->'target_weeks') <> 'array' OR jsonb_array_length(task_input->'target_weeks') > 53 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 必须是最多 53 项的数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(task_input->'target_weeks')
    LOOP
      IF item !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
        RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 包含无效周次';
      END IF;
    END LOOP;
  END IF;
  FOREACH value_text IN ARRAY ARRAY['plan', 'action', 'deliverable']
  LOOP
    IF task_input ? value_text AND length(task_input->>value_text) > 2000 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: % 长度不能超过 2000', value_text;
    END IF;
  END LOOP;
  IF task_input ? 'tags' THEN
    IF jsonb_typeof(task_input->'tags') <> 'array' OR jsonb_array_length(task_input->'tags') > 12 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: tags 必须是最多 12 项的数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(task_input->'tags')
    LOOP
      IF length(item) > 32 THEN
        RAISE EXCEPTION 'MCP_VALIDATION: 单个 tag 长度不能超过 32';
      END IF;
    END LOOP;
  END IF;
  IF task_input ? 'participant_ids' THEN
    IF jsonb_typeof(task_input->'participant_ids') <> 'array' OR jsonb_array_length(task_input->'participant_ids') > 50 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: participant_ids 必须是最多 50 项的用户 ID 数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(task_input->'participant_ids')
    LOOP
      IF length(btrim(item)) = 0 OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = item) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: participant_ids 包含不存在的用户';
      END IF;
    END LOOP;
  END IF;
  IF task_input ? 'approver_ids' THEN
    IF jsonb_typeof(task_input->'approver_ids') <> 'array' OR jsonb_array_length(task_input->'approver_ids') > 20 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: approver_ids 必须是最多 20 项的用户 ID 数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(task_input->'approver_ids')
    LOOP
      IF length(btrim(item)) = 0 OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = item) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: approver_ids 包含不存在的用户';
      END IF;
    END LOOP;
  END IF;
  IF task_input ? 'start_date' AND task_input->>'start_date' IS NOT NULL THEN
    IF task_input->>'start_date' !~ '^\d+$' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: start_date 必须是时间戳';
    END IF;
    start_value := (task_input->>'start_date')::BIGINT;
  END IF;
  IF task_input ? 'due_date' AND task_input->>'due_date' IS NOT NULL THEN
    IF task_input->>'due_date' !~ '^\d+$' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: due_date 必须是时间戳';
    END IF;
    due_value := (task_input->>'due_date')::BIGINT;
  END IF;
  IF start_value IS NOT NULL AND due_value IS NOT NULL AND due_value < start_value THEN
    RAISE EXCEPTION 'MCP_VALIDATION: due_date 不能早于 start_date';
  END IF;
  current_id := public.current_user_id();
  current_department_id := public.current_user_department_id();

  IF current_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;

  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (current_id, 'commit_create_pad_task', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
  RETURNING id INTO log_id;

  IF log_id IS NULL THEN
    SELECT status, result_summary INTO prior_status, prior_result
    FROM public.mcp_write_log
    WHERE user_id = current_id AND tool_name = 'commit_create_pad_task' AND request_id = p_request_id;
    IF prior_status = 'success' THEN
      RETURN jsonb_build_object('replayed', true, 'result', prior_result);
    END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;

  department_id_value := COALESCE(NULLIF(task_input->>'department_id', ''), current_department_id);
  owner_id_value := COALESCE(NULLIF(task_input->>'owner_id', ''), current_id);

  IF department_id_value IS NULL OR (NOT public.is_admin() AND current_department_id IS NULL) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法确定任务所属部门';
  END IF;

  SELECT department_id INTO owner_department_id
  FROM public.users WHERE id = owner_id_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_VALIDATION: owner_id 不存在';
  END IF;

  IF NOT public.is_admin() AND department_id_value <> current_department_id THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 非管理员只能在本人部门创建任务';
  END IF;
  IF NOT public.is_admin() AND public.is_employee() AND owner_id_value <> current_id THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: Employee 只能将本人设为负责人';
  END IF;
  IF NOT public.is_admin() AND public.is_manager() AND owner_department_id <> current_department_id THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: Manager 只能指定本人部门成员为负责人';
  END IF;
  IF NOT (
    public.is_admin()
    OR public.has_menu_permission('task-center', 'create')
    OR public.has_menu_permission('execution', 'create')
    OR (public.is_manager() AND public.is_department_manager(department_id_value))
    OR (owner_id_value = current_id AND department_id_value = current_department_id)
  ) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限创建任务';
  END IF;

  task_id := 'task-mcp-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT
    || '-' || substr(md5(random()::TEXT || clock_timestamp()::TEXT || current_id), 1, 12);

  INSERT INTO public.tasks (
    id, department_id, created_by, title, status, priority, owner_id,
    aligned_kr_id, target_weeks, start_date, due_date, tags,
    participant_ids, approver_ids, plan, action, deliverable, row_version
  )
  VALUES (
    task_id,
    department_id_value,
    current_id,
    btrim(task_input->>'title'),
    'draft',
    COALESCE(NULLIF(task_input->>'priority', ''), 'medium'),
    owner_id_value,
    NULLIF(task_input->>'aligned_kr_id', ''),
    COALESCE(task_input->'target_weeks', '[]'::jsonb),
    NULLIF(task_input->>'start_date', '')::BIGINT,
    NULLIF(task_input->>'due_date', '')::BIGINT,
    COALESCE(task_input->'tags', '[]'::jsonb),
    COALESCE(task_input->'participant_ids', '[]'::jsonb),
    COALESCE(task_input->'approver_ids', '[]'::jsonb),
    NULLIF(task_input->>'plan', ''),
    NULLIF(task_input->>'action', ''),
    NULLIF(task_input->>'deliverable', ''),
    0
  )
  RETURNING * INTO task_row;

  result := jsonb_build_object(
    'replayed', false,
    'task', jsonb_build_object(
      'id', task_row.id, 'createdBy', task_row.created_by, 'title', task_row.title,
      'status', task_row.status, 'priority', task_row.priority, 'ownerId', task_row.owner_id,
      'departmentId', task_row.department_id, 'alignedKrId', task_row.aligned_kr_id,
      'targetWeeks', COALESCE(task_row.target_weeks, '[]'::jsonb),
      'startDate', task_row.start_date, 'dueDate', task_row.due_date,
      'tags', COALESCE(task_row.tags, '[]'::jsonb),
      'participantIds', COALESCE(task_row.participant_ids, '[]'::jsonb),
      'approverIds', COALESCE(task_row.approver_ids, '[]'::jsonb),
      'logs', COALESCE(task_row.logs, '[]'::jsonb), 'plan', task_row.plan,
      'action', task_row.action, 'deliverable', task_row.deliverable,
      'taskReview', task_row.task_review, 'taskReviewScore', task_row.task_review_score,
      'updatedAt', task_row.updated_at, 'rowVersion', task_row.row_version
    ),
    'rowVersion', task_row.row_version
  );

  INSERT INTO public.mcp_audit_log (
    user_id, tool_name, request_id, action, object_type, object_id,
    status, after_summary
  )
  VALUES (
    current_id, 'commit_create_pad_task', p_request_id, 'create', 'task', task_row.id,
    'success', jsonb_build_object(
      'id', task_row.id, 'title', task_row.title, 'status', task_row.status,
      'ownerId', task_row.owner_id, 'departmentId', task_row.department_id,
      'rowVersion', task_row.row_version
    )
  );

  UPDATE public.mcp_write_log
  SET status = 'success', result_summary = result, completed_at = public.audit_now_ms()
  WHERE id = log_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_submit_pad_task(
  p_task_id TEXT,
  p_expected_row_version BIGINT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_id TEXT;
  owner_department_id TEXT;
  old_task public.tasks;
  new_task public.tasks;
  log_id BIGINT;
  prior_status TEXT;
  prior_result JSONB;
  result JSONB;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;
  IF p_task_id IS NULL OR p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: taskId 和 expectedRowVersion 无效';
  END IF;
  current_id := public.current_user_id();

  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (current_id, 'submit_pad_task', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
  RETURNING id INTO log_id;
  IF log_id IS NULL THEN
    SELECT status, result_summary INTO prior_status, prior_result
    FROM public.mcp_write_log
    WHERE user_id = current_id AND tool_name = 'submit_pad_task' AND request_id = p_request_id;
    IF prior_status = 'success' THEN
      RETURN jsonb_build_object('replayed', true, 'result', prior_result);
    END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;

  SELECT * INTO old_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF old_task.id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 任务不存在或当前账号无权提交';
  END IF;
  SELECT department_id INTO owner_department_id FROM public.users WHERE id = old_task.owner_id;
  IF NOT (
    public.is_admin()
    OR (
      public.is_manager()
      AND old_task.created_by = current_id
      AND old_task.department_id = public.current_user_department_id()
      AND owner_department_id = public.current_user_department_id()
    )
    OR (
      (public.has_menu_permission('task-center', 'update') OR public.has_menu_permission('execution', 'update'))
      AND public.current_user_can_manage_task(
        old_task.department_id, old_task.owner_id, old_task.participant_ids, old_task.approver_ids
      )
    )
  ) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限提交任务';
  END IF;
  IF old_task.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改';
  END IF;
  IF old_task.status NOT IN ('draft', 'in-progress', 'paused') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 当前状态不允许提交';
  END IF;

  UPDATE public.tasks
  SET status = 'submitted', row_version = old_task.row_version + 1
  WHERE id = old_task.id AND row_version = p_expected_row_version
  RETURNING * INTO new_task;
  IF new_task.id IS NULL THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改';
  END IF;

  result := jsonb_build_object(
    'replayed', false,
    'task', jsonb_build_object(
      'id', new_task.id, 'createdBy', new_task.created_by, 'title', new_task.title,
      'status', new_task.status, 'priority', new_task.priority, 'ownerId', new_task.owner_id,
      'departmentId', new_task.department_id, 'alignedKrId', new_task.aligned_kr_id,
      'targetWeeks', COALESCE(new_task.target_weeks, '[]'::jsonb),
      'startDate', new_task.start_date, 'dueDate', new_task.due_date,
      'tags', COALESCE(new_task.tags, '[]'::jsonb),
      'participantIds', COALESCE(new_task.participant_ids, '[]'::jsonb),
      'approverIds', COALESCE(new_task.approver_ids, '[]'::jsonb),
      'logs', COALESCE(new_task.logs, '[]'::jsonb), 'plan', new_task.plan,
      'action', new_task.action, 'deliverable', new_task.deliverable,
      'taskReview', new_task.task_review, 'taskReviewScore', new_task.task_review_score,
      'updatedAt', new_task.updated_at, 'rowVersion', new_task.row_version
    ),
    'rowVersion', new_task.row_version,
    'approverIds', COALESCE(new_task.approver_ids, '[]'::jsonb)
  );
  INSERT INTO public.mcp_audit_log (
    user_id, tool_name, request_id, action, object_type, object_id,
    status, before_summary, after_summary
  )
  VALUES (
    current_id, 'submit_pad_task', p_request_id, 'submit', 'task', old_task.id,
    'success',
    jsonb_build_object('id', old_task.id, 'status', old_task.status, 'rowVersion', old_task.row_version),
    jsonb_build_object('id', new_task.id, 'status', new_task.status, 'rowVersion', new_task.row_version)
  );
  UPDATE public.mcp_write_log
  SET status = 'success', result_summary = result, completed_at = public.audit_now_ms()
  WHERE id = log_id;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_get_task_people(TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_create_pad_task(JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_submit_pad_task(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.mcp_get_task_people(TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_create_pad_task(JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_submit_pad_task(TEXT, BIGINT, TEXT) TO authenticated;

COMMIT;

