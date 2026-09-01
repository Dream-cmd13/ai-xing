-- Follow-up for the already registered nested department migration.
-- Keep 2026-08-29_nested_department_scope.sql immutable after ledger adoption.
-- This migration only replaces permission and department-resolution helpers.

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

  -- One materialized tree is shared by the current node, target node,
  -- explicitly permitted nodes and manager roots. This keeps repeated RLS and
  -- RPC checks bounded without widening a child user's branch.
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
    WHERE (
      EXISTS (
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
  v_current_department_id TEXT := public.current_user_department_id();
  v_current_path TEXT[];
  v_target_path TEXT[];
  v_target_is_ancestor BOOLEAN := FALSE;
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

  -- A child employee can read an ancestor node, but its default and explicit
  -- subtree lookup must remain exact so sibling branches are never exposed.
  WITH nodes AS MATERIALIZED (
    SELECT node_id, node_path
    FROM public.mcp_department_tree_nodes()
  )
  SELECT current_node.node_path, target_node.node_path
  INTO v_current_path, v_target_path
  FROM nodes current_node
  JOIN nodes target_node ON target_node.node_id = v_department->>'id'
  WHERE current_node.node_id = v_current_department_id
  ORDER BY cardinality(current_node.node_path), cardinality(target_node.node_path)
  LIMIT 1;

  v_target_is_ancestor := v_current_path IS NOT NULL
    AND v_target_path IS NOT NULL
    AND cardinality(v_current_path) > cardinality(v_target_path)
    AND v_current_path[1:cardinality(v_target_path)] = v_target_path;
  IF v_target_is_ancestor
     AND NOT public.mcp_current_user_manages_department_node(v_department->>'id') THEN
    v_scope := 'exact';
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

REVOKE ALL ON FUNCTION public.mcp_current_user_can_see_department_node(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_resolve_department(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_current_user_can_see_department_node(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_resolve_department(TEXT, TEXT, TEXT) TO authenticated;

COMMIT;
