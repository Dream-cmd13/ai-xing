-- Align the legacy task owner trigger with recursive manager authorization.
-- Employee create and owner-change restrictions remain unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_task_owner_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_id TEXT := public.current_user_id();
  current_department_id TEXT := public.current_user_department_id();
  owner_department_id TEXT;
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF current_id IS NULL THEN
    RAISE EXCEPTION '未识别当前登录用户，无法保存任务';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT department_id
    INTO owner_department_id
    FROM public.users
    WHERE id = NEW.owner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '任务负责人不存在';
    END IF;

    IF public.is_manager() THEN
      IF NOT public.mcp_current_user_manages_department_node(NEW.department_id) THEN
        RAISE EXCEPTION '部门长只能在本人管理的部门树内创建任务';
      END IF;
      IF NOT public.mcp_current_user_manages_department_node(owner_department_id) THEN
        RAISE EXCEPTION '部门长只能将任务负责人设置为本人管理部门树内的成员';
      END IF;
    ELSE
      IF NEW.department_id IS DISTINCT FROM current_department_id THEN
        RAISE EXCEPTION '普通员工创建任务时所属部门必须是当前用户所在部门';
      END IF;
      IF NEW.owner_id IS DISTINCT FROM current_id THEN
        RAISE EXCEPTION '普通员工只能将自己设为任务负责人';
      END IF;
    END IF;

  ELSIF TG_OP = 'UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    SELECT department_id
    INTO owner_department_id
    FROM public.users
    WHERE id = NEW.owner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '任务负责人不存在';
    END IF;

    IF NOT (
      public.is_manager()
      AND public.mcp_current_user_manages_department_node(NEW.department_id)
      AND public.mcp_current_user_manages_department_node(owner_department_id)
    ) THEN
      RAISE EXCEPTION '仅部门长可在本人管理的部门树内修改任务负责人';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_task_owner_scope()
  FROM PUBLIC, anon, authenticated, service_role;

-- Manual rollback: restore enforce_task_owner_scope() from 00_one_click_schema.sql.

COMMIT;
