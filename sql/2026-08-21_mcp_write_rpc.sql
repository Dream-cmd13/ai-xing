-- Phase 2: transactional MCP writes.
-- All business writes below run with the caller's authenticated identity
-- resolved through the existing public security helpers. No service-role key
-- or database password is used by the MCP process.

BEGIN;

CREATE OR REPLACE FUNCTION public.current_user_can_edit_department_reviews(
  p_department_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_id TEXT;
  current_department_id TEXT;
  target_node JSONB;
BEGIN
  IF NOT public.current_user_can_save_departments() THEN
    RETURN false;
  END IF;

  current_id := public.current_user_id();
  current_department_id := public.current_user_department_id();

  IF current_id IS NULL OR p_department_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.is_admin() THEN
    RETURN true;
  END IF;

  SELECT jsonb_build_object(
    'id', d.id,
    'managerUserId', d.manager_user_id,
    'subDepartments', COALESCE(d.sub_departments, '[]'::jsonb)
  )
  INTO target_node
  FROM public.departments AS d
  WHERE d.id = p_department_id;

  IF target_node IS NULL THEN
    RETURN false;
  END IF;

  RETURN public.current_user_can_manage_department_tree(target_node, current_id)
    OR p_department_id = current_department_id
    OR public.find_department_in_tree(
      COALESCE(target_node->'subDepartments', '[]'::jsonb),
      current_department_id
    ) IS NOT NULL;
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
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;
  IF p_task IS NULL OR jsonb_typeof(p_task) <> 'object' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务参数必须是对象';
  END IF;
  FOR key_name IN SELECT jsonb_object_keys(p_task)
  LOOP
    IF key_name NOT IN (
      'department_id', 'title', 'status', 'priority', 'owner_id', 'aligned_kr_id',
      'target_weeks', 'start_date', 'due_date', 'tags', 'participant_ids',
      'approver_ids', 'plan', 'action', 'deliverable'
    ) THEN
      RAISE EXCEPTION 'MCP_VALIDATION: 任务参数包含不允许的字段 %', key_name;
    END IF;
  END LOOP;
  IF COALESCE(length(btrim(p_task->>'title')), 0) = 0 OR length(p_task->>'title') > 200 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: title 必填且长度不能超过 200';
  END IF;
  IF COALESCE(p_task->>'status', 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 创建任务只能使用 draft 状态';
  END IF;
  IF p_task ? 'priority' AND COALESCE(p_task->>'priority', '') NOT IN ('high', 'medium', 'low') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: priority 无效';
  END IF;
  IF p_task ? 'target_weeks' THEN
    IF jsonb_typeof(p_task->'target_weeks') <> 'array' OR jsonb_array_length(p_task->'target_weeks') > 53 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 必须是最多 53 项的数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(p_task->'target_weeks')
    LOOP
      IF item !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
        RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 包含无效周次';
      END IF;
    END LOOP;
  END IF;
  FOREACH value_text IN ARRAY ARRAY['plan', 'action', 'deliverable']
  LOOP
    IF p_task ? value_text AND length(p_task->>value_text) > 2000 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: % 长度不能超过 2000', value_text;
    END IF;
  END LOOP;
  IF p_task ? 'tags' THEN
    IF jsonb_typeof(p_task->'tags') <> 'array' OR jsonb_array_length(p_task->'tags') > 12 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: tags 必须是最多 12 项的数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(p_task->'tags')
    LOOP
      IF length(item) > 32 THEN
        RAISE EXCEPTION 'MCP_VALIDATION: 单个 tag 长度不能超过 32';
      END IF;
    END LOOP;
  END IF;
  IF p_task ? 'participant_ids' THEN
    IF jsonb_typeof(p_task->'participant_ids') <> 'array' OR jsonb_array_length(p_task->'participant_ids') > 50 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: participant_ids 必须是最多 50 项的用户 ID 数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(p_task->'participant_ids')
    LOOP
      IF length(btrim(item)) = 0 OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = item) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: participant_ids 包含不存在的用户';
      END IF;
    END LOOP;
  END IF;
  IF p_task ? 'approver_ids' THEN
    IF jsonb_typeof(p_task->'approver_ids') <> 'array' OR jsonb_array_length(p_task->'approver_ids') > 20 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: approver_ids 必须是最多 20 项的用户 ID 数组';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements_text(p_task->'approver_ids')
    LOOP
      IF length(btrim(item)) = 0 OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = item) THEN
        RAISE EXCEPTION 'MCP_VALIDATION: approver_ids 包含不存在的用户';
      END IF;
    END LOOP;
  END IF;
  IF p_task ? 'start_date' AND p_task->>'start_date' IS NOT NULL THEN
    IF p_task->>'start_date' !~ '^\d+$' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: start_date 必须是时间戳';
    END IF;
    start_value := (p_task->>'start_date')::BIGINT;
  END IF;
  IF p_task ? 'due_date' AND p_task->>'due_date' IS NOT NULL THEN
    IF p_task->>'due_date' !~ '^\d+$' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: due_date 必须是时间戳';
    END IF;
    due_value := (p_task->>'due_date')::BIGINT;
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

  department_id_value := COALESCE(NULLIF(p_task->>'department_id', ''), current_department_id);
  owner_id_value := COALESCE(NULLIF(p_task->>'owner_id', ''), current_id);

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
    btrim(p_task->>'title'),
    'draft',
    COALESCE(NULLIF(p_task->>'priority', ''), 'medium'),
    owner_id_value,
    NULLIF(p_task->>'aligned_kr_id', ''),
    COALESCE(p_task->'target_weeks', '[]'::jsonb),
    NULLIF(p_task->>'start_date', '')::BIGINT,
    NULLIF(p_task->>'due_date', '')::BIGINT,
    COALESCE(p_task->'tags', '[]'::jsonb),
    COALESCE(p_task->'participant_ids', '[]'::jsonb),
    COALESCE(p_task->'approver_ids', '[]'::jsonb),
    NULLIF(p_task->>'plan', ''),
    NULLIF(p_task->>'action', ''),
    NULLIF(p_task->>'deliverable', ''),
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

CREATE OR REPLACE FUNCTION public.mcp_update_pad_task(
  p_task_id TEXT,
  p_changes JSONB,
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
  old_task public.tasks;
  new_task public.tasks;
  log_id BIGINT;
  prior_status TEXT;
  prior_result JSONB;
  result JSONB;
  key_name TEXT;
  allowed BOOLEAN;
  owner_department_id TEXT;
  item TEXT;
  value_text TEXT;
  start_value BIGINT;
  due_value BIGINT;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;
  IF p_task_id IS NULL OR length(btrim(p_task_id)) = 0 OR p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: taskId 和 expectedRowVersion 无效';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::jsonb THEN
    RAISE EXCEPTION 'MCP_VALIDATION: changes 不能为空';
  END IF;
  IF p_changes ? 'department_id' OR p_changes ? 'departmentId' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: MCP 不允许移动任务所属部门';
  END IF;
  current_id := public.current_user_id();

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

  SELECT * INTO old_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF old_task.id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 任务不存在或当前账号无权修改';
  END IF;
  IF NOT (
    public.is_admin()
    OR (
      (public.has_menu_permission('task-center', 'update') OR public.has_menu_permission('execution', 'update'))
      AND public.current_user_can_manage_task(
        old_task.department_id, old_task.owner_id, old_task.participant_ids, old_task.approver_ids
      )
    )
  ) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限修改任务';
  END IF;
  IF old_task.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改';
  END IF;

  FOR key_name IN SELECT jsonb_object_keys(p_changes)
  LOOP
    allowed := key_name IN (
      'title', 'status', 'priority', 'aligned_kr_id', 'target_weeks',
      'start_date', 'due_date', 'tags', 'participant_ids', 'approver_ids',
      'plan', 'action', 'deliverable', 'task_review', 'task_review_score', 'owner_id'
    );
    IF NOT allowed THEN
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

  UPDATE public.tasks
  SET
    title = CASE WHEN p_changes ? 'title' THEN btrim(p_changes->>'title') ELSE old_task.title END,
    status = CASE WHEN p_changes ? 'status' THEN p_changes->>'status' ELSE old_task.status END,
    priority = CASE WHEN p_changes ? 'priority' THEN p_changes->>'priority' ELSE old_task.priority END,
    owner_id = CASE WHEN p_changes ? 'owner_id' THEN p_changes->>'owner_id' ELSE old_task.owner_id END,
    aligned_kr_id = CASE WHEN p_changes ? 'aligned_kr_id' THEN NULLIF(p_changes->>'aligned_kr_id', '') ELSE old_task.aligned_kr_id END,
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
    task_review_score = CASE WHEN p_changes ? 'task_review_score' THEN (p_changes->>'task_review_score')::INTEGER ELSE old_task.task_review_score END,
    row_version = old_task.row_version + 1
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
    'rowVersion', new_task.row_version
  );
  INSERT INTO public.mcp_audit_log (
    user_id, tool_name, request_id, action, object_type, object_id,
    status, before_summary, after_summary
  )
  VALUES (
    current_id, 'commit_update_pad_task', p_request_id, 'update', 'task', old_task.id,
    'success',
    jsonb_build_object('id', old_task.id, 'title', old_task.title, 'status', old_task.status, 'rowVersion', old_task.row_version),
    jsonb_build_object('id', new_task.id, 'title', new_task.title, 'status', new_task.status, 'rowVersion', new_task.row_version)
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
  IF NOT (
    public.is_admin()
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

CREATE OR REPLACE FUNCTION public.mcp_save_review_record(
  p_department_id TEXT,
  p_period_key TEXT,
  p_entry JSONB,
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
  reviewer_name TEXT;
  department_row public.departments;
  entry JSONB;
  review_id TEXT;
  log_id BIGINT;
  prior_status TEXT;
  prior_result JSONB;
  result JSONB;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;
  IF p_department_id IS NULL OR p_period_key IS NULL
     OR p_period_key !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
     AND p_period_key !~ '^\d{4}-(0[1-9]|1[0-2])$'
     AND p_period_key !~ '^\d{4}-Q[1-4]$' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: periodKey 无效';
  END IF;
  IF p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘内容必须是对象';
  END IF;
  IF COALESCE(length(btrim(p_entry->>'content')), 0) = 0 OR length(p_entry->>'content') > 2000 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: content 必填且长度不能超过 2000';
  END IF;
  IF p_entry ? 'score'
     AND ((p_entry->>'score') !~ '^\d+$'
       OR (p_entry->>'score')::INTEGER < 0
       OR (p_entry->>'score')::INTEGER > 100) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: score 必须在 0 到 100 之间';
  END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: expectedRowVersion 无效';
  END IF;

  current_id := public.current_user_id();
  IF current_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;

  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (current_id, 'save_review_record', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
  RETURNING id INTO log_id;
  IF log_id IS NULL THEN
    SELECT status, result_summary INTO prior_status, prior_result
    FROM public.mcp_write_log
    WHERE user_id = current_id AND tool_name = 'save_review_record' AND request_id = p_request_id;
    IF prior_status = 'success' THEN
      RETURN jsonb_build_object('replayed', true, 'result', prior_result);
    END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;

  SELECT * INTO department_row
  FROM public.departments
  WHERE id = p_department_id
  FOR UPDATE;
  IF department_row.id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 部门不存在或当前账号无权查看';
  END IF;
  IF NOT public.current_user_can_edit_department_reviews(p_department_id) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限保存该部门复盘';
  END IF;
  IF department_row.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改';
  END IF;

  SELECT name INTO reviewer_name FROM public.users WHERE id = current_id;
  review_id := 'rev-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT
    || '-' || substr(md5(random()::TEXT || clock_timestamp()::TEXT || current_id), 1, 12);
  entry := jsonb_build_object(
    'id', review_id,
    'date', public.audit_now_ms(),
    'content', btrim(p_entry->>'content'),
    'score', COALESCE(NULLIF(p_entry->>'score', '')::INTEGER, 0),
    'reviewer', COALESCE(reviewer_name, current_id),
    'okrDetails', CASE
      WHEN jsonb_typeof(p_entry->'okrDetails') = 'object' THEN p_entry->'okrDetails'
      ELSE '{}'::jsonb
    END
  );

  UPDATE public.departments
  SET reviews = jsonb_set(
      COALESCE(department_row.reviews, '{}'::jsonb),
      ARRAY[p_period_key],
      jsonb_build_array(entry),
      true
    ),
    row_version = department_row.row_version + 1
  WHERE id = p_department_id AND row_version = p_expected_row_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改';
  END IF;

  result := jsonb_build_object(
    'replayed', false,
    'departmentId', p_department_id,
    'periodKey', p_period_key,
    'reviewId', review_id,
    'rowVersion', department_row.row_version + 1
  );
  INSERT INTO public.mcp_audit_log (
    user_id, tool_name, request_id, action, object_type, object_id,
    status, before_summary, after_summary
  )
  VALUES (
    current_id, 'save_review_record', p_request_id, 'save_review', 'department_review', p_department_id,
    'success',
    jsonb_build_object('departmentId', p_department_id, 'periodKey', p_period_key, 'rowVersion', department_row.row_version),
    jsonb_build_object('departmentId', p_department_id, 'periodKey', p_period_key, 'reviewId', review_id, 'rowVersion', department_row.row_version + 1)
  );
  UPDATE public.mcp_write_log
  SET status = 'success', result_summary = result, completed_at = public.audit_now_ms()
  WHERE id = log_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_record_failed_write(
  p_tool_name TEXT,
  p_request_id TEXT,
  p_action TEXT,
  p_object_type TEXT,
  p_object_id TEXT,
  p_error_code TEXT,
  p_before_summary JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_id TEXT;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;
  current_id := public.current_user_id();
  IF current_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;
  IF p_action NOT IN ('create', 'update', 'submit', 'save_review')
     OR p_object_type NOT IN ('task', 'department_review')
     OR p_object_id IS NULL OR length(p_object_id) = 0
     OR p_error_code IS NULL OR length(p_error_code) > 64 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 失败审计参数无效';
  END IF;

  INSERT INTO public.mcp_audit_log (
    user_id, tool_name, request_id, action, object_type, object_id,
    status, error_code, before_summary
  )
  VALUES (
    current_id, p_tool_name, p_request_id, p_action, p_object_type, p_object_id,
    'failed', p_error_code, p_before_summary
  );
END;
$$;

REVOKE ALL ON FUNCTION public.current_user_can_edit_department_reviews(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_create_pad_task(JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task(TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_submit_pad_task(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_save_review_record(TEXT, TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_record_failed_write(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.mcp_create_pad_task(JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task(TEXT, JSONB, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_submit_pad_task(TEXT, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_save_review_record(TEXT, TEXT, JSONB, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_record_failed_write(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;

COMMIT;
