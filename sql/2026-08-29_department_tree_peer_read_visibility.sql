-- Share read visibility across one top-level department tree while preserving
-- the branch-based authorization used by task and review writes.

BEGIN;

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
  v_is_manager BOOLEAN := public.is_manager();
BEGIN
  IF public.is_admin() THEN RETURN TRUE; END IF;
  IF v_current_id IS NULL OR p_target_id IS NULL OR btrim(p_target_id) = '' THEN
    RETURN FALSE;
  END IF;
  IF p_target_id = v_current_department_id THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    WITH nodes AS MATERIALIZED (
      SELECT node_id, root_id, node_path, manager_user_id
      FROM public.mcp_department_tree_nodes()
    ), current_node AS (
      SELECT node_id, root_id
      FROM nodes
      WHERE node_id = v_current_department_id
      ORDER BY cardinality(node_path), node_id
      LIMIT 1
    ), target_node AS (
      SELECT node_id, root_id, node_path
      FROM nodes
      WHERE node_id = p_target_id
      ORDER BY cardinality(node_path), node_id
      LIMIT 1
    ), permitted AS (
      SELECT n.node_id
      FROM nodes n
      JOIN public.jsonb_text_values(COALESCE(v_permissions, '[]'::JSONB)) p
        ON p.value = n.node_id
    ), managed_roots AS (
      SELECT node_id, root_id, node_path
      FROM nodes
      WHERE v_is_manager
        AND (manager_user_id = v_current_id OR node_id = v_current_department_id)
    )
    SELECT 1
    FROM target_node target_node
    WHERE EXISTS (
      SELECT 1
      FROM current_node current_node
      WHERE target_node.root_id = current_node.root_id
    )
    OR EXISTS (
      SELECT 1
      FROM managed_roots managed
      WHERE target_node.root_id = managed.root_id
        AND cardinality(target_node.node_path) >= cardinality(managed.node_path)
        AND target_node.node_path[1:cardinality(managed.node_path)] = managed.node_path
    )
    OR EXISTS (
      SELECT 1
      FROM permitted
      WHERE permitted.node_id = target_node.node_id
    )
  );
END;
$$;

-- This predicate intentionally keeps the previous ancestor/descendant branch
-- boundary. Read visibility must never be reused as write authorization.
CREATE OR REPLACE FUNCTION public.mcp_current_user_can_write_department_node(p_target_id TEXT)
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
  v_is_manager BOOLEAN := public.is_manager();
BEGIN
  IF public.is_admin() THEN RETURN TRUE; END IF;
  IF v_current_id IS NULL OR p_target_id IS NULL OR btrim(p_target_id) = '' THEN
    RETURN FALSE;
  END IF;
  IF p_target_id = v_current_department_id THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    WITH nodes AS MATERIALIZED (
      SELECT node_id, root_id, node_path, manager_user_id
      FROM public.mcp_department_tree_nodes()
    ), current_node AS (
      SELECT node_id, root_id, node_path
      FROM nodes
      WHERE node_id = v_current_department_id
      ORDER BY cardinality(node_path), node_id
      LIMIT 1
    ), target_node AS (
      SELECT node_id, root_id, node_path
      FROM nodes
      WHERE node_id = p_target_id
      ORDER BY cardinality(node_path), node_id
      LIMIT 1
    ), permitted AS (
      SELECT n.node_id
      FROM nodes n
      JOIN public.jsonb_text_values(COALESCE(v_permissions, '[]'::JSONB)) p
        ON p.value = n.node_id
    ), managed_roots AS (
      SELECT node_id, root_id, node_path
      FROM nodes
      WHERE v_is_manager
        AND (manager_user_id = v_current_id OR node_id = v_current_department_id)
    )
    SELECT 1
    FROM target_node target_node
    WHERE EXISTS (
      SELECT 1
      FROM current_node current_node
      WHERE target_node.root_id = current_node.root_id
        AND (
          (
            cardinality(target_node.node_path) >= cardinality(current_node.node_path)
            AND target_node.node_path[1:cardinality(current_node.node_path)] = current_node.node_path
          )
          OR (
            cardinality(current_node.node_path) >= cardinality(target_node.node_path)
            AND current_node.node_path[1:cardinality(target_node.node_path)] = target_node.node_path
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM managed_roots managed
      WHERE target_node.root_id = managed.root_id
        AND cardinality(target_node.node_path) >= cardinality(managed.node_path)
        AND target_node.node_path[1:cardinality(managed.node_path)] = managed.node_path
    )
    OR EXISTS (
      SELECT 1
      FROM permitted
      WHERE permitted.node_id = target_node.node_id
    )
  );
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
    WITH nodes AS MATERIALIZED (
      SELECT * FROM public.mcp_department_tree_nodes()
    )
    SELECT jsonb_build_object(
      'id', n.node_id, 'name', n.node_name, 'parentId', n.parent_id, 'parentName', n.parent_name,
      'rootId', n.root_id, 'rootName', n.root_name, 'depth', n.depth,
      'path', n.node_path, 'namePath', n.name_path, 'hasChildren', EXISTS (
        SELECT 1 FROM nodes child
        WHERE child.root_id = n.root_id
          AND cardinality(child.node_path) > cardinality(n.node_path)
          AND child.node_path[1:cardinality(n.node_path)] = n.node_path
      ), 'managerUserId', n.manager_user_id, 'managerName', n.manager_name
    ) INTO v_department
    FROM nodes n
    WHERE n.node_id = v_id
      AND public.mcp_current_user_can_see_department_node(n.node_id)
    ORDER BY n.depth, n.root_id
    LIMIT 1;
    IF v_department IS NULL THEN
      RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible';
    END IF;
  ELSE
    WITH nodes AS MATERIALIZED (
      SELECT * FROM public.mcp_department_tree_nodes()
    )
    SELECT count(*)::INTEGER,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', n.node_id, 'name', n.node_name, 'parentId', n.parent_id, 'parentName', n.parent_name,
        'rootId', n.root_id, 'rootName', n.root_name, 'depth', n.depth,
        'path', n.node_path, 'namePath', n.name_path, 'hasChildren', EXISTS (
          SELECT 1 FROM nodes child
          WHERE child.root_id = n.root_id
            AND cardinality(child.node_path) > cardinality(n.node_path)
            AND child.node_path[1:cardinality(n.node_path)] = n.node_path
        ), 'managerUserId', n.manager_user_id, 'managerName', n.manager_name
      ) ORDER BY n.root_id, n.node_path), '[]'::JSONB)
    INTO v_count, v_candidates
    FROM nodes n
    WHERE btrim(n.node_name) = v_name
      AND public.mcp_current_user_can_see_department_node(n.node_id);
    IF v_count = 0 THEN
      RAISE EXCEPTION 'MCP_DEPARTMENT_NOT_FOUND: department is not visible';
    END IF;
    IF v_count > 1 THEN
      RETURN jsonb_build_object('ambiguous', TRUE, 'candidates', v_candidates);
    END IF;
    v_department := v_candidates->0;
  END IF;

  IF v_scope = 'auto' THEN
    v_scope := CASE WHEN COALESCE((v_department->>'hasChildren')::BOOLEAN, FALSE)
      THEN 'subtree' ELSE 'exact' END;
  END IF;

  RETURN jsonb_build_object(
    'department', v_department,
    'scope', v_scope,
    'ids', (
      SELECT COALESCE(jsonb_agg(n.node_id ORDER BY cardinality(n.node_path), n.node_id), '[]'::JSONB)
      FROM public.mcp_department_tree_nodes() AS n
      WHERE n.root_id = v_department->>'rootId'
        AND (
          (v_scope = 'exact' AND n.node_id = v_department->>'id')
          OR (v_scope = 'subtree'
            AND cardinality(n.node_path) >= jsonb_array_length(v_department->'path')
            AND n.node_path[1:jsonb_array_length(v_department->'path')]
              = ARRAY(SELECT jsonb_array_elements_text(v_department->'path')))
        )
    )
  );
END;
$$;

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
    OR (public.has_menu_permission('okr-review', 'update')
      AND public.mcp_current_user_can_write_department_node(p_department_id));
$$;

-- Preserve the existing create implementation and put the old branch boundary
-- in front of it. The internal implementation is not callable by API roles.
ALTER FUNCTION public.mcp_create_pad_task_scoped(JSONB, TEXT)
  RENAME TO mcp_create_pad_task_scoped_branch_impl_20260829;

REVOKE ALL ON FUNCTION public.mcp_create_pad_task_scoped_branch_impl_20260829(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.mcp_create_pad_task_scoped(
  p_task JSONB,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_id TEXT := public.current_user_id();
  v_department_id TEXT := COALESCE(
    NULLIF(btrim(COALESCE(p_task->>'department_id', '')), ''),
    public.current_user_department_id()
  );
BEGIN
  IF v_current_id IS NULL THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无法识别当前用户';
  END IF;
  IF NOT public.mcp_current_user_can_write_department_node(v_department_id) THEN
    RAISE EXCEPTION 'MCP_PERMISSION_DENIED: 无权限在目标部门创建任务';
  END IF;
  RETURN public.mcp_create_pad_task_scoped_branch_impl_20260829(p_task, p_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_current_user_can_write_department_node(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_current_user_can_see_department_node(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_resolve_department(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_user_can_edit_department_reviews(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_create_pad_task_scoped(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.mcp_current_user_can_see_department_node(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_resolve_department(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_create_pad_task_scoped(JSONB, TEXT) TO authenticated;

-- Manual rollback: drop the public create wrapper, rename the internal create
-- implementation to mcp_create_pad_task_scoped, restore the three replaced
-- helper definitions from the prior migration, and then restore grants.

COMMIT;
