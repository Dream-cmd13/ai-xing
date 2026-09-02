-- MCP OKR read-only queries: company annual OKRs and department annual/quarterly
-- OKRs, each KR optionally carrying the tasks bound via tasks.aligned_kr_id
-- (exact value "<okrId>-kr-<krIndex>"). Additive only: no table or policy change.
BEGIN;

-- ---------------------------------------------------------------------------
-- Shared helper: recursively walk a department subtree node and return every
-- visible department entry carrying its projected OKR periods.
-- p_node: department JSON object (top-level row shape or subDepartments child).
-- p_year: target year. p_period: NULL = all periods of the year.
-- Returns: [{id, name, managerName, parentName, periods}]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mcp_collect_department_okr_nodes(
  p_node JSONB,
  p_year INTEGER,
  p_period TEXT,
  p_parent_name TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_result JSONB := '[]'::JSONB;
  v_child JSONB;
  v_okrs JSONB;
  v_year_okrs JSONB;
  v_periods JSONB := '{}'::JSONB;
  v_period_key TEXT;
  v_period_value JSONB;
  v_okr_list JSONB;
  v_okr JSONB;
  v_okr_id TEXT;
  v_kr_count INTEGER;
  v_entry JSONB;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node) <> 'object' THEN
    RETURN '[]'::JSONB;
  END IF;

  IF public.current_user_has_department_visibility(p_node->>'id') THEN
    v_okrs := p_node->'okrs';
    IF v_okrs IS NOT NULL AND jsonb_typeof(v_okrs) = 'object' THEN
      -- 年份键兼容字符串与数字两种历史形态。
      v_year_okrs := COALESCE(v_okrs->p_year::TEXT, v_okrs->(to_jsonb(p_year)::TEXT));
      IF v_year_okrs IS NOT NULL AND jsonb_typeof(v_year_okrs) = 'object' THEN
        FOR v_period_key, v_period_value IN SELECT * FROM jsonb_each(v_year_okrs) LOOP
          IF (p_period IS NULL OR v_period_key = p_period)
            AND jsonb_typeof(v_period_value) = 'array'
            AND jsonb_array_length(v_period_value) > 0 THEN
            v_okr_list := '[]'::JSONB;
            FOR v_okr IN SELECT value FROM jsonb_array_elements(v_period_value) LOOP
              IF v_okr IS NULL OR jsonb_typeof(v_okr) <> 'object' THEN CONTINUE; END IF;
              v_okr_id := v_okr->>'id';
              v_kr_count := CASE
                WHEN v_okr->'keyResults' IS NOT NULL AND jsonb_typeof(v_okr->'keyResults') = 'array'
                THEN jsonb_array_length(v_okr->'keyResults') ELSE 0 END;
              v_entry := jsonb_build_object(
                'id', v_okr_id,
                'objective', COALESCE(v_okr->>'objective', ''),
                'keyResults', CASE
                  WHEN v_okr->'keyResults' IS NOT NULL AND jsonb_typeof(v_okr->'keyResults') = 'array'
                  THEN v_okr->'keyResults' ELSE '[]'::JSONB END,
                'krCount', v_kr_count,
                'truncated', v_kr_count > 20
              );
              IF v_kr_count > 20 THEN
                v_entry := v_entry || jsonb_build_object(
                  'keyResults',
                  (SELECT jsonb_agg(value ORDER BY ordinality)
                   FROM jsonb_array_elements(v_okr->'keyResults') WITH ORDINALITY AS t(value, ordinality)
                   WHERE ordinality <= 20)
                );
              END IF;
              v_okr_list := v_okr_list || jsonb_build_array(v_entry);
            END LOOP;
            IF jsonb_array_length(v_okr_list) > 0 THEN
              v_periods := v_periods || jsonb_build_object(v_period_key, v_okr_list);
            END IF;
          END IF;
        END LOOP;
      END IF;
    END IF;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'id', p_node->>'id',
      'name', COALESCE(p_node->>'name', ''),
      'managerName', COALESCE(p_node->>'managerName', ''),
      'parentName', p_parent_name,
      'periods', v_periods
    ));
  END IF;

  FOR v_child IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_node->'subDepartments', '[]'::JSONB))
  LOOP
    v_result := v_result || public.mcp_collect_department_okr_nodes(
      v_child, p_year, p_period, COALESCE(p_node->>'name', '')
    );
  END LOOP;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Shared helper: find a department node (top-level row or nested child) by id.
-- Returns the node JSONB, or NULL when not found in any visible tree row.
-- The caller checks visibility separately for nested nodes because the node
-- itself is only reachable through rows the RLS already filtered.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mcp_find_department_node(
  p_node JSONB,
  p_target_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_child JSONB;
  v_found JSONB;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node) <> 'object' OR p_target_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_node->>'id' = p_target_id THEN
    RETURN p_node;
  END IF;
  FOR v_child IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_node->'subDepartments', '[]'::JSONB))
  LOOP
    v_found := public.mcp_find_department_node(v_child, p_target_id);
    IF v_found IS NOT NULL THEN
      RETURN v_found;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Shared helper: attach bound tasks to a list of OKR entries.
-- p_okrs: JSONB array of OKR objects (each must carry id + keyResults).
-- Builds slot strings "<okrId>-kr-<krIndex>" and fetches visible tasks bound to
-- them in a single scan, grouping results under each OKR's "krTasks".
-- ---------------------------------------------------------------------------
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

  -- 收集所有槽位：okrId-kr-krIndex。
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
    -- 单次反查可见任务（SECURITY DEFINER 下须显式调用可见性谓词）。
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

  -- 把任务按槽位挂回 OKR。
  FOR v_okr IN SELECT value, ordinality FROM jsonb_array_elements(p_okrs) WITH ORDINALITY AS t(value, ordinality) LOOP
    v_entry := v_okr->'value';
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
          'krText', COALESCE(v_entry->'keyResults'->v_kr_index, ''),
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

-- ---------------------------------------------------------------------------
-- Public RPC: company annual OKRs (optionally with bound tasks).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mcp_get_company_okrs(
  p_year INTEGER DEFAULT NULL,
  p_include_tasks BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
DECLARE
  v_year INTEGER := COALESCE(p_year, (EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Shanghai')))::INTEGER);
  v_company_okrs JSONB;
  v_year_okrs JSONB;
  v_okrs JSONB;
BEGIN
  IF v_year < 2000 OR v_year > 3000 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid year';
  END IF;

  SELECT company_okrs INTO v_company_okrs
  FROM public.strategy
  WHERE id = 'default';

  IF v_company_okrs IS NULL OR jsonb_typeof(v_company_okrs) <> 'object' THEN
    v_year_okrs := NULL;
  ELSE
    v_year_okrs := COALESCE(v_company_okrs->v_year::TEXT, v_company_okrs->(to_jsonb(v_year)::TEXT));
  END IF;

  IF v_year_okrs IS NULL OR jsonb_typeof(v_year_okrs) <> 'array' THEN
    v_okrs := '[]'::JSONB;
  ELSE
    SELECT COALESCE(jsonb_agg(value ORDER BY ordinality), '[]'::JSONB)
    INTO v_okrs
    FROM jsonb_array_elements(v_year_okrs) WITH ORDINALITY AS t(value, ordinality);
  END IF;

  -- 统一投影结构并应用条目上限。
  v_okrs := public.mcp_normalize_okr_entries(v_okrs);

  IF COALESCE(p_include_tasks, TRUE) THEN
    v_okrs := public.mcp_attach_tasks_to_okrs(v_okrs);
  END IF;

  RETURN jsonb_build_object(
    'year', v_year,
    'okrCount', jsonb_array_length(v_okrs),
    'okrs', v_okrs
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Internal helper: normalize raw OKR entries to the projected shape with caps.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mcp_normalize_okr_entries(
  p_okrs JSONB
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_result JSONB := '[]'::JSONB;
  v_okr JSONB;
  v_kr_count INTEGER;
  v_entry JSONB;
  v_count INTEGER := 0;
BEGIN
  IF p_okrs IS NULL OR jsonb_typeof(p_okrs) <> 'array' THEN
    RETURN '[]'::JSONB;
  END IF;
  FOR v_okr IN SELECT value FROM jsonb_array_elements(p_okrs) LOOP
    IF v_okr IS NULL OR jsonb_typeof(v_okr) <> 'object' THEN CONTINUE; END IF;
    v_count := v_count + 1;
    IF v_count > 20 THEN CONTINUE; END IF;
    v_kr_count := CASE
      WHEN v_okr->'keyResults' IS NOT NULL AND jsonb_typeof(v_okr->'keyResults') = 'array'
      THEN jsonb_array_length(v_okr->'keyResults') ELSE 0 END;
    v_entry := jsonb_build_object(
      'id', v_okr->>'id',
      'objective', COALESCE(v_okr->>'objective', ''),
      'keyResults', CASE
        WHEN v_okr->'keyResults' IS NOT NULL AND jsonb_typeof(v_okr->'keyResults') = 'array'
        THEN v_okr->'keyResults' ELSE '[]'::JSONB END,
      'krCount', v_kr_count,
      'truncated', v_kr_count > 20
    );
    IF v_kr_count > 20 THEN
      v_entry := v_entry || jsonb_build_object(
        'keyResults',
        (SELECT jsonb_agg(value ORDER BY ordinality)
         FROM jsonb_array_elements(v_okr->'keyResults') WITH ORDINALITY AS t(value, ordinality)
         WHERE ordinality <= 20)
      );
    END IF;
    v_result := v_result || jsonb_build_array(v_entry);
  END LOOP;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Public RPC: department annual/quarterly OKRs (optionally with bound tasks).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mcp_get_department_okrs(
  p_department_id TEXT DEFAULT NULL,
  p_year INTEGER DEFAULT NULL,
  p_period TEXT DEFAULT NULL,
  p_include_tasks BOOLEAN DEFAULT TRUE,
  p_limit INTEGER DEFAULT 20
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_year INTEGER := COALESCE(p_year, (EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Shanghai')))::INTEGER);
  v_nodes JSONB := '[]'::JSONB;
  v_row RECORD;
  v_node JSONB;
  v_found JSONB;
  v_department JSONB;
  v_period_key TEXT;
  v_okrs JSONB;
  v_name_map JSONB := '{}'::JSONB;
  v_total INTEGER;
BEGIN
  IF v_year < 2000 OR v_year > 3000 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid year';
  END IF;
  IF p_period IS NOT NULL AND p_period NOT IN ('Annual', 'Q1', 'Q2', 'Q3', 'Q4') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid period';
  END IF;

  IF p_department_id IS NOT NULL AND btrim(p_department_id) <> '' THEN
    -- 定位指定部门（顶层行或树内节点）。
    v_found := NULL;
    FOR v_row IN
      SELECT d.id, d.name, d.manager_name, d.sub_departments, d.okrs
      FROM public.departments d
      ORDER BY d.id
    LOOP
      v_node := jsonb_build_object(
        'id', v_row.id, 'name', v_row.name, 'managerName', v_row.manager_name,
        'subDepartments', COALESCE(v_row.sub_departments, '[]'::JSONB),
        'okrs', COALESCE(v_row.okrs, '{}'::JSONB)
      );
      IF v_row.id = btrim(p_department_id) THEN
        v_found := v_node;
        EXIT;
      END IF;
      v_found := public.mcp_find_department_node(v_node, btrim(p_department_id));
      EXIT WHEN v_found IS NOT NULL;
    END LOOP;

    IF v_found IS NULL THEN
      RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible or does not exist';
    END IF;
    IF NOT public.current_user_has_department_visibility(v_found->>'id') THEN
      RAISE EXCEPTION 'MCP_PERMISSION_DENIED: department is not visible';
    END IF;

    v_nodes := public.mcp_collect_department_okr_nodes(v_found, v_year, p_period);
    -- 指定部门时只返回该部门自身（不展开子部门），与前端选中单部门语义一致。
    v_nodes := COALESCE((
      SELECT jsonb_agg(item)
      FROM jsonb_array_elements(v_nodes) AS t(item)
      WHERE item->>'id' = v_found->>'id'
    ), '[]'::JSONB);
  ELSE
    -- 未指定部门：遍历全部顶层行（RLS 已按可见性过滤），递归收集可见节点。
    FOR v_row IN
      SELECT d.id, d.name, d.manager_name, d.sub_departments, d.okrs
      FROM public.departments d
      ORDER BY d.id
    LOOP
      v_node := jsonb_build_object(
        'id', v_row.id, 'name', v_row.name, 'managerName', v_row.manager_name,
        'subDepartments', COALESCE(v_row.sub_departments, '[]'::JSONB),
        'okrs', COALESCE(v_row.okrs, '{}'::JSONB)
      );
      v_nodes := v_nodes || public.mcp_collect_department_okr_nodes(v_node, v_year, p_period);
    END LOOP;
  END IF;

  -- 只保留有 OKR 的部门，再应用 limit 截断；后续构建部门名映射供任务反查使用。
  v_nodes := COALESCE((
    SELECT jsonb_agg(item ORDER BY ordinality)
    FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS t(item, ordinality)
    WHERE item->'periods' <> '{}'::JSONB
  ), '[]'::JSONB);
  v_total := jsonb_array_length(v_nodes);
  IF v_total > v_limit THEN
    v_nodes := (
      SELECT jsonb_agg(item ORDER BY ordinality)
      FROM (
        SELECT item, ordinality
        FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS t(item, ordinality)
        WHERE ordinality <= v_limit
      ) capped
    );
  END IF;

  FOR v_department IN SELECT value FROM jsonb_array_elements(v_nodes) LOOP
    v_name_map := v_name_map || jsonb_build_object(v_department->>'id', v_department->>'name');
  END LOOP;

  -- 给每个部门的每个周期 OKR 列表挂任务。
  IF COALESCE(p_include_tasks, TRUE) THEN
    v_nodes := COALESCE((
      SELECT jsonb_agg(
        item || jsonb_build_object('periods', (
          SELECT COALESCE(jsonb_agg(
            jsonb_build_object(period_key, public.mcp_attach_tasks_to_okrs(period_value, v_name_map))
          ), '{}'::JSONB)
          FROM jsonb_each(item->'periods') AS p(period_key, period_value)
        ))
      )
      FROM jsonb_array_elements(v_nodes) AS t(item)
    ), '[]'::JSONB);
  END IF;

  RETURN jsonb_build_object(
    'year', v_year,
    'period', p_period,
    'departmentCount', jsonb_array_length(v_nodes),
    'hasMore', v_total > v_limit,
    'departments', v_nodes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_collect_department_okr_nodes(JSONB, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_find_department_node(JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_attach_tasks_to_okrs(JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_normalize_okr_entries(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_company_okrs(INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_department_okrs(TEXT, INTEGER, TEXT, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_get_company_okrs(INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_department_okrs(TEXT, INTEGER, TEXT, BOOLEAN, INTEGER) TO authenticated;

-- L2 rollback (manual, after exporting any operational evidence):
-- REVOKE EXECUTE ON FUNCTION public.mcp_get_company_okrs(INTEGER, BOOLEAN) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION public.mcp_get_department_okrs(TEXT, INTEGER, TEXT, BOOLEAN, INTEGER) FROM authenticated;
-- DROP FUNCTION public.mcp_get_company_okrs(INTEGER, BOOLEAN);
-- DROP FUNCTION public.mcp_get_department_okrs(TEXT, INTEGER, TEXT, BOOLEAN, INTEGER);
-- DROP FUNCTION public.mcp_collect_department_okr_nodes(JSONB, INTEGER, TEXT, TEXT);
-- DROP FUNCTION public.mcp_find_department_node(JSONB, TEXT);
-- DROP FUNCTION public.mcp_attach_tasks_to_okrs(JSONB, JSONB);
-- DROP FUNCTION public.mcp_normalize_okr_entries(JSONB);

COMMIT;
