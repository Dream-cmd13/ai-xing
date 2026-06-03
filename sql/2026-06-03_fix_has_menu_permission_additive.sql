-- Hotfix: keep database menu permission checks additive across personal permissions
-- and assigned system-role permissions.
--
-- Before this fix, if custom_permissions contained a menu entry, the function returned
-- that personal value immediately. A user with role update permission could therefore
-- be denied at save time when their personal permission for the same menu omitted or
-- disabled the action.

CREATE OR REPLACE FUNCTION public.has_menu_permission(
  p_menu_id TEXT,
  p_action TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  user_record RECORD;
  custom_perm JSONB;
  custom_allowed BOOLEAN := false;
  role_allowed BOOLEAN := false;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  SELECT custom_permissions, system_role_ids
  INTO user_record
  FROM public.users
  WHERE auth_id = auth.uid()
     OR lower(username) = public.current_auth_username()
  ORDER BY CASE WHEN auth_id = auth.uid() THEN 0 ELSE 1 END
  LIMIT 1;

  IF user_record IS NULL THEN
    RETURN false;
  END IF;

  IF user_record.custom_permissions IS NOT NULL
     AND jsonb_typeof(user_record.custom_permissions) = 'object'
     AND user_record.custom_permissions ? p_menu_id THEN
    custom_perm := user_record.custom_permissions -> p_menu_id;
    custom_allowed := COALESCE((custom_perm ->> p_action)::BOOLEAN, false);
  END IF;

  SELECT COALESCE(BOOL_OR(COALESCE((sr.permissions -> p_menu_id ->> p_action)::BOOLEAN, false)), false)
  INTO role_allowed
  FROM public.jsonb_text_values(user_record.system_role_ids) AS role_ids(value)
  JOIN public.system_roles sr ON sr.id = role_ids.value
  WHERE user_record.system_role_ids IS NOT NULL
    AND sr.permissions IS NOT NULL
    AND sr.permissions ? p_menu_id;

  RETURN custom_allowed OR role_allowed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
