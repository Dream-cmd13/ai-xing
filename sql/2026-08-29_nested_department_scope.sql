-- Nested department scope and permission compatibility.
-- Additive migration for JSON departments. It does not move business data.
-- The migration runner applies this file only after the existing 2026-08-28
-- migrations and records its SHA-256 checksum.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_nested_department_children(p_node JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(COALESCE(p_node->'subDepartments', 'null'::jsonb)) = 'array'
      THEN p_node->'subDepartments'
    WHEN jsonb_typeof(COALESCE(p_node->'sub_departments', 'null'::jsonb)) = 'array'
      THEN p_node->'sub_departments'
    ELSE '[]'::jsonb
  END;
$$;

-- Keep the existing OKR helper compatible with both historical child-key
-- spellings. The 2026-08-28 function is replaced in place so callers that
-- already use its public signature can resolve grandchildren as well.
CREATE OR REPLACE FUNCTION public.mcp_find_department_node(
  p_node JSONB,
  p_target_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
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
    FROM jsonb_array_elements(public.mcp_nested_department_children(p_node))
  LOOP
    v_found := public.mcp_find_department_node(v_child, p_target_id);
    IF v_found IS NOT NULL THEN
      RETURN v_found;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_department_tree_nodes()
RETURNS TABLE (
  root_id TEXT,
  root_name TEXT,
  node_id TEXT,
  node_name TEXT,
  parent_id TEXT,
  parent_name TEXT,
  depth INTEGER,
  node_path TEXT[],
  name_path TEXT[],
  manager_user_id TEXT,
  manager_name TEXT,
  node JSONB
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH RECURSIVE tree AS (
    SELECT
      d.id AS root_id,
      d.name AS root_name,
      d.id AS node_id,
      d.name AS node_name,
      NULL::TEXT AS parent_id,
      NULL::TEXT AS parent_name,
      0 AS depth,
      ARRAY[d.id]::TEXT[] AS node_path,
      ARRAY[d.name]::TEXT[] AS name_path,
      jsonb_build_object(
        'id', d.id,
        'name', d.name,
        'managerName', d.manager_name,
        'managerUserId', d.manager_user_id,
        'responsibilities', d.responsibilities,
        'roles', COALESCE(d.roles, '[]'::JSONB),
        'roleMembers', COALESCE(d.role_members, '{}'::JSONB),
        'attributes', d.attributes,
        'subDepartments', COALESCE(d.sub_departments, '[]'::JSONB),
        'okrs', COALESCE(d.okrs, '{}'::JSONB),
        'reviews', COALESCE(d.reviews, '{}'::JSONB),
        'rowVersion', d.row_version
      ) AS node
    FROM public.departments d
    WHERE d.id IS NOT NULL

    UNION ALL

    SELECT
      tree.root_id,
      tree.root_name,
      child.value->>'id',
      child.value->>'name',
      tree.node_id,
      tree.node_name,
      tree.depth + 1,
      tree.node_path || (child.value->>'id'),
      tree.name_path || COALESCE(NULLIF(child.value->>'name', ''), child.value->>'id'),
      child.value
    FROM tree
    CROSS JOIN LATERAL jsonb_array_elements(public.mcp_nested_department_children(tree.node)) AS child(value)
    WHERE tree.depth < 100
      AND jsonb_typeof(child.value) = 'object'
      AND NULLIF(btrim(child.value->>'id'), '') IS NOT NULL
      AND NOT ((child.value->>'id') = ANY(tree.node_path))
  )
  SELECT DISTINCT ON (tree.node_id)
    tree.root_id,
    tree.root_name,
    tree.node_id,
    COALESCE(NULLIF(tree.node_name, ''), tree.node_id),
    tree.parent_id,
    tree.parent_name,
    tree.depth,
    tree.node_path,
    tree.name_path,
    COALESCE(
      manager.id::TEXT,
      NULLIF(tree.node->>'managerUserId', ''),
      NULLIF(tree.node->>'manager_user_id', '')
    ) AS manager_user_id,
    COALESCE(
      NULLIF(tree.node->>'managerName', ''),
      NULLIF(tree.node->>'manager_name', ''),
      manager.name
    ) AS manager_name,
    tree.node
  FROM tree
  LEFT JOIN LATERAL (
    SELECT resolved.id::TEXT AS id, resolved.name
    FROM public.users resolved
    WHERE resolved.id::TEXT = COALESCE(
      (
        SELECT min(u.id)::TEXT FROM public.users u
        WHERE btrim(u.id::TEXT) = btrim(COALESCE(tree.node->>'managerUserId', tree.node->>'manager_user_id', ''))
        HAVING count(*) = 1
      ),
      (
        SELECT min(u.id)::TEXT FROM public.users u
        WHERE btrim(u.username) = btrim(COALESCE(tree.node->>'managerUserId', tree.node->>'manager_user_id', ''))
        HAVING count(*) = 1
      ),
      (
        SELECT min(u.id)::TEXT FROM public.users u
        WHERE btrim(u.name) = btrim(COALESCE(tree.node->>'managerUserId', tree.node->>'manager_user_id', ''))
        HAVING count(*) = 1
      ),
      (
        SELECT min(u.id)::TEXT FROM public.users u
        WHERE btrim(u.username) = btrim(COALESCE(tree.node->>'managerName', tree.node->>'manager_name', ''))
        HAVING count(*) = 1
      ),
      (
        SELECT min(u.id)::TEXT FROM public.users u
        WHERE btrim(u.name) = btrim(COALESCE(tree.node->>'managerName', tree.node->>'manager_name', ''))
        HAVING count(*) = 1
      )
    )
    LIMIT 1
  ) manager ON TRUE
  WHERE NULLIF(btrim(tree.node_id), '') IS NOT NULL
  ORDER BY tree.node_id, tree.depth, tree.root_id;
$$;

CREATE OR REPLACE FUNCTION public.mcp_current_user_manages_department_node(p_target_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_current_id TEXT := public.current_user_id();
  v_current_department_id TEXT := public.current_user_department_id();
BEGIN
  IF v_current_id IS NULL OR p_target_id IS NULL OR btrim(p_target_id) = '' THEN RETURN FALSE; END IF;
  IF public.is_admin() THEN RETURN TRUE; END IF;
  IF NOT public.is_manager() THEN RETURN FALSE; END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.mcp_department_tree_nodes() target
    JOIN public.mcp_department_tree_nodes() managed
      ON managed.root_id = target.root_id
     AND cardinality(target.node_path) >= cardinality(managed.node_path)
     AND target.node_path[1:cardinality(managed.node_path)] = managed.node_path
    WHERE target.node_id = p_target_id
      AND (
        managed.manager_user_id = v_current_id
        OR (managed.node_id = v_current_department_id AND public.is_manager())
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_current_user_can_see_department_node(p_target_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_current_id TEXT := public.current_user_id();
  v_current_department_id TEXT := public.current_user_department_id();
  v_permissions JSONB := public.current_user_pad_permissions();
  v_permission_id TEXT;
BEGIN
  IF public.is_admin() THEN RETURN TRUE; END IF;
  IF v_current_id IS NULL OR p_target_id IS NULL THEN RETURN FALSE; END IF;
  IF p_target_id = v_current_department_id OR public.mcp_current_user_manages_department_node(p_target_id) THEN RETURN TRUE; END IF;

  FOR v_permission_id IN SELECT value FROM public.jsonb_text_values(COALESCE(v_permissions, '[]'::JSONB)) LOOP
    IF p_target_id = v_permission_id THEN RETURN TRUE; END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

-- Validate all task people against the same recursive department boundary used
-- by the create/update RPCs. This keeps JSONB task membership from becoming a
-- side door around manager or employee permissions.
CREATE OR REPLACE FUNCTION public.mcp_validate_task_people(
  p_department_id TEXT,
  p_owner_id TEXT,
  p_participant_ids JSONB,
  p_approver_ids JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_item TEXT;
  v_user_department TEXT;
  v_is_manager BOOLEAN := public.is_manager() AND NOT public.is_admin();
BEGIN
  IF p_owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_owner_id) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: owner_id 不存在';
  END IF;
  IF p_participant_ids IS NOT NULL AND jsonb_typeof(p_participant_ids) <> 'array' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: participant_ids 必须是数组';
  END IF;
  IF p_approver_ids IS NOT NULL AND jsonb_typeof(p_approver_ids) <> 'array' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: approver_ids 必须是数组';
  END IF;
  IF jsonb_array_length(COALESCE(p_participant_ids, '[]'::JSONB)) > 50
     OR jsonb_array_length(COALESCE(p_approver_ids, '[]'::JSONB)) > 20 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 参与人或审批人数量超限';
  END IF;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements_text(COALESCE(p_participant_ids, '[]'::JSONB))
    UNION ALL
    SELECT value FROM jsonb_array_elements_text(COALESCE(p_approver_ids, '[]'::JSONB))
  LOOP
    SELECT department_id INTO v_user_department FROM public.users WHERE id = v_item;
    IF NOT FOUND THEN RAISE EXCEPTION 'MCP_VALIDATION: 参与人或审批人不存在'; END IF;
    IF v_is_manager AND NOT public.mcp_current_user_manages_department_node(v_user_department) THEN
      RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 参与人或审批人不在授权部门树内';
    END IF;
  END LOOP;
END;
$$;

-- Replace the legacy visibility helpers so every existing read/write RPC gets
-- the same recursive semantics. The public signatures remain unchanged.
CREATE OR REPLACE FUNCTION public.current_user_has_department_visibility(target_department_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN public.mcp_current_user_can_see_department_node(target_department_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.is_department_manager(target_department_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT public.mcp_current_user_manages_department_node(target_department_id);
$$;

CREATE OR REPLACE FUNCTION public.current_user_can_manage_task(
  task_department_id TEXT,
  task_owner_id TEXT,
  task_participant_ids JSONB,
  task_approver_ids JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_current_id TEXT := public.current_user_id();
BEGIN
  IF public.is_admin() THEN RETURN TRUE; END IF;
  IF v_current_id IS NULL THEN RETURN FALSE; END IF;
  IF public.mcp_current_user_manages_department_node(task_department_id) THEN RETURN TRUE; END IF;
  IF task_owner_id = v_current_id THEN RETURN TRUE; END IF;
  IF COALESCE(task_participant_ids, '[]'::JSONB) @> jsonb_build_array(v_current_id) THEN RETURN TRUE; END IF;
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_resolve_department(
  p_department_name TEXT DEFAULT NULL,
  p_scope TEXT DEFAULT 'auto',
  p_department_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_name TEXT := NULLIF(btrim(p_department_name), '');
  v_id TEXT := NULLIF(btrim(p_department_id), '');
  v_scope TEXT := COALESCE(NULLIF(btrim(p_scope), ''), 'auto');
  v_count INTEGER;
  v_department JSONB;
  v_candidates JSONB;
BEGIN
  IF v_scope NOT IN ('auto', 'exact', 'subtree') OR (v_name IS NULL AND v_id IS NULL) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 部门解析参数无效';
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', n.node_id, 'name', n.node_name, 'parentId', n.parent_id, 'parentName', n.parent_name,
      'rootId', n.root_id, 'rootName', n.root_name, 'depth', n.depth,
      'path', n.node_path, 'namePath', n.name_path, 'hasChildren', EXISTS (
        SELECT 1 FROM public.mcp_department_tree_nodes() AS child
        WHERE child.root_id = n.root_id AND cardinality(child.node_path) > cardinality(n.node_path)
          AND child.node_path[1:cardinality(n.node_path)] = n.node_path
      ), 'managerUserId', n.manager_user_id, 'managerName', n.manager_name
    ) INTO v_department
    FROM public.mcp_department_tree_nodes() AS n
    WHERE n.node_id = v_id AND public.mcp_current_user_can_see_department_node(n.node_id)
    ORDER BY n.depth, n.root_id LIMIT 1;
    IF v_department IS NULL THEN RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible'; END IF;
  ELSE
    SELECT count(*)::INTEGER,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', n.node_id, 'name', n.node_name, 'parentId', n.parent_id, 'parentName', n.parent_name,
        'rootId', n.root_id, 'rootName', n.root_name, 'depth', n.depth,
        'path', n.node_path, 'namePath', n.name_path,
        'hasChildren', EXISTS (
          SELECT 1 FROM public.mcp_department_tree_nodes() AS child
          WHERE child.root_id = n.root_id
            AND cardinality(child.node_path) > cardinality(n.node_path)
            AND child.node_path[1:cardinality(n.node_path)] = n.node_path
        ),
        'managerUserId', n.manager_user_id, 'managerName', n.manager_name
      ) ORDER BY n.root_id, n.node_path), '[]'::JSONB)
    INTO v_count, v_candidates
    FROM public.mcp_department_tree_nodes() AS n
    WHERE btrim(n.node_name) = v_name AND public.mcp_current_user_can_see_department_node(n.node_id);
    IF v_count = 0 THEN RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible'; END IF;
    IF v_count > 1 THEN
      RETURN jsonb_build_object('ambiguous', TRUE, 'candidates', v_candidates);
    END IF;
    v_department := v_candidates->0;
  END IF;

  IF v_scope = 'auto' THEN
    v_scope := CASE WHEN COALESCE((v_department->>'hasChildren')::BOOLEAN, FALSE) THEN 'subtree' ELSE 'exact' END;
  END IF;
  RETURN jsonb_build_object(
    'department', v_department,
    'scope', v_scope,
    'ids', (
      SELECT COALESCE(jsonb_agg(n.node_id ORDER BY cardinality(n.node_path), n.node_id), '[]'::JSONB)
      FROM public.mcp_department_tree_nodes() AS n
      WHERE n.root_id = v_department->>'rootId'
        AND (
          v_scope = 'exact' AND n.node_id = v_department->>'id'
          OR v_scope = 'subtree'
            AND cardinality(n.node_path) >= jsonb_array_length(v_department->'path')
            AND n.node_path[1:jsonb_array_length(v_department->'path')] = ARRAY(SELECT jsonb_array_elements_text(v_department->'path'))
        )
    )
  );
END;
$$;

-- Read-only context used by prepare_update/save_review_record. Nested
-- departments have no physical row of their own, so the root row carries the
-- optimistic-lock version while the node path identifies the JSON location.
CREATE OR REPLACE FUNCTION public.mcp_get_department_review_context(p_department_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_node RECORD;
  v_root public.departments;
  v_reviews JSONB;
  v_node_value JSONB;
BEGIN
  SELECT * INTO v_node
  FROM public.mcp_department_tree_nodes() AS n
  WHERE n.node_id = NULLIF(btrim(p_department_id), '')
    AND public.mcp_current_user_can_see_department_node(n.node_id)
  ORDER BY n.depth, n.root_id
  LIMIT 1;
  IF v_node.node_id IS NULL THEN
    RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible';
  END IF;

  SELECT * INTO v_root FROM public.departments WHERE id = v_node.root_id;
  IF v_root.id IS NULL THEN
    RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department root is missing';
  END IF;
  IF cardinality(v_node.node_path) = 1 THEN
    v_reviews := COALESCE(v_root.reviews, '{}'::JSONB);
  ELSE
    v_node_value := public.mcp_jsonb_find_department_node(
      COALESCE(v_root.sub_departments, '[]'::JSONB),
      v_node.node_id
    );
    v_reviews := COALESCE(v_node_value->'reviews', '{}'::JSONB);
  END IF;
  RETURN jsonb_build_object(
    'departmentId', v_node.node_id,
    'departmentName', v_node.node_name,
    'rootId', v_node.root_id,
    'nodePath', to_jsonb(v_node.node_path),
    'reviews', v_reviews,
    'rowVersion', v_root.row_version
  );
END;
$$;

-- Compatibility helper for nested review reads. It intentionally returns only
-- the matching node and never exposes the rest of the organization document.
CREATE OR REPLACE FUNCTION public.mcp_jsonb_find_department_node(p_nodes JSONB, p_node_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_node JSONB;
  v_found JSONB;
BEGIN
  IF jsonb_typeof(p_nodes) <> 'array' THEN RETURN NULL; END IF;
  FOR v_node IN SELECT value FROM jsonb_array_elements(p_nodes) LOOP
    IF v_node->>'id' = p_node_id THEN RETURN v_node; END IF;
    v_found := public.mcp_jsonb_find_department_node(public.mcp_nested_department_children(v_node), p_node_id);
    IF v_found IS NOT NULL THEN RETURN v_found; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_jsonb_set_department_reviews(
  p_nodes JSONB,
  p_node_id TEXT,
  p_reviews JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_index INTEGER := 0;
  v_node JSONB;
  v_children JSONB;
  v_updated JSONB;
  v_key TEXT := 'subDepartments';
BEGIN
  IF jsonb_typeof(p_nodes) <> 'array' THEN RETURN COALESCE(p_nodes, '[]'::JSONB); END IF;
  FOR v_node IN SELECT value FROM jsonb_array_elements(p_nodes) LOOP
    IF v_node->>'id' = p_node_id THEN
      RETURN jsonb_set(p_nodes, ARRAY[v_index::TEXT, 'reviews'], COALESCE(p_reviews, '{}'::JSONB), true);
    END IF;
    v_children := public.mcp_nested_department_children(v_node);
    IF jsonb_array_length(v_children) > 0 THEN
      v_updated := public.mcp_jsonb_set_department_reviews(v_children, p_node_id, p_reviews);
      IF v_updated IS DISTINCT FROM v_children THEN
        v_key := CASE
          WHEN jsonb_typeof(v_node->'subDepartments') = 'array' THEN 'subDepartments'
          WHEN jsonb_typeof(v_node->'sub_departments') = 'array' THEN 'sub_departments'
          ELSE 'subDepartments'
        END;
        RETURN jsonb_set(p_nodes, ARRAY[v_index::TEXT, v_key], v_updated, true);
      END IF;
    END IF;
    v_index := v_index + 1;
  END LOOP;
  RETURN p_nodes;
END;
$$;

-- Replace the 2026-08-28 OKR walker so nested nodes accept both historical
-- child-key spellings while retaining the existing output contract.
CREATE OR REPLACE FUNCTION public.mcp_collect_department_okr_nodes(
  p_node JSONB,
  p_year INTEGER,
  p_period TEXT,
  p_parent_name TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
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
                WHEN jsonb_typeof(v_okr->'keyResults') = 'array' THEN jsonb_array_length(v_okr->'keyResults')
                ELSE 0
              END;
              v_entry := jsonb_build_object(
                'id', v_okr_id,
                'objective', COALESCE(v_okr->>'objective', ''),
                'keyResults', CASE
                  WHEN jsonb_typeof(v_okr->'keyResults') = 'array' THEN v_okr->'keyResults'
                  ELSE '[]'::JSONB
                END,
                'krCount', v_kr_count,
                'truncated', v_kr_count > 20
              );
              IF v_kr_count > 20 THEN
                v_entry := v_entry || jsonb_build_object(
                  'keyResults', (
                    SELECT jsonb_agg(value ORDER BY ordinality)
                    FROM jsonb_array_elements(v_okr->'keyResults') WITH ORDINALITY AS t(value, ordinality)
                    WHERE ordinality <= 20
                  )
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
      'managerName', COALESCE(p_node->>'managerName', p_node->>'manager_name', ''),
      'parentName', p_parent_name,
      'periods', v_periods
    ));
  END IF;

  FOR v_child IN
    SELECT value FROM jsonb_array_elements(public.mcp_nested_department_children(p_node))
  LOOP
    v_result := v_result || public.mcp_collect_department_okr_nodes(
      v_child, p_year, p_period, COALESCE(p_node->>'name', '')
    );
  END LOOP;
  RETURN v_result;
END;
$$;

-- Database-side defense-in-depth for save_review_record. Node validation is
-- still useful for friendly errors, but this recursive check protects direct
-- authenticated RPC callers as well.
CREATE OR REPLACE FUNCTION public.mcp_jsonb_contains_task_review_fields(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_child JSONB;
BEGIN
  IF p_value IS NULL THEN RETURN FALSE; END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    FOR v_key, v_child IN SELECT key, value FROM jsonb_each(p_value) LOOP
      IF v_key IN ('taskEvaluations', 'taskScores') THEN RETURN TRUE; END IF;
      IF public.mcp_jsonb_contains_task_review_fields(v_child) THEN RETURN TRUE; END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    FOR v_child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF public.mcp_jsonb_contains_task_review_fields(v_child) THEN RETURN TRUE; END IF;
    END LOOP;
  END IF;
  RETURN FALSE;
END;
$$;

-- Scoped wrappers reuse the audited OKR/review readers and combine only the
-- already-authorized descendant IDs. The range is materialized once, and all
-- public limits remain bounded.
CREATE OR REPLACE FUNCTION public.mcp_get_department_okrs_scope_v2(
  p_department_id TEXT,
  p_scope TEXT DEFAULT 'auto',
  p_year INTEGER DEFAULT NULL,
  p_period TEXT DEFAULT NULL,
  p_include_tasks BOOLEAN DEFAULT TRUE,
  p_limit INTEGER DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_scope JSONB := public.mcp_collect_department_scope_ids(p_department_id, p_scope);
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_nodes JSONB := '[]'::JSONB;
  v_result JSONB;
  v_root_node JSONB;
  v_start_node JSONB;
  v_department JSONB;
  v_periods JSONB;
  v_period_key TEXT;
  v_period_value JSONB;
  v_name_map JSONB := '{}'::JSONB;
  v_total INTEGER;
BEGIN
  SELECT n.node INTO v_root_node
  FROM public.mcp_department_tree_nodes() AS n
  WHERE n.node_id = v_scope->'department'->>'rootId'
  ORDER BY n.depth, n.root_id
  LIMIT 1;
  IF v_root_node IS NULL THEN
    RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department root is not visible';
  END IF;
  v_start_node := CASE
    WHEN v_scope->'department'->>'id' = v_scope->'department'->>'rootId' THEN v_root_node
    ELSE public.mcp_find_department_node(v_root_node, v_scope->'department'->>'id')
  END;
  IF v_start_node IS NULL THEN
    RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department node is not visible';
  END IF;
  v_nodes := public.mcp_collect_department_okr_nodes(v_start_node, p_year, p_period);
  v_nodes := COALESCE((
    SELECT jsonb_agg(item ORDER BY ordinality)
    FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS page(item, ordinality)
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(v_scope->'ids', '[]'::JSONB)) AS scope_id(value)
      WHERE scope_id.value = item->>'id'
    )
  ), '[]'::JSONB);
  v_nodes := COALESCE((
    SELECT jsonb_agg(item ORDER BY ordinality)
    FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS page(item, ordinality)
    WHERE item->'periods' <> '{}'::JSONB
  ), '[]'::JSONB);
  v_total := jsonb_array_length(v_nodes);
  IF v_total > v_limit THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY ordinality), '[]'::JSONB)
    INTO v_nodes
    FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS page(item, ordinality)
    WHERE ordinality <= v_limit;
  END IF;
  IF COALESCE(p_include_tasks, TRUE) THEN
    SELECT COALESCE(jsonb_object_agg(item->>'id', item->>'name'), '{}'::JSONB)
      INTO v_name_map
    FROM jsonb_array_elements(v_nodes) AS entries(item);
    SELECT COALESCE(jsonb_agg(
      item || jsonb_build_object('periods', (
        SELECT COALESCE(jsonb_object_agg(period_key, public.mcp_attach_tasks_to_okrs(period_value, v_name_map)), '{}'::JSONB)
        FROM jsonb_each(item->'periods') AS periods(period_key, period_value)
      )) ORDER BY ordinality), '[]'::JSONB)
      INTO v_nodes
    FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS entries(item, ordinality);
  END IF;
  RETURN jsonb_build_object(
    'year', COALESCE(p_year, (EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Shanghai')))::INTEGER),
    'period', p_period,
    'departmentId', p_department_id,
    'scope', v_scope->>'scope',
    'departmentCount', jsonb_array_length(v_nodes),
    'hasMore', v_total > v_limit,
    'departments', v_nodes
  );
END;
$$;

-- Scoped create path. The legacy function deliberately rejects a department ID
-- different from current_user_department_id; this additive entry point keeps
-- that compatibility rule for old callers while allowing a department manager
-- to create a task anywhere in the manager's recursive subtree.
CREATE OR REPLACE FUNCTION public.mcp_create_pad_task_scoped(
  p_task JSONB,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task JSONB := COALESCE(p_task, '{}'::JSONB);
  v_current_id TEXT := public.current_user_id();
  v_current_department_id TEXT := public.current_user_department_id();
  v_department_id TEXT;
  v_department_root_id TEXT;
  v_department_path TEXT[];
  v_department_has_children BOOLEAN := FALSE;
  v_owner_id TEXT;
  v_owner_department_id TEXT;
  v_task_row public.tasks;
  v_log_id BIGINT;
  v_prior_status TEXT;
  v_prior_result JSONB;
  v_result JSONB;
  v_key TEXT;
  v_item TEXT;
  v_start BIGINT;
  v_due BIGINT;
  v_shanghai_date DATE;
  v_default_monday DATE;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: requestId 长度必须在 8 到 128 个字符之间';
  END IF;
  IF jsonb_typeof(v_task) <> 'object' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务参数必须是对象';
  END IF;
  IF NOT (v_task ? 'target_weeks') AND NOT (v_task ? 'start_date') AND NOT (v_task ? 'due_date') THEN
    v_shanghai_date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_default_monday := date_trunc('week', v_shanghai_date::TIMESTAMP)::DATE;
    v_task := v_task || jsonb_build_object(
      'target_weeks', jsonb_build_array(to_char(v_shanghai_date, 'IYYY-"W"IW')),
      'start_date', floor(extract(epoch FROM ((v_default_monday::TIMESTAMP + TIME '12:00') AT TIME ZONE 'UTC')) * 1000)::BIGINT,
      'due_date', floor(extract(epoch FROM ((v_default_monday::TIMESTAMP + TIME '12:00') AT TIME ZONE 'UTC')) * 1000)::BIGINT + 6 * 24 * 60 * 60 * 1000
    );
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_task) LOOP
    IF v_key NOT IN ('department_id', 'title', 'status', 'priority', 'owner_id', 'aligned_kr_id', 'target_weeks', 'start_date', 'due_date', 'tags', 'participant_ids', 'approver_ids', 'plan', 'action', 'deliverable') THEN
      RAISE EXCEPTION 'MCP_VALIDATION: 任务参数包含不允许的字段 %', v_key;
    END IF;
  END LOOP;
  IF COALESCE(length(btrim(v_task->>'title')), 0) = 0 OR length(v_task->>'title') > 200 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: title 必填且长度不能超过 200';
  END IF;
  IF COALESCE(v_task->>'status', 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 创建任务只能使用 draft 状态';
  END IF;
  IF v_task ? 'priority' AND COALESCE(v_task->>'priority', '') NOT IN ('high', 'medium', 'low') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: priority 无效';
  END IF;
  IF v_task ? 'target_weeks' THEN
    IF jsonb_typeof(v_task->'target_weeks') <> 'array' OR jsonb_array_length(v_task->'target_weeks') > 53 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 必须是最多 53 项的数组';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements_text(v_task->'target_weeks') LOOP
      IF v_item !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
        RAISE EXCEPTION 'MCP_VALIDATION: target_weeks 包含无效周次';
      END IF;
    END LOOP;
  END IF;
  IF v_task ? 'start_date' AND v_task->>'start_date' IS NOT NULL THEN
    IF v_task->>'start_date' !~ '^\d+$' THEN RAISE EXCEPTION 'MCP_VALIDATION: start_date 必须是时间戳'; END IF;
    v_start := (v_task->>'start_date')::BIGINT;
  END IF;
  IF v_task ? 'due_date' AND v_task->>'due_date' IS NOT NULL THEN
    IF v_task->>'due_date' !~ '^\d+$' THEN RAISE EXCEPTION 'MCP_VALIDATION: due_date 必须是时间戳'; END IF;
    v_due := (v_task->>'due_date')::BIGINT;
  END IF;
  IF v_start IS NOT NULL AND v_due IS NOT NULL AND v_due < v_start THEN
    RAISE EXCEPTION 'MCP_VALIDATION: due_date 不能早于 start_date';
  END IF;
  IF v_current_id IS NULL THEN RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户'; END IF;

  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (v_current_id, 'commit_create_pad_task', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
  RETURNING id INTO v_log_id;
  IF v_log_id IS NULL THEN
    SELECT status, result_summary INTO v_prior_status, v_prior_result
    FROM public.mcp_write_log
    WHERE user_id = v_current_id AND tool_name = 'commit_create_pad_task' AND request_id = p_request_id;
    IF v_prior_status = 'success' THEN RETURN jsonb_build_object('replayed', true, 'result', v_prior_result); END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;

  v_department_id := COALESCE(NULLIF(v_task->>'department_id', ''), v_current_department_id);
  v_owner_id := COALESCE(NULLIF(v_task->>'owner_id', ''), v_current_id);
  IF v_department_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.mcp_department_tree_nodes() n WHERE n.node_id = v_department_id
  ) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法确定任务所属部门';
  END IF;
  SELECT department_id INTO v_owner_department_id FROM public.users WHERE id = v_owner_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MCP_VALIDATION: owner_id 不存在'; END IF;
  IF NOT public.is_admin() AND NOT (
    (public.is_manager() AND public.mcp_current_user_manages_department_node(v_department_id))
    OR (public.is_employee() AND v_department_id = v_current_department_id AND v_owner_id = v_current_id)
    OR (public.has_menu_permission('task-center', 'create') OR public.has_menu_permission('execution', 'create'))
      AND public.mcp_current_user_can_see_department_node(v_department_id)
  ) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限创建任务';
  END IF;
  IF public.is_employee() AND v_owner_id <> v_current_id THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: Employee 只能将本人设为负责人';
  END IF;
  IF public.is_manager() AND NOT public.is_admin()
     AND NOT public.mcp_current_user_manages_department_node(v_owner_department_id) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: Manager 只能指定授权部门树内成员为负责人';
  END IF;
  PERFORM public.mcp_validate_task_people(
    v_department_id,
    v_owner_id,
    v_task->'participant_ids',
    v_task->'approver_ids'
  );

  INSERT INTO public.tasks (
    id, department_id, created_by, title, status, priority, owner_id,
    aligned_kr_id, target_weeks, start_date, due_date, tags,
    participant_ids, approver_ids, plan, action, deliverable, row_version
  )
  VALUES (
    'task-mcp-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT || '-' || substr(md5(random()::TEXT || clock_timestamp()::TEXT || v_current_id), 1, 12),
    v_department_id, v_current_id, btrim(v_task->>'title'), 'draft',
    COALESCE(NULLIF(v_task->>'priority', ''), 'medium'), v_owner_id,
    NULLIF(v_task->>'aligned_kr_id', ''), COALESCE(v_task->'target_weeks', '[]'::JSONB),
    NULLIF(v_task->>'start_date', '')::BIGINT, NULLIF(v_task->>'due_date', '')::BIGINT,
    COALESCE(v_task->'tags', '[]'::JSONB), COALESCE(v_task->'participant_ids', '[]'::JSONB),
    COALESCE(v_task->'approver_ids', '[]'::JSONB), NULLIF(v_task->>'plan', ''),
    NULLIF(v_task->>'action', ''), NULLIF(v_task->>'deliverable', ''), 0
  ) RETURNING * INTO v_task_row;

  v_result := jsonb_build_object(
    'replayed', false,
    'task', jsonb_build_object(
      'id', v_task_row.id, 'createdBy', v_task_row.created_by, 'title', v_task_row.title,
      'status', v_task_row.status, 'priority', v_task_row.priority, 'ownerId', v_task_row.owner_id,
      'departmentId', v_task_row.department_id, 'alignedKrId', v_task_row.aligned_kr_id,
      'targetWeeks', COALESCE(v_task_row.target_weeks, '[]'::JSONB), 'startDate', v_task_row.start_date,
      'dueDate', v_task_row.due_date, 'tags', COALESCE(v_task_row.tags, '[]'::JSONB),
      'participantIds', COALESCE(v_task_row.participant_ids, '[]'::JSONB), 'approverIds', COALESCE(v_task_row.approver_ids, '[]'::JSONB),
      'logs', COALESCE(v_task_row.logs, '[]'::JSONB), 'plan', v_task_row.plan, 'action', v_task_row.action,
      'deliverable', v_task_row.deliverable, 'taskReview', v_task_row.task_review,
      'taskReviewScore', v_task_row.task_review_score, 'updatedAt', v_task_row.updated_at, 'rowVersion', v_task_row.row_version
    ),
    'rowVersion', v_task_row.row_version
  );
  INSERT INTO public.mcp_audit_log (user_id, tool_name, request_id, action, object_type, object_id, status, after_summary)
  VALUES (v_current_id, 'commit_create_pad_task', p_request_id, 'create', 'task', v_task_row.id, 'success',
    jsonb_build_object('id', v_task_row.id, 'title', v_task_row.title, 'ownerId', v_task_row.owner_id, 'departmentId', v_task_row.department_id, 'rowVersion', v_task_row.row_version));
  UPDATE public.mcp_write_log SET status = 'success', result_summary = v_result, completed_at = public.audit_now_ms() WHERE id = v_log_id;
  RETURN v_result;
END;
$$;

-- The original helper only inspected a physical departments row. Replace it
-- with the same recursive manager rule used by reads and task writes.
CREATE OR REPLACE FUNCTION public.current_user_can_edit_department_reviews(p_department_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT public.is_admin()
    OR public.mcp_current_user_manages_department_node(p_department_id)
    OR (public.is_manager() AND p_department_id = public.current_user_department_id())
    OR (public.has_menu_permission('okr-review', 'update') AND public.mcp_current_user_can_see_department_node(p_department_id));
$$;

-- Owner reassignment path for managers. Ordinary field updates continue to
-- use mcp_update_pad_task; this function is selected only when owner_id is
-- present, so existing callers retain their original RPC contract.
CREATE OR REPLACE FUNCTION public.mcp_update_pad_task_scoped(
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
  v_current_id TEXT := public.current_user_id();
  v_old public.tasks;
  v_new public.tasks;
  v_owner_department_id TEXT;
  v_log_id BIGINT;
  v_status TEXT;
  v_prior JSONB;
  v_result JSONB;
  v_key TEXT;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128
     OR p_task_id IS NULL OR btrim(p_task_id) = '' OR p_expected_row_version IS NULL OR p_expected_row_version < 0
     OR p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::JSONB THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 更新参数无效';
  END IF;
  IF v_current_id IS NULL THEN RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户'; END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
    IF v_key NOT IN ('title', 'status', 'priority', 'target_weeks', 'start_date', 'due_date', 'tags', 'participant_ids', 'approver_ids', 'plan', 'action', 'deliverable', 'owner_id') THEN
      RAISE EXCEPTION 'MCP_VALIDATION: changes 包含不允许的字段 %', v_key;
    END IF;
  END LOOP;
  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (v_current_id, 'commit_update_pad_task', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING RETURNING id INTO v_log_id;
  IF v_log_id IS NULL THEN
    SELECT status, result_summary INTO v_status, v_prior FROM public.mcp_write_log
    WHERE user_id = v_current_id AND tool_name = 'commit_update_pad_task' AND request_id = p_request_id;
    IF v_status = 'success' THEN RETURN jsonb_build_object('replayed', true, 'result', v_prior); END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;
  SELECT * INTO v_old FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF v_old.id IS NULL OR NOT public.current_user_can_manage_task(v_old.department_id, v_old.owner_id, v_old.participant_ids, v_old.approver_ids) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限修改任务';
  END IF;
  IF v_old.row_version <> p_expected_row_version THEN RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改'; END IF;
  IF p_changes ? 'owner_id' THEN
    SELECT department_id INTO v_owner_department_id FROM public.users WHERE id = p_changes->>'owner_id';
    IF NOT FOUND THEN RAISE EXCEPTION 'MCP_VALIDATION: owner_id 不存在'; END IF;
    IF public.is_employee() OR (public.is_manager() AND NOT public.is_admin() AND NOT public.mcp_current_user_manages_department_node(v_owner_department_id)) THEN
      RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 当前账号不能指定该负责人';
    END IF;
  END IF;
  PERFORM public.mcp_validate_task_people(
    v_old.department_id,
    COALESCE(NULLIF(p_changes->>'owner_id', ''), v_old.owner_id),
    CASE WHEN p_changes ? 'participant_ids' THEN p_changes->'participant_ids' ELSE v_old.participant_ids END,
    CASE WHEN p_changes ? 'approver_ids' THEN p_changes->'approver_ids' ELSE v_old.approver_ids END
  );
  UPDATE public.tasks SET
    title = CASE WHEN p_changes ? 'title' THEN btrim(p_changes->>'title') ELSE v_old.title END,
    status = CASE WHEN p_changes ? 'status' THEN p_changes->>'status' ELSE v_old.status END,
    priority = CASE WHEN p_changes ? 'priority' THEN p_changes->>'priority' ELSE v_old.priority END,
    owner_id = CASE WHEN p_changes ? 'owner_id' THEN p_changes->>'owner_id' ELSE v_old.owner_id END,
    target_weeks = CASE WHEN p_changes ? 'target_weeks' THEN p_changes->'target_weeks' ELSE v_old.target_weeks END,
    start_date = CASE WHEN p_changes ? 'start_date' THEN NULLIF(p_changes->>'start_date', '')::BIGINT ELSE v_old.start_date END,
    due_date = CASE WHEN p_changes ? 'due_date' THEN NULLIF(p_changes->>'due_date', '')::BIGINT ELSE v_old.due_date END,
    tags = CASE WHEN p_changes ? 'tags' THEN p_changes->'tags' ELSE v_old.tags END,
    participant_ids = CASE WHEN p_changes ? 'participant_ids' THEN p_changes->'participant_ids' ELSE v_old.participant_ids END,
    approver_ids = CASE WHEN p_changes ? 'approver_ids' THEN p_changes->'approver_ids' ELSE v_old.approver_ids END,
    plan = CASE WHEN p_changes ? 'plan' THEN NULLIF(p_changes->>'plan', '') ELSE v_old.plan END,
    action = CASE WHEN p_changes ? 'action' THEN NULLIF(p_changes->>'action', '') ELSE v_old.action END,
    deliverable = CASE WHEN p_changes ? 'deliverable' THEN NULLIF(p_changes->>'deliverable', '') ELSE v_old.deliverable END,
    row_version = v_old.row_version + 1
  WHERE id = v_old.id AND row_version = p_expected_row_version RETURNING * INTO v_new;
  IF v_new.id IS NULL THEN RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改'; END IF;
  v_result := jsonb_build_object('replayed', false,
    'task', jsonb_build_object('id', v_new.id, 'title', v_new.title, 'status', v_new.status, 'priority', v_new.priority, 'ownerId', v_new.owner_id, 'departmentId', v_new.department_id, 'rowVersion', v_new.row_version),
    'rowVersion', v_new.row_version);
  INSERT INTO public.mcp_audit_log (user_id, tool_name, request_id, action, object_type, object_id, status, before_summary, after_summary)
  VALUES (v_current_id, 'commit_update_pad_task', p_request_id, 'update', 'task', v_old.id, 'success',
    jsonb_build_object('id', v_old.id, 'ownerId', v_old.owner_id, 'rowVersion', v_old.row_version),
    jsonb_build_object('id', v_new.id, 'ownerId', v_new.owner_id, 'rowVersion', v_new.row_version));
  UPDATE public.mcp_write_log SET status = 'success', result_summary = v_result, completed_at = public.audit_now_ms() WHERE id = v_log_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_save_review_record_scoped(
  p_department_id TEXT,
  p_period_key TEXT,
  p_entry JSONB,
  p_expected_row_version BIGINT,
  p_request_id TEXT,
  p_department_root_id TEXT DEFAULT NULL,
  p_department_node_path TEXT[] DEFAULT NULL
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
  v_entry JSONB;
  v_reviews JSONB;
  v_sub_departments JSONB;
  v_review_id TEXT;
  v_log_id BIGINT;
  v_prior_status TEXT;
  v_prior_result JSONB;
  v_result JSONB;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128
     OR p_department_id IS NULL OR btrim(p_department_id) = ''
      OR p_period_key IS NULL
      OR (p_period_key !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
          AND p_period_key !~ '^\d{4}-(0[1-9]|1[0-2])$'
          AND p_period_key !~ '^\d{4}-Q[1-4]$')
     OR p_expected_row_version IS NULL OR p_expected_row_version < 0
     OR p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object'
     OR COALESCE(length(btrim(p_entry->>'content')), 0) = 0
     OR length(p_entry->>'content') > 2000 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘参数无效';
  END IF;
  IF v_current_id IS NULL THEN RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户'; END IF;
  IF public.mcp_jsonb_contains_task_review_fields(p_entry) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务复盘请通过 commit_update_pad_task 提交';
  END IF;
  IF p_entry ? 'score' THEN
    IF (p_entry->>'score') !~ '^\d+$' THEN
      RAISE EXCEPTION 'MCP_VALIDATION: score 必须在 0 到 100 之间';
    END IF;
    IF (p_entry->>'score')::INTEGER NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'MCP_VALIDATION: score 必须在 0 到 100 之间';
    END IF;
  END IF;

  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (v_current_id, 'save_review_record', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
  RETURNING id INTO v_log_id;
  IF v_log_id IS NULL THEN
    SELECT status, result_summary INTO v_prior_status, v_prior_result
    FROM public.mcp_write_log
    WHERE user_id = v_current_id AND tool_name = 'save_review_record' AND request_id = p_request_id;
    IF v_prior_status = 'success' THEN RETURN jsonb_build_object('replayed', true, 'result', v_prior_result); END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;

  SELECT * INTO v_node
  FROM public.mcp_department_tree_nodes() n
  WHERE n.node_id = p_department_id
  ORDER BY n.depth, n.root_id LIMIT 1;
  IF v_node.node_id IS NULL THEN RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible'; END IF;
  IF cardinality(v_node.node_path) > 1
     AND (p_department_root_id IS NULL OR p_department_node_path IS NULL) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 嵌套部门复盘必须提供部门根节点和节点路径';
  END IF;
  IF p_department_root_id IS NOT NULL AND p_department_root_id <> v_node.root_id THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 部门根节点与确认信息不一致';
  END IF;
  IF p_department_node_path IS NOT NULL AND p_department_node_path <> v_node.node_path THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 部门节点路径与确认信息不一致';
  END IF;
  IF NOT public.current_user_can_edit_department_reviews(v_node.node_id) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限保存该部门复盘';
  END IF;
  SELECT * INTO v_root FROM public.departments WHERE id = v_node.root_id FOR UPDATE;
  IF v_root.id IS NULL THEN RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department root is missing'; END IF;
  IF v_root.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改';
  END IF;
  SELECT name INTO v_review_id FROM public.users WHERE id = v_current_id;
  v_review_id := 'rev-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT || '-' || substr(md5(random()::TEXT || clock_timestamp()::TEXT || v_current_id), 1, 12);
  v_entry := jsonb_build_object(
    'id', v_review_id, 'date', public.audit_now_ms(), 'content', btrim(p_entry->>'content'),
    'score', COALESCE(NULLIF(p_entry->>'score', '')::INTEGER, 0), 'reviewer', COALESCE((SELECT name FROM public.users WHERE id = v_current_id), v_current_id),
    'okrDetails', CASE WHEN jsonb_typeof(p_entry->'okrDetails') = 'object' THEN p_entry->'okrDetails' ELSE '{}'::JSONB END
  );
  IF cardinality(v_node.node_path) = 1 THEN
    v_reviews := jsonb_set(COALESCE(v_root.reviews, '{}'::JSONB), ARRAY[p_period_key], jsonb_build_array(v_entry), true);
    UPDATE public.departments SET reviews = v_reviews, row_version = v_root.row_version + 1
    WHERE id = v_root.id AND row_version = p_expected_row_version;
  ELSE
    v_sub_departments := public.mcp_jsonb_set_department_reviews(COALESCE(v_root.sub_departments, '[]'::JSONB), v_node.node_id,
      jsonb_set(COALESCE((public.mcp_jsonb_find_department_node(v_root.sub_departments, v_node.node_id))->'reviews', '{}'::JSONB), ARRAY[p_period_key], jsonb_build_array(v_entry), true));
    UPDATE public.departments SET sub_departments = v_sub_departments, row_version = v_root.row_version + 1
    WHERE id = v_root.id AND row_version = p_expected_row_version;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改'; END IF;

  v_result := jsonb_build_object('replayed', false, 'departmentId', p_department_id, 'periodKey', p_period_key,
    'reviewId', v_review_id, 'rowVersion', v_root.row_version + 1, 'departmentRootId', v_root.id);
  INSERT INTO public.mcp_audit_log (user_id, tool_name, request_id, action, object_type, object_id, status, before_summary, after_summary)
  VALUES (v_current_id, 'save_review_record', p_request_id, 'save_review', 'department_review', p_department_id, 'success',
    jsonb_build_object('departmentId', p_department_id, 'periodKey', p_period_key, 'rootId', v_root.id, 'rowVersion', v_root.row_version),
    jsonb_build_object('departmentId', p_department_id, 'periodKey', p_period_key, 'rootId', v_root.id, 'reviewId', v_review_id, 'rowVersion', v_root.row_version + 1));
  UPDATE public.mcp_write_log SET status = 'success', result_summary = v_result, completed_at = public.audit_now_ms() WHERE id = v_log_id;
  RETURN v_result;
END;
$$;

-- Atomic nested review synchronization. The task row is locked first and the
-- physical root department row second, matching the established lock order;
-- the child node's reviews are replaced inside the root JSON document.
CREATE OR REPLACE FUNCTION public.mcp_update_pad_task_with_review_sync_scoped(
  p_task_id TEXT,
  p_changes JSONB,
  p_review_period_key TEXT,
  p_review_key TEXT,
  p_kr_index INTEGER,
  p_expected_row_version BIGINT,
  p_expected_department_row_version BIGINT,
  p_request_id TEXT,
  p_department_root_id TEXT,
  p_department_node_path TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_id TEXT := public.current_user_id();
  v_old_task public.tasks;
  v_new_task public.tasks;
  v_node RECORD;
  v_root public.departments;
  v_node_value JSONB;
  v_period_reviews JSONB;
  v_entry JSONB;
  v_okr_details JSONB;
  v_objective_review JSONB;
  v_kr_reviews JSONB;
  v_kr_review JSONB;
  v_evaluations JSONB;
  v_scores JSONB;
  v_new_kr_review JSONB;
  v_new_objective_review JSONB;
  v_new_okr_details JSONB;
  v_new_period_reviews JSONB;
  v_new_node_reviews JSONB;
  v_new_sub_departments JSONB;
  v_latest_index INTEGER;
  v_separator INTEGER;
  v_expected_review_key TEXT;
  v_expected_kr_index INTEGER;
  v_period_year TEXT;
  v_period_quarter TEXT;
  v_period_week INTEGER;
  v_period_month INTEGER;
  v_nested_okr_count INTEGER;
  v_nested_kr_count INTEGER;
  v_next_evaluation TEXT;
  v_next_score INTEGER;
  v_owner_department_id TEXT;
  v_review_only BOOLEAN;
  v_log_id BIGINT;
  v_prior_status TEXT;
  v_prior_result JSONB;
  v_result JSONB;
  v_key TEXT;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) < 8 OR length(p_request_id) > 128
     OR p_task_id IS NULL OR btrim(p_task_id) = ''
      OR p_review_period_key IS NULL
      OR (p_review_period_key !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
          AND p_review_period_key !~ '^\d{4}-(0[1-9]|1[0-2])$'
          AND p_review_period_key !~ '^\d{4}-Q[1-4]$')
     OR p_review_key IS NULL OR btrim(p_review_key) = ''
     OR p_kr_index IS NULL OR p_kr_index < 0 OR p_kr_index > 100
     OR p_expected_row_version IS NULL OR p_expected_row_version < 0
     OR p_expected_department_row_version IS NULL OR p_expected_department_row_version < 0
     OR p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::JSONB THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘同步参数无效';
  END IF;
  IF v_current_id IS NULL THEN RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户'; END IF;
  IF NOT (p_changes ? 'task_review' OR p_changes ? 'task_review_score') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘同步必须包含 task_review 或 task_review_score';
  END IF;
  IF p_changes ? 'department_id' OR p_changes ? 'departmentId' OR p_changes ? 'aligned_kr_id' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘同步不能移动任务或修改 aligned_kr_id';
  END IF;
  v_review_only := (p_changes - 'task_review' - 'task_review_score') = '{}'::JSONB;
  FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
    IF v_key NOT IN ('title', 'status', 'priority', 'target_weeks', 'start_date', 'due_date', 'tags', 'participant_ids', 'approver_ids', 'plan', 'action', 'deliverable', 'task_review', 'task_review_score', 'owner_id') THEN
      RAISE EXCEPTION 'MCP_VALIDATION: changes 包含不允许的字段 %', v_key;
    END IF;
  END LOOP;
  IF p_changes ? 'task_review' AND length(p_changes->>'task_review') > 2000 THEN RAISE EXCEPTION 'MCP_VALIDATION: task_review 长度不能超过 2000'; END IF;
  IF p_changes ? 'task_review_score' AND ((p_changes->>'task_review_score') !~ '^\d+$' OR (p_changes->>'task_review_score')::INTEGER NOT BETWEEN 0 AND 100) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: task_review_score 必须在 0 到 100 之间';
  END IF;

  INSERT INTO public.mcp_write_log (user_id, tool_name, request_id)
  VALUES (v_current_id, 'commit_update_pad_task', p_request_id)
  ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
  RETURNING id INTO v_log_id;
  IF v_log_id IS NULL THEN
    SELECT status, result_summary INTO v_prior_status, v_prior_result FROM public.mcp_write_log
    WHERE user_id = v_current_id AND tool_name = 'commit_update_pad_task' AND request_id = p_request_id;
    IF v_prior_status = 'success' THEN RETURN jsonb_build_object('replayed', true, 'result', v_prior_result); END IF;
    RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
  END IF;

  SELECT * INTO v_old_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF v_old_task.id IS NULL THEN RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 任务不存在或当前账号无权修改'; END IF;
  SELECT * INTO v_node FROM public.mcp_department_tree_nodes() n WHERE n.node_id = v_old_task.department_id ORDER BY n.depth, n.root_id LIMIT 1;
  IF v_node.node_id IS NULL OR cardinality(v_node.node_path) < 2
     OR p_department_root_id IS DISTINCT FROM v_node.root_id
     OR p_department_node_path IS NULL
     OR p_department_node_path IS DISTINCT FROM v_node.node_path THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务不是可用的嵌套部门任务';
  END IF;
  IF NOT (public.is_admin() OR (
    (v_review_only AND public.has_menu_permission('okr-review', 'update'))
    OR (NOT v_review_only AND (public.has_menu_permission('task-center', 'update') OR public.has_menu_permission('execution', 'update')) AND public.current_user_can_manage_task(v_old_task.department_id, v_old_task.owner_id, v_old_task.participant_ids, v_old_task.approver_ids))
  ) AND public.current_user_can_edit_department_reviews(v_old_task.department_id)) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限修改任务或目标部门复盘';
  END IF;
  IF v_old_task.row_version <> p_expected_row_version THEN RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改'; END IF;
  IF v_old_task.target_weeks IS NULL OR NOT (v_old_task.target_weeks @> jsonb_build_array(p_review_period_key)) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: reviewPeriodKey 不是该任务的目标周次';
  END IF;
  v_separator := strpos(COALESCE(v_old_task.aligned_kr_id, ''), '-kr-');
  IF v_separator > 0 THEN
    v_expected_review_key := substr(v_old_task.aligned_kr_id, 1, v_separator - 1);
    BEGIN v_expected_kr_index := substr(v_old_task.aligned_kr_id, v_separator + 4)::INTEGER; EXCEPTION WHEN invalid_text_representation THEN v_expected_kr_index := -1; END;
  ELSE
    v_expected_review_key := '__task__:' || v_old_task.id; v_expected_kr_index := 0;
  END IF;
  IF p_review_key <> v_expected_review_key OR p_kr_index <> v_expected_kr_index THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘槽位与任务的 aligned_kr_id 不匹配';
  END IF;

  -- Nested OKRs live in the child node JSON, so validate the real KR count
  -- there before any review array expansion can occur.
  v_period_year := split_part(p_review_period_key, '-', 1);
  IF p_review_period_key ~ '-W' THEN
    v_period_week := split_part(p_review_period_key, 'W', 2)::INTEGER;
    v_period_quarter := CASE
      WHEN v_period_week <= 13 THEN 'Q1'
      WHEN v_period_week <= 26 THEN 'Q2'
      WHEN v_period_week <= 39 THEN 'Q3'
      ELSE 'Q4'
    END;
  ELSIF p_review_period_key ~ '-Q' THEN
    v_period_quarter := split_part(p_review_period_key, '-', 2);
  ELSE
    v_period_month := split_part(p_review_period_key, '-', 2)::INTEGER;
    v_period_quarter := 'Q' || (((v_period_month - 1) / 3) + 1)::TEXT;
  END IF;
  SELECT count(*)::INTEGER,
         min(kr_count)::INTEGER
    INTO v_nested_okr_count, v_nested_kr_count
  FROM (
    SELECT okr.value,
           CASE WHEN jsonb_typeof(okr.value->'keyResults') = 'array'
                THEN jsonb_array_length(okr.value->'keyResults') ELSE 0 END AS kr_count
    FROM public.mcp_department_tree_nodes() AS ancestor
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(ancestor.node->'okrs') = 'object'
           THEN ancestor.node->'okrs' ELSE '{}'::JSONB END
    ) AS year_entry(year_key, year_value)
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(year_entry.year_value) = 'object'
           THEN year_entry.year_value ELSE '{}'::JSONB END
    ) AS period_entry(period_key, period_value)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(period_entry.period_value) = 'array'
           THEN period_entry.period_value ELSE '[]'::JSONB END
    ) AS okr(value)
    WHERE ancestor.root_id = v_node.root_id
      AND cardinality(ancestor.node_path) <= cardinality(v_node.node_path)
      AND v_node.node_path[1:cardinality(ancestor.node_path)] = ancestor.node_path
      AND year_entry.year_key = v_period_year
      AND period_entry.period_key = v_period_quarter
      AND okr.value->>'id' = v_expected_review_key
  ) AS matching_okrs;
  IF v_nested_okr_count = 0 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘目标 OKR 不存在';
  END IF;
  IF v_nested_okr_count <> 1 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 复盘目标 OKR 不唯一';
  END IF;
  IF COALESCE(v_nested_kr_count, 0) > 101 OR p_kr_index >= COALESCE(v_nested_kr_count, 0) THEN
    RAISE EXCEPTION 'MCP_VALIDATION: KR 下标超出目标 OKR 的真实数量';
  END IF;
  IF p_changes ? 'owner_id' THEN
    SELECT department_id INTO v_owner_department_id FROM public.users WHERE id = p_changes->>'owner_id';
    IF NOT FOUND OR (public.is_manager() AND NOT public.is_admin() AND NOT public.mcp_current_user_manages_department_node(v_owner_department_id)) THEN
      RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 负责人不在授权部门树内';
    END IF;
  END IF;
  PERFORM public.mcp_validate_task_people(
    v_old_task.department_id,
    COALESCE(NULLIF(p_changes->>'owner_id', ''), v_old_task.owner_id),
    CASE WHEN p_changes ? 'participant_ids' THEN p_changes->'participant_ids' ELSE v_old_task.participant_ids END,
    CASE WHEN p_changes ? 'approver_ids' THEN p_changes->'approver_ids' ELSE v_old_task.approver_ids END
  );

  SELECT * INTO v_root FROM public.departments WHERE id = v_node.root_id FOR UPDATE;
  IF v_root.id IS NULL THEN RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department root is missing'; END IF;
  IF v_root.row_version <> p_expected_department_row_version THEN RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改'; END IF;
  v_node_value := public.mcp_jsonb_find_department_node(v_root.sub_departments, v_node.node_id);
  v_period_reviews := COALESCE(v_node_value->'reviews', '{}'::JSONB) -> p_review_period_key;
  IF jsonb_typeof(v_period_reviews) <> 'array' OR jsonb_array_length(v_period_reviews) = 0 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 目标复盘周期不存在，请先保存该周期复盘记录';
  END IF;
  v_latest_index := jsonb_array_length(v_period_reviews) - 1;
  v_entry := COALESCE(v_period_reviews -> v_latest_index, '{}'::JSONB);
  v_okr_details := CASE WHEN jsonb_typeof(v_entry->'okrDetails') = 'object' THEN v_entry->'okrDetails' ELSE '{}'::JSONB END;
  v_objective_review := CASE WHEN jsonb_typeof(v_okr_details->p_review_key) = 'object' THEN v_okr_details->p_review_key ELSE '{}'::JSONB END;
  v_kr_reviews := CASE WHEN jsonb_typeof(v_objective_review->'krReviews') = 'array' THEN v_objective_review->'krReviews' ELSE '[]'::JSONB END;
  IF jsonb_array_length(v_kr_reviews) <= p_kr_index THEN
    SELECT v_kr_reviews || jsonb_agg(jsonb_build_object('comment', '', 'progress', 0, 'status', 'on-track') ORDER BY slot_index) INTO v_kr_reviews
    FROM generate_series(jsonb_array_length(v_kr_reviews), p_kr_index) AS slot_index;
  END IF;
  v_kr_review := COALESCE(v_kr_reviews -> p_kr_index, '{}'::JSONB);
  v_evaluations := CASE WHEN jsonb_typeof(v_kr_review->'taskEvaluations') = 'object' THEN v_kr_review->'taskEvaluations' ELSE '{}'::JSONB END;
  v_scores := CASE WHEN jsonb_typeof(v_kr_review->'taskScores') = 'object' THEN v_kr_review->'taskScores' ELSE '{}'::JSONB END;
  v_next_evaluation := CASE WHEN p_changes ? 'task_review' THEN COALESCE(p_changes->>'task_review', '') ELSE COALESCE(v_old_task.task_review, '') END;
  v_next_score := CASE WHEN p_changes ? 'task_review_score' THEN (p_changes->>'task_review_score')::INTEGER ELSE COALESCE(v_old_task.task_review_score, 0) END;

  UPDATE public.tasks SET
    title = CASE WHEN p_changes ? 'title' THEN btrim(p_changes->>'title') ELSE v_old_task.title END,
    status = CASE WHEN p_changes ? 'status' THEN p_changes->>'status' ELSE v_old_task.status END,
    priority = CASE WHEN p_changes ? 'priority' THEN p_changes->>'priority' ELSE v_old_task.priority END,
    owner_id = CASE WHEN p_changes ? 'owner_id' THEN p_changes->>'owner_id' ELSE v_old_task.owner_id END,
    target_weeks = CASE WHEN p_changes ? 'target_weeks' THEN p_changes->'target_weeks' ELSE v_old_task.target_weeks END,
    start_date = CASE WHEN p_changes ? 'start_date' THEN NULLIF(p_changes->>'start_date', '')::BIGINT ELSE v_old_task.start_date END,
    due_date = CASE WHEN p_changes ? 'due_date' THEN NULLIF(p_changes->>'due_date', '')::BIGINT ELSE v_old_task.due_date END,
    tags = CASE WHEN p_changes ? 'tags' THEN p_changes->'tags' ELSE v_old_task.tags END,
    participant_ids = CASE WHEN p_changes ? 'participant_ids' THEN p_changes->'participant_ids' ELSE v_old_task.participant_ids END,
    approver_ids = CASE WHEN p_changes ? 'approver_ids' THEN p_changes->'approver_ids' ELSE v_old_task.approver_ids END,
    plan = CASE WHEN p_changes ? 'plan' THEN NULLIF(p_changes->>'plan', '') ELSE v_old_task.plan END,
    action = CASE WHEN p_changes ? 'action' THEN NULLIF(p_changes->>'action', '') ELSE v_old_task.action END,
    deliverable = CASE WHEN p_changes ? 'deliverable' THEN NULLIF(p_changes->>'deliverable', '') ELSE v_old_task.deliverable END,
    task_review = CASE WHEN p_changes ? 'task_review' THEN NULLIF(p_changes->>'task_review', '') ELSE v_old_task.task_review END,
    task_review_score = CASE WHEN p_changes ? 'task_review_score' THEN v_next_score ELSE v_old_task.task_review_score END,
    row_version = v_old_task.row_version + 1
  WHERE id = v_old_task.id AND row_version = p_expected_row_version RETURNING * INTO v_new_task;
  IF v_new_task.id IS NULL THEN RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 任务已被其他用户修改'; END IF;

  v_new_kr_review := jsonb_set(v_kr_review, ARRAY['taskEvaluations'], jsonb_set(v_evaluations, ARRAY[v_old_task.id], to_jsonb(v_next_evaluation), true), true);
  v_new_kr_review := jsonb_set(v_new_kr_review, ARRAY['taskScores'], jsonb_set(v_scores, ARRAY[v_old_task.id], to_jsonb(v_next_score), true), true);
  v_new_objective_review := jsonb_set(v_objective_review, ARRAY['krReviews'], jsonb_set(v_kr_reviews, ARRAY[p_kr_index::TEXT], v_new_kr_review, true), true);
  v_new_okr_details := jsonb_set(v_okr_details, ARRAY[p_review_key], v_new_objective_review, true);
  v_entry := jsonb_set(v_entry, ARRAY['okrDetails'], v_new_okr_details, true);
  v_new_period_reviews := jsonb_set(v_period_reviews, ARRAY[v_latest_index::TEXT], v_entry, true);
  v_new_node_reviews := jsonb_set(COALESCE(v_node_value->'reviews', '{}'::JSONB), ARRAY[p_review_period_key], v_new_period_reviews, true);
  v_new_sub_departments := public.mcp_jsonb_set_department_reviews(COALESCE(v_root.sub_departments, '[]'::JSONB), v_node.node_id, v_new_node_reviews);
  UPDATE public.departments SET sub_departments = v_new_sub_departments, row_version = v_root.row_version + 1
  WHERE id = v_root.id AND row_version = p_expected_department_row_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'MCP_VERSION_CONFLICT: 部门复盘已被其他用户修改'; END IF;

  v_result := jsonb_build_object('replayed', false,
    'task', jsonb_build_object('id', v_new_task.id, 'title', v_new_task.title, 'status', v_new_task.status, 'ownerId', v_new_task.owner_id, 'departmentId', v_new_task.department_id, 'taskReview', v_new_task.task_review, 'taskReviewScore', v_new_task.task_review_score, 'rowVersion', v_new_task.row_version),
    'reviewSync', jsonb_build_object('departmentId', v_node.node_id, 'departmentRootId', v_root.id, 'periodKey', p_review_period_key, 'reviewKey', p_review_key, 'krIndex', p_kr_index, 'evaluation', v_next_evaluation, 'score', v_next_score, 'rowVersion', v_root.row_version + 1),
    'rowVersion', v_new_task.row_version, 'departmentRowVersion', v_root.row_version + 1);
  INSERT INTO public.mcp_audit_log (user_id, tool_name, request_id, action, object_type, object_id, status, before_summary, after_summary)
  VALUES (v_current_id, 'commit_update_pad_task', p_request_id, 'update', 'task', v_old_task.id, 'success',
    jsonb_build_object('id', v_old_task.id, 'departmentId', v_node.node_id, 'rootId', v_root.id, 'rowVersion', v_old_task.row_version),
    jsonb_build_object('id', v_new_task.id, 'departmentId', v_node.node_id, 'rootId', v_root.id, 'rowVersion', v_new_task.row_version, 'departmentRowVersion', v_root.row_version + 1));
  UPDATE public.mcp_write_log SET status = 'success', result_summary = v_result, completed_at = public.audit_now_ms() WHERE id = v_log_id;
  RETURN v_result;
END;
$$;

-- Re-declare the scoped review-gap reader after the write helpers so nested
-- cards are read from the child node's reviews instead of a nonexistent root
-- row. DISTINCT ON keeps malformed historical duplicates from multiplying a
-- user's task list.
CREATE OR REPLACE FUNCTION public.mcp_get_weekly_review_gaps_scope_v2(
  p_week_id TEXT,
  p_department_id TEXT,
  p_scope TEXT DEFAULT 'auto',
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_scope JSONB := public.mcp_collect_department_scope_ids(p_department_id, p_scope);
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_offset INTEGER := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 1000);
  v_groups JSONB;
  v_total INTEGER;
BEGIN
  IF p_week_id IS NULL OR p_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid week';
  END IF;
  WITH scope_ids AS MATERIALIZED (
    SELECT value AS id FROM jsonb_array_elements_text(COALESCE(v_scope->'ids', '[]'::JSONB))
  ), visible_scope_ids AS MATERIALIZED (
    SELECT id FROM scope_ids WHERE public.mcp_current_user_can_see_department_node(id)
  ), ranked AS (
    SELECT DISTINCT ON (t.id)
      t.id AS task_id, t.title, t.status, t.updated_at,
      COALESCE(t.department_id, owner_user.department_id) AS task_department_id,
      COALESCE(task_node.node_name, task_root.name, owner_node.node_name) AS task_department_name,
      t.target_weeks, u.id AS user_id, u.name, u.role, u.department_id,
      COALESCE(owner_node.node_name, owner_department.name) AS department_name,
      COALESCE(t.task_review, '') AS task_review,
      card.state AS card_state, COALESCE(card.card_evaluation, '') AS card_evaluation, card.reason AS card_reason
    FROM public.tasks t
    JOIN public.users u ON u.id = t.owner_id
    LEFT JOIN public.users owner_user ON owner_user.id = t.owner_id
    LEFT JOIN public.mcp_department_tree_nodes() task_node ON task_node.node_id = COALESCE(t.department_id, owner_user.department_id)
    LEFT JOIN public.departments task_root ON task_root.id = task_node.root_id
    LEFT JOIN public.mcp_department_tree_nodes() owner_node ON owner_node.node_id = u.department_id
    LEFT JOIN public.departments owner_department ON owner_department.id = u.department_id
    JOIN scope_ids s ON s.id = COALESCE(t.department_id, owner_user.department_id)
    LEFT JOIN visible_scope_ids visible_scope ON visible_scope.id = s.id
    LEFT JOIN LATERAL (
      SELECT public.mcp_read_task_review_card(
        CASE WHEN task_node.node_id IS NOT NULL AND cardinality(task_node.node_path) > 1
          THEN COALESCE(task_node.node->'reviews', '{}'::JSONB)
          ELSE COALESCE(task_root.reviews, '{}'::JSONB)
        END,
        p_week_id, t.aligned_kr_id, t.id
      ) AS card_value
    ) AS raw_card ON TRUE
    LEFT JOIN LATERAL (
      SELECT raw_card.card_value->>'state' AS state,
        raw_card.card_value->>'cardEvaluation' AS card_evaluation,
        raw_card.card_value->>'reason' AS reason
    ) AS card ON TRUE
    WHERE jsonb_typeof(t.target_weeks) = 'array'
      AND t.target_weeks @> jsonb_build_array(p_week_id)
      AND (public.is_admin() OR t.created_by = public.current_user_id() OR t.owner_id = public.current_user_id()
        OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(public.current_user_id())
        OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(public.current_user_id())
        OR visible_scope.id IS NOT NULL)
    ORDER BY t.id, t.updated_at DESC
  ), gaps AS (
    SELECT * FROM ranked WHERE card_state IN ('missing', 'blank', 'invalid')
  ), grouped AS (
    SELECT user_id, name, role, department_id, department_name,
      jsonb_agg(jsonb_build_object('id', task_id, 'title', title, 'status', status,
        'department_id', task_department_id, 'department_name', task_department_name,
        'target_weeks', target_weeks, 'reviewState', card_state, 'reviewReason', card_reason,
        'taskReview', task_review, 'cardEvaluation', card_evaluation,
        'inconsistent', card_state = 'blank' AND btrim(task_review) <> '') ORDER BY updated_at DESC, task_id DESC) AS tasks
    FROM gaps GROUP BY user_id, name, role, department_id, department_name
  ), page AS (
    SELECT jsonb_build_object('user', jsonb_build_object('user_id', user_id, 'name', name, 'role', role,
      'department_id', department_id, 'department_name', department_name), 'tasks', tasks) AS item
    FROM grouped ORDER BY name OFFSET v_offset LIMIT v_limit
  )
  SELECT (SELECT count(*)::INTEGER FROM grouped), COALESCE((SELECT jsonb_agg(item) FROM page), '[]'::JSONB)
  INTO v_total, v_groups;
  RETURN jsonb_build_object('weekId', p_week_id, 'departmentId', p_department_id, 'scope', v_scope->>'scope',
    'groups', v_groups, 'total', v_total, 'limit', v_limit, 'offset', v_offset,
    'hasMore', v_offset + jsonb_array_length(v_groups) < v_total);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_collect_department_scope_ids(
  p_department_id TEXT,
  p_scope TEXT DEFAULT 'auto'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN public.mcp_resolve_department(NULL, p_scope, p_department_id);
END;
$$;

-- Name resolution accepts either the display name or username. The response
-- deliberately omits authentication internals and permission configuration.
CREATE OR REPLACE FUNCTION public.mcp_resolve_users_by_name(
  p_name TEXT,
  p_department_name TEXT DEFAULT NULL,
  p_purpose TEXT DEFAULT 'query'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_name TEXT := NULLIF(btrim(p_name), '');
  v_department_name TEXT := NULLIF(btrim(p_department_name), '');
  v_department_id TEXT;
  v_department_root_id TEXT;
  v_department_path TEXT[];
  v_department_has_children BOOLEAN := FALSE;
  v_rows JSONB;
  v_count INTEGER;
  v_department_count INTEGER;
BEGIN
  IF v_name IS NULL OR p_purpose NOT IN ('owner', 'participant', 'approver', 'query') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid identity reference';
  END IF;
  IF v_department_name IS NOT NULL THEN
    SELECT count(*)::INTEGER, min(n.node_id)
    INTO v_department_count, v_department_id
    FROM public.mcp_department_tree_nodes() AS n
    WHERE btrim(n.node_name) = v_department_name
      AND (p_purpose IN ('participant', 'approver') OR public.mcp_current_user_can_see_department_node(n.node_id));
    IF v_department_count = 0 THEN RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible'; END IF;
    IF v_department_count > 1 THEN
      RETURN jsonb_build_object('departmentAmbiguous', TRUE, 'candidates', (
        SELECT jsonb_agg(jsonb_build_object('id', n.node_id, 'name', n.node_name, 'parentId', n.parent_id, 'rootId', n.root_id) ORDER BY n.root_id, n.node_path)
        FROM public.mcp_department_tree_nodes() AS n
        WHERE btrim(n.node_name) = v_department_name
          AND (p_purpose IN ('participant', 'approver') OR public.mcp_current_user_can_see_department_node(n.node_id))
      ));
    END IF;
    SELECT n.root_id, n.node_path, EXISTS (
      SELECT 1 FROM public.mcp_department_tree_nodes() AS child
      WHERE child.root_id = n.root_id
        AND cardinality(child.node_path) > cardinality(n.node_path)
        AND child.node_path[1:cardinality(n.node_path)] = n.node_path
    )
    INTO v_department_root_id, v_department_path, v_department_has_children
    FROM public.mcp_department_tree_nodes() AS n
    WHERE n.node_id = v_department_id
    ORDER BY n.depth, n.root_id
    LIMIT 1;
  END IF;

  SELECT count(*)::INTEGER,
    COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', u.id, 'name', u.name, 'role', u.role,
      'department_id', u.department_id,
      'department_name', COALESCE(node.node_name, d.name)
    ) ORDER BY u.id), '[]'::JSONB)
  INTO v_count, v_rows
  FROM public.users u
  LEFT JOIN public.departments d ON d.id = u.department_id
  LEFT JOIN public.mcp_department_tree_nodes() AS node ON node.node_id = u.department_id
  WHERE (btrim(u.name) = v_name OR btrim(u.username) = v_name)
    AND (v_department_id IS NULL OR EXISTS (
      SELECT 1
      FROM public.mcp_department_tree_nodes() AS user_node
      WHERE user_node.node_id = u.department_id
        AND user_node.root_id = v_department_root_id
        AND (
          (NOT v_department_has_children AND user_node.node_id = v_department_id)
          OR (v_department_has_children
            AND cardinality(user_node.node_path) >= cardinality(v_department_path)
            AND user_node.node_path[1:cardinality(v_department_path)] = v_department_path)
        )
    ))
    AND (
      public.is_admin()
      OR p_purpose IN ('participant', 'approver')
      OR u.id = public.current_user_id()
      OR public.mcp_current_user_can_see_department_node(u.department_id)
    );
  IF v_count = 0 THEN RAISE EXCEPTION 'MCP_USER_NOT_FOUND: no visible exact match'; END IF;
  IF v_count > 1 THEN RAISE EXCEPTION 'MCP_USER_NAME_AMBIGUOUS: department required'; END IF;
  RETURN jsonb_build_object('user', v_rows->0);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_get_department_people(
  p_department_id TEXT,
  p_scope TEXT DEFAULT 'auto',
  p_limit INTEGER DEFAULT 50,
  p_cursor_name TEXT DEFAULT NULL,
  p_cursor_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_scope JSONB;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_items JSONB;
  v_has_more BOOLEAN;
BEGIN
  v_scope := public.mcp_collect_department_scope_ids(p_department_id, p_scope);
  WITH scope_ids AS MATERIALIZED (
    SELECT value AS id FROM jsonb_array_elements_text(COALESCE(v_scope->'ids', '[]'::JSONB))
  ), visible_scope_ids AS MATERIALIZED (
    SELECT id FROM scope_ids WHERE public.mcp_current_user_can_see_department_node(id)
  ), bounded AS (
    SELECT u.id, u.name, u.username, u.role, u.department_id,
      COALESCE(node.node_name, d.name) AS department_name
    FROM public.users u
    JOIN visible_scope_ids s ON s.id = u.department_id
    LEFT JOIN public.departments d ON d.id = u.department_id
    LEFT JOIN public.mcp_department_tree_nodes() AS node ON node.node_id = u.department_id
    WHERE (p_cursor_name IS NULL OR (u.name, u.id) > (p_cursor_name, COALESCE(p_cursor_id, '')))
    ORDER BY u.name, u.id
    LIMIT v_limit + 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name, 'username', username, 'role', role,
    'department_id', department_id, 'department_name', department_name
  ) ORDER BY name, id), '[]'::JSONB), count(*) > v_limit
  INTO v_items, v_has_more
  FROM bounded;
  IF v_has_more THEN v_items := v_items - (jsonb_array_length(v_items) - 1); END IF;
  RETURN jsonb_build_object('department', v_scope->'department', 'scope', v_scope->>'scope', 'people', v_items, 'hasMore', v_has_more);
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_get_department_tasks_page(
  p_department_id TEXT,
  p_scope TEXT DEFAULT 'auto',
  p_week_id TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_cursor_updated_at BIGINT DEFAULT NULL,
  p_cursor_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_scope JSONB;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_items JSONB;
  v_count INTEGER;
  v_total INTEGER := 0;
  v_has_more BOOLEAN := FALSE;
BEGIN
  IF p_week_id IS NOT NULL AND p_week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$' THEN
    RAISE EXCEPTION 'MCP_VALIDATION: weekId 无效';
  END IF;
  IF (p_cursor_updated_at IS NULL) <> (p_cursor_id IS NULL) OR length(COALESCE(p_query, '')) > 100 OR length(COALESCE(p_status, '')) > 64 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 部门任务分页参数无效';
  END IF;
  v_scope := public.mcp_collect_department_scope_ids(p_department_id, p_scope);
  WITH scope_ids AS MATERIALIZED (
    SELECT value AS id FROM jsonb_array_elements_text(COALESCE(v_scope->'ids', '[]'::JSONB))
  ), visible_scope_ids AS MATERIALIZED (
    SELECT id FROM scope_ids WHERE public.mcp_current_user_can_see_department_node(id)
  ), ranked AS (
    SELECT DISTINCT ON (t.id)
      t.id, t.created_by, t.title, t.status, t.priority, t.owner_id, t.department_id,
      t.aligned_kr_id, t.target_weeks, t.start_date, t.due_date, t.tags,
      t.participant_ids, t.approver_ids, t.updated_at, t.row_version,
      owner_user.name AS owner_name,
      COALESCE(node.node_name, department_row.name, owner_node.node_name) AS department_name,
      COALESCE(t.department_id, owner_user.department_id) AS resolved_department_id
    FROM public.tasks t
    LEFT JOIN public.users owner_user ON owner_user.id = t.owner_id
    LEFT JOIN public.departments department_row ON department_row.id = t.department_id
    LEFT JOIN public.mcp_department_tree_nodes() AS node ON node.node_id = t.department_id
    LEFT JOIN public.mcp_department_tree_nodes() AS owner_node ON owner_node.node_id = owner_user.department_id
    JOIN scope_ids s ON s.id = COALESCE(t.department_id, owner_user.department_id)
    LEFT JOIN visible_scope_ids visible_scope ON visible_scope.id = s.id
    WHERE (
      public.is_admin()
      OR t.created_by = public.current_user_id()
      OR t.owner_id = public.current_user_id()
      OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(public.current_user_id())
      OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(public.current_user_id())
      OR visible_scope.id IS NOT NULL
    )
      AND (p_week_id IS NULL OR COALESCE(t.target_weeks, '[]'::JSONB) @> jsonb_build_array(p_week_id))
      AND (p_status IS NULL OR t.status = p_status)
      AND (p_query IS NULL OR p_query = '' OR t.title ILIKE '%' || p_query || '%')
      AND (p_cursor_updated_at IS NULL OR t.updated_at < p_cursor_updated_at OR (t.updated_at = p_cursor_updated_at AND t.id < p_cursor_id))
    ORDER BY t.id, t.updated_at DESC
  ), counted AS (
    SELECT ranked.*, count(*) OVER ()::INTEGER AS total_count FROM ranked
  ), page AS (
    SELECT * FROM counted ORDER BY updated_at DESC, id DESC LIMIT v_limit + 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'created_by', created_by, 'title', title, 'status', status, 'priority', priority,
    'owner_id', owner_id, 'owner_name', owner_name, 'department_id', resolved_department_id,
    'department_name', department_name, 'aligned_kr_id', aligned_kr_id,
    'target_weeks', COALESCE(target_weeks, '[]'::JSONB), 'start_date', start_date, 'due_date', due_date,
    'tags', COALESCE(tags, '[]'::JSONB), 'participant_ids', COALESCE(participant_ids, '[]'::JSONB),
    'approver_ids', COALESCE(approver_ids, '[]'::JSONB), 'updated_at', updated_at, 'row_version', row_version
  ) ORDER BY updated_at DESC, id DESC), '[]'::JSONB), count(*)::INTEGER, COALESCE(max(total_count), 0)
  INTO v_items, v_count, v_total FROM page;
  v_has_more := v_count > v_limit;
  IF v_has_more THEN
    v_items := v_items - (v_count - 1);
    v_count := v_limit;
  END IF;
  RETURN jsonb_build_object(
    'department', v_scope->'department', 'scope', v_scope->>'scope', 'items', v_items,
    'total', v_total, 'hasMore', v_has_more,
    'nextCursor', CASE WHEN jsonb_array_length(v_items) > 0 AND v_has_more THEN
      jsonb_build_object('updatedAt', (v_items->(jsonb_array_length(v_items)-1)->>'updated_at')::BIGINT, 'id', v_items->(jsonb_array_length(v_items)-1)->>'id')
      ELSE NULL END,
    'truncated', FALSE
  );
END;
$$;

-- Web endpoint variant keeps the old signature untouched and adds scope as an
-- optional argument. Exact leaf reads stay as cheap as the old indexed query.
CREATE OR REPLACE FUNCTION public.web_get_visible_tasks_scope_v2(
  p_department_id TEXT,
  p_week_ids TEXT[],
  p_limit INTEGER DEFAULT 2000,
  p_scope TEXT DEFAULT 'auto'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_scope JSONB;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 2000);
  v_items JSONB;
  v_count INTEGER;
BEGIN
  IF p_week_ids IS NULL OR cardinality(p_week_ids) = 0 OR cardinality(p_week_ids) > 53
    OR EXISTS (SELECT 1 FROM unnest(p_week_ids) week_id WHERE week_id IS NULL OR week_id !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务范围参数无效';
  END IF;
  v_scope := public.mcp_collect_department_scope_ids(p_department_id, p_scope);
  WITH scope_ids AS MATERIALIZED (
    SELECT value AS id FROM jsonb_array_elements_text(COALESCE(v_scope->'ids', '[]'::JSONB))
  ), visible_scope_ids AS MATERIALIZED (
    SELECT id FROM scope_ids WHERE public.mcp_current_user_can_see_department_node(id)
  ), bounded AS (
    SELECT DISTINCT ON (t.id) t.*,
      COALESCE(t.department_id, owner_user.department_id) AS resolved_department_id
    FROM public.tasks t
    LEFT JOIN public.users owner_user ON owner_user.id = t.owner_id
    JOIN scope_ids s ON s.id = COALESCE(t.department_id, owner_user.department_id)
    LEFT JOIN visible_scope_ids visible_scope ON visible_scope.id = s.id
    WHERE COALESCE(t.target_weeks, '[]'::JSONB) ?| p_week_ids
      AND (public.is_admin() OR t.created_by = public.current_user_id() OR t.owner_id = public.current_user_id()
        OR COALESCE(t.participant_ids, '[]'::JSONB) @> jsonb_build_array(public.current_user_id())
        OR COALESCE(t.approver_ids, '[]'::JSONB) @> jsonb_build_array(public.current_user_id())
        OR visible_scope.id IS NOT NULL)
    ORDER BY t.id, t.updated_at DESC
  ), page AS (
    SELECT * FROM bounded ORDER BY updated_at DESC, id DESC LIMIT v_limit + 1
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.updated_at DESC, page.id DESC), '[]'::JSONB), count(*)::INTEGER
  INTO v_items, v_count FROM page;
  IF v_count > v_limit THEN v_items := v_items - (v_count - 1); END IF;
  RETURN jsonb_build_object('items', v_items, 'truncated', v_count > v_limit, 'totalReturned', LEAST(v_count, v_limit), 'scope', v_scope->>'scope');
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_get_readiness()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'status', CASE WHEN (
      to_regprocedure('public.mcp_get_personal_workbench_page(integer,bigint,text,text,bigint,text,text,bigint,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_visible_tasks_page(integer,bigint,text,text,text,text,text)') IS NOT NULL
      AND to_regprocedure('public.web_get_visible_tasks_full(integer)') IS NOT NULL
      AND to_regprocedure('public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_resolve_department(text,text,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_department_people(text,text,integer,text,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_department_tasks_page(text,text,text,text,text,integer,bigint,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_create_pad_task_scoped(jsonb,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_update_pad_task_with_review_sync_scoped(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])') IS NOT NULL
      AND to_regprocedure('public.web_get_visible_tasks_scope_v2(text,text[],integer,text)') IS NOT NULL
    ) THEN 'ready' ELSE 'degraded' END,
    'migrationVersion', '2026-08-29',
    'personalWorkbenchRpc', to_regprocedure('public.mcp_get_personal_workbench_page(integer,bigint,text,text,bigint,text,text,bigint,text)') IS NOT NULL,
    'visibleTasksRpc', to_regprocedure('public.mcp_get_visible_tasks_page(integer,bigint,text,text,text,text,text)') IS NOT NULL,
    'webTaskFullRpc', to_regprocedure('public.web_get_visible_tasks_full(integer)') IS NOT NULL,
    'reviewSyncRpc', to_regprocedure('public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)') IS NOT NULL,
    'departmentResolveRpc', to_regprocedure('public.mcp_resolve_department(text,text,text)') IS NOT NULL,
    'departmentPeopleRpc', to_regprocedure('public.mcp_get_department_people(text,text,integer,text,text)') IS NOT NULL,
    'departmentTasksRpc', to_regprocedure('public.mcp_get_department_tasks_page(text,text,text,text,text,integer,bigint,text)') IS NOT NULL,
    'scopedCreateRpc', to_regprocedure('public.mcp_create_pad_task_scoped(jsonb,text)') IS NOT NULL,
    'scopedReviewSyncRpc', to_regprocedure('public.mcp_update_pad_task_with_review_sync_scoped(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])') IS NOT NULL,
    'webTaskScopeV2Rpc', to_regprocedure('public.web_get_visible_tasks_scope_v2(text,text[],integer,text)') IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.mcp_nested_department_children(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_department_tree_nodes() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_current_user_manages_department_node(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_current_user_can_see_department_node(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_validate_task_people(TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_resolve_department(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_collect_department_scope_ids(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_department_review_context(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_jsonb_find_department_node(JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_jsonb_set_department_reviews(JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_jsonb_contains_task_review_fields(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_resolve_users_by_name(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_department_people(TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_department_tasks_page(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_department_okrs_scope_v2(TEXT, TEXT, INTEGER, TEXT, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_weekly_review_gaps_scope_v2(TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_create_pad_task_scoped(JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_scoped(TEXT, JSONB, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_user_can_edit_department_reviews(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_save_review_record_scoped(TEXT, TEXT, JSONB, BIGINT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_update_pad_task_with_review_sync_scoped(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.web_get_visible_tasks_scope_v2(TEXT, TEXT[], INTEGER, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_readiness() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_resolve_department(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_collect_department_scope_ids(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_department_review_context(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_resolve_users_by_name(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_department_people(TEXT, TEXT, INTEGER, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_department_tasks_page(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_department_okrs_scope_v2(TEXT, TEXT, INTEGER, TEXT, BOOLEAN, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_weekly_review_gaps_scope_v2(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_create_pad_task_scoped(JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task_scoped(TEXT, JSONB, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_save_review_record_scoped(TEXT, TEXT, JSONB, BIGINT, TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_update_pad_task_with_review_sync_scoped(TEXT, JSONB, TEXT, TEXT, INTEGER, BIGINT, BIGINT, TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.web_get_visible_tasks_scope_v2(TEXT, TEXT[], INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_readiness() TO anon, authenticated;

-- L2 rollback (manual and approved only): revoke the grants above and drop
-- only the functions introduced by this migration. Business rows and ledger
-- history must remain intact.
-- REVOKE EXECUTE ON FUNCTION public.mcp_resolve_department(TEXT, TEXT, TEXT) FROM authenticated;
-- DROP FUNCTION public.mcp_resolve_department(TEXT, TEXT, TEXT);
-- DROP FUNCTION public.mcp_collect_department_scope_ids(TEXT, TEXT);
-- DROP FUNCTION public.mcp_get_department_people(TEXT, TEXT, INTEGER, TEXT, TEXT);
-- DROP FUNCTION public.mcp_get_department_tasks_page(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BIGINT, TEXT);
-- DROP FUNCTION public.web_get_visible_tasks_scope_v2(TEXT, TEXT[], INTEGER, TEXT);
-- Restore the 2026-08-28 mcp_get_readiness() definition when rolling back the application release.

COMMIT;
