-- Hotfix: task creation participant/approver candidates must not depend on the
-- narrowed users_select policy, which now intentionally returns a smaller set to
-- avoid login/bootstrap timeouts.
--
-- Use a dedicated SECURITY DEFINER RPC so task-capable users can fetch the full
-- task candidate user list without reopening global user-table visibility.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_task_candidate_users()
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
  SELECT
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
  ORDER BY user_row.name, user_row.username;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMIT;
