-- Fix the empty KR text fallback exposed once bound tasks are visible.
-- COALESCE(jsonb_value, '') attempts to cast an empty text value to JSONB and
-- raises 22P02. Keep the attachment path bounded and return a JSON string.
BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_attach_tasks_to_okrs(
  p_okrs JSONB,
  p_department_name_map JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_slots TEXT[];
  v_okr JSONB;
  v_okr_record RECORD;
  v_okr_id TEXT;
  v_kr_index INTEGER;
  v_kr_count INTEGER;
  v_result JSONB := '[]'::JSONB;
  v_entry JSONB;
  v_kr_tasks JSONB;
  v_slot TEXT;
  v_task_rows RECORD;
  v_task JSONB;
  v_task_lists JSONB := '{}'::JSONB;
  v_truncated_map JSONB := '{}'::JSONB;
  v_count INTEGER;
BEGIN
  IF p_okrs IS NULL OR jsonb_typeof(p_okrs) <> 'array' OR jsonb_array_length(p_okrs) = 0 THEN
    RETURN COALESCE(p_okrs, '[]'::JSONB);
  END IF;

  FOR v_okr IN SELECT value FROM jsonb_array_elements(p_okrs) LOOP
    v_okr_id := v_okr->>'id';
    IF v_okr_id IS NULL OR v_okr_id = '' THEN CONTINUE; END IF;
    v_kr_count := CASE
      WHEN v_okr->'keyResults' IS NOT NULL AND jsonb_typeof(v_okr->'keyResults') = 'array'
      THEN jsonb_array_length(v_okr->'keyResults') ELSE 0 END;
    FOR v_kr_index IN SELECT generate_series(0, LEAST(v_kr_count, 20) - 1) LOOP
      v_slots := array_append(v_slots, v_okr_id || '-kr-' || v_kr_index);
    END LOOP;
  END LOOP;

  IF array_length(v_slots, 1) IS NOT NULL THEN
    FOR v_task_rows IN
      SELECT t.id, t.title, t.status, t.owner_id, t.department_id,
        t.aligned_kr_id, t.target_weeks, t.start_date, t.due_date, t.updated_at,
        owner_user.name AS owner_name,
        COALESCE(tree_names.department_name, dept_row.name) AS department_name
      FROM public.tasks t
      LEFT JOIN public.users owner_user ON owner_user.id = t.owner_id
      LEFT JOIN public.departments dept_row ON dept_row.id = t.department_id
      LEFT JOIN LATERAL (
        SELECT (p_department_name_map->>t.department_id) AS department_name
      ) tree_names ON true
      WHERE t.aligned_kr_id = ANY(v_slots)
        AND public.current_user_can_view_task(
          t.department_id, t.created_by, t.owner_id, t.participant_ids, t.approver_ids
        )
      ORDER BY t.updated_at DESC, t.id DESC
    LOOP
      v_task := jsonb_build_object(
        'id', v_task_rows.id,
        'title', v_task_rows.title,
        'status', v_task_rows.status,
        'ownerId', v_task_rows.owner_id,
        'ownerName', v_task_rows.owner_name,
        'departmentId', v_task_rows.department_id,
        'departmentName', v_task_rows.department_name,
        'targetWeeks', COALESCE(v_task_rows.target_weeks, '[]'::JSONB),
        'startDate', v_task_rows.start_date,
        'dueDate', v_task_rows.due_date
      );
      v_count := CASE
        WHEN v_task_lists ? v_task_rows.aligned_kr_id
        THEN jsonb_array_length(v_task_lists->v_task_rows.aligned_kr_id) ELSE 0 END;
      IF v_count < 20 THEN
        v_task_lists := v_task_lists
          || jsonb_build_object(v_task_rows.aligned_kr_id, COALESCE(v_task_lists->v_task_rows.aligned_kr_id, '[]'::JSONB) || jsonb_build_array(v_task));
      ELSE
        v_truncated_map := v_truncated_map || jsonb_build_object(v_task_rows.aligned_kr_id, true);
      END IF;
    END LOOP;
  END IF;

  FOR v_okr_record IN
    SELECT value AS entry, ordinality
    FROM jsonb_array_elements(p_okrs) WITH ORDINALITY AS t(value, ordinality)
  LOOP
    v_entry := v_okr_record.entry;
    v_okr_id := v_entry->>'id';
    IF v_okr_id IS NULL OR v_okr_id = '' THEN
      v_result := v_result || jsonb_build_array(v_entry);
      CONTINUE;
    END IF;
    v_kr_tasks := '[]'::JSONB;
    v_kr_count := COALESCE((v_entry->>'krCount')::INTEGER, 0);
    FOR v_kr_index IN SELECT generate_series(0, LEAST(v_kr_count, 20) - 1) LOOP
      v_slot := v_okr_id || '-kr-' || v_kr_index;
      IF v_task_lists ? v_slot THEN
        v_kr_tasks := v_kr_tasks || jsonb_build_object(
          'krIndex', v_kr_index,
          'krText', COALESCE(v_entry->'keyResults'->v_kr_index, to_jsonb(''::TEXT)),
          'taskCount', jsonb_array_length(v_task_lists->v_slot),
          'tasks', v_task_lists->v_slot,
          'tasksTruncated', COALESCE((v_truncated_map->>v_slot)::BOOLEAN, false)
        );
      END IF;
    END LOOP;
    v_result := v_result || jsonb_build_array(v_entry || jsonb_build_object('krTasks', v_kr_tasks));
  END LOOP;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_attach_tasks_to_okrs(JSONB, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
