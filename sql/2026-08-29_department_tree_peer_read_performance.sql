-- Avoid resolving manager identities for the common same-root read check.
-- Write authorization continues to use the manager-aware department tree.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_department_tree_paths()
RETURNS TABLE (
  root_id TEXT,
  node_id TEXT,
  node_path TEXT[]
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH RECURSIVE tree AS (
    SELECT
      d.id AS root_id,
      d.id AS node_id,
      0 AS depth,
      ARRAY[d.id]::TEXT[] AS node_path,
      jsonb_build_object(
        'id', d.id,
        'subDepartments', COALESCE(d.sub_departments, '[]'::JSONB)
      ) AS node
    FROM public.departments d
    WHERE NULLIF(btrim(d.id), '') IS NOT NULL

    UNION ALL

    SELECT
      tree.root_id,
      child.value->>'id',
      tree.depth + 1,
      tree.node_path || (child.value->>'id'),
      child.value
    FROM tree
    CROSS JOIN LATERAL jsonb_array_elements(
      public.mcp_nested_department_children(tree.node)
    ) AS child(value)
    WHERE tree.depth < 100
      AND jsonb_typeof(child.value) = 'object'
      AND NULLIF(btrim(child.value->>'id'), '') IS NOT NULL
      AND NOT ((child.value->>'id') = ANY(tree.node_path))
  )
  SELECT DISTINCT ON (tree.node_id)
    tree.root_id,
    tree.node_id,
    tree.node_path
  FROM tree
  WHERE NULLIF(btrim(tree.node_id), '') IS NOT NULL
  ORDER BY tree.node_id, tree.depth, tree.root_id;
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
  v_current_root_id TEXT;
  v_target_root_id TEXT;
BEGIN
  IF public.is_admin() THEN RETURN TRUE; END IF;
  IF v_current_id IS NULL OR p_target_id IS NULL OR btrim(p_target_id) = '' THEN
    RETURN FALSE;
  END IF;
  IF p_target_id = v_current_department_id THEN
    RETURN TRUE;
  END IF;

  WITH paths AS MATERIALIZED (
    SELECT root_id, node_id
    FROM public.mcp_department_tree_paths()
  )
  SELECT current_node.root_id, target_node.root_id
  INTO v_current_root_id, v_target_root_id
  FROM paths current_node
  CROSS JOIN paths target_node
  WHERE current_node.node_id = v_current_department_id
    AND target_node.node_id = p_target_id
  LIMIT 1;

  IF v_current_root_id IS NOT NULL
     AND v_target_root_id IS NOT NULL
     AND v_current_root_id = v_target_root_id THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.jsonb_text_values(COALESCE(v_permissions, '[]'::JSONB)) permitted
    WHERE permitted.value = p_target_id
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN public.mcp_current_user_manages_department_node(p_target_id);
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_department_tree_paths()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_current_user_can_see_department_node(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_current_user_can_see_department_node(TEXT) TO authenticated;

-- Manual rollback: restore mcp_current_user_can_see_department_node from the
-- peer-read visibility migration, then drop mcp_department_tree_paths().

COMMIT;
