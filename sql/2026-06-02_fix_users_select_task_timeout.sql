-- Hotfix: avoid login/bootstrap timeouts caused by task visibility checks in users_select.
-- Task pages load cross-department task-related users through scoped task-user RPCs.

BEGIN;

DROP POLICY IF EXISTS users_select ON public.users;

CREATE POLICY users_select ON public.users FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR public.is_manager()
    OR public.has_menu_permission('user', 'view')
    OR public.has_menu_permission('menu-permissions', 'view')
    OR auth_id = auth.uid()
    OR lower(username) = public.current_auth_username()
    OR department_id = public.current_user_department_id()
  );

CREATE OR REPLACE FUNCTION public.get_current_user_task_users_for_tasks(
  p_task_ids TEXT[]
)
RETURNS TABLE (
  id TEXT,
  auth_id UUID,
  username TEXT,
  name TEXT,
  role TEXT,
  department_id TEXT,
  pad_permissions JSONB,
  reviews JSONB,
  system_role_ids JSONB,
  custom_permissions JSONB,
  updated_at BIGINT,
  row_version BIGINT
) AS $$
BEGIN
  RETURN QUERY
  WITH visible_tasks AS (
    SELECT task_row.id,
           task_row.department_id,
           task_row.created_by,
           task_row.owner_id,
           task_row.participant_ids,
           task_row.approver_ids
    FROM public.tasks task_row
    WHERE task_row.id = ANY(COALESCE(p_task_ids, ARRAY[]::TEXT[]))
      AND public.current_user_can_view_task(
        task_row.department_id,
        task_row.created_by,
        task_row.owner_id,
        task_row.participant_ids,
        task_row.approver_ids
      )
  ),
  related_user_ids AS (
    SELECT visible_tasks.created_by AS user_id
    FROM visible_tasks
    WHERE visible_tasks.created_by IS NOT NULL
    UNION
    SELECT visible_tasks.owner_id AS user_id
    FROM visible_tasks
    WHERE visible_tasks.owner_id IS NOT NULL
    UNION
    SELECT participant_value.value AS user_id
    FROM visible_tasks
    CROSS JOIN LATERAL public.jsonb_text_values(COALESCE(visible_tasks.participant_ids, '[]'::jsonb)) AS participant_value(value)
    UNION
    SELECT approver_value.value AS user_id
    FROM visible_tasks
    CROSS JOIN LATERAL public.jsonb_text_values(COALESCE(visible_tasks.approver_ids, '[]'::jsonb)) AS approver_value(value)
  )
  SELECT DISTINCT
    user_row.id,
    user_row.auth_id,
    user_row.username,
    user_row.name,
    user_row.role,
    user_row.department_id,
    user_row.pad_permissions,
    user_row.reviews,
    user_row.system_role_ids,
    user_row.custom_permissions,
    user_row.updated_at,
    user_row.row_version
  FROM public.users user_row
  JOIN related_user_ids related_user ON related_user.user_id = user_row.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMIT;
