-- Fix task visibility for nested departments stored in departments.sub_departments.
--
-- Context:
-- Department OKRs may live only on a parent department, while employees in nested
-- departments create tasks linked to the parent department OKR/KR. Those tasks
-- still carry the nested department_id. The previous visible task RPC only
-- joined against root rows from public.departments, so manager visibility for
-- nested department tasks could fall back to only personal involvement.
--
-- This expands the department id list and lets visibility inherited from a
-- visible parent flow to its nested departments. This matches the current
-- business rule that departments under the same parent are treated as one
-- department for OKR execution visibility.

CREATE OR REPLACE FUNCTION public.get_current_user_visible_task_ids()
RETURNS TABLE(id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_current_user_id TEXT;
  v_is_admin BOOLEAN;
BEGIN
  IF auth.uid() IS NULL AND public.current_auth_username() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated, cannot read tasks';
  END IF;

  v_current_user_id := public.current_user_id();
  v_is_admin := public.is_admin();

  IF v_is_admin THEN
    RETURN QUERY
    SELECT task_row.id
    FROM public.tasks task_row;
    RETURN;
  END IF;

  IF v_current_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE department_tree AS (
    SELECT
      department_row.id,
      COALESCE(department_row.sub_departments, '[]'::jsonb) AS sub_departments,
      public.current_user_has_department_visibility(department_row.id) AS is_visible
    FROM public.departments department_row

    UNION ALL

    SELECT
      child.value->>'id' AS id,
      COALESCE(child.value->'subDepartments', '[]'::jsonb) AS sub_departments,
      parent.is_visible
        OR public.current_user_has_department_visibility(child.value->>'id') AS is_visible
    FROM department_tree parent
    CROSS JOIN LATERAL jsonb_array_elements(parent.sub_departments) AS child(value)
    WHERE child.value->>'id' IS NOT NULL
  ),
  visible_departments AS (
    SELECT department_tree.id
    FROM department_tree
    WHERE department_tree.is_visible
  )
  SELECT DISTINCT task_row.id
  FROM public.tasks task_row
  LEFT JOIN public.users owner_user
    ON task_row.department_id IS NULL
   AND owner_user.id = task_row.owner_id
  LEFT JOIN visible_departments visible_department
    ON visible_department.id = COALESCE(task_row.department_id, owner_user.department_id)
  WHERE task_row.created_by = v_current_user_id
     OR task_row.owner_id = v_current_user_id
     OR COALESCE(task_row.participant_ids, '[]'::jsonb) @> jsonb_build_array(v_current_user_id)
     OR COALESCE(task_row.approver_ids, '[]'::jsonb) @> jsonb_build_array(v_current_user_id)
     OR visible_department.id IS NOT NULL;
END;
$$;
