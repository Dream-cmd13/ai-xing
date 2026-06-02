-- Hotfix: enforce task creation scope by role.
-- Rules:
-- 1. Admin can choose any owner and department.
-- 2. Manager can only create tasks for users in the manager's own department.
-- 3. Employee can only create tasks for self.
-- 4. Non-admin department must equal current user's department on create.

CREATE OR REPLACE FUNCTION public.enforce_task_owner_scope()
RETURNS TRIGGER AS $$
DECLARE
  current_id TEXT;
  current_department_id TEXT;
  owner_department_id TEXT;
BEGIN
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  current_id := public.current_user_id();
  current_department_id := public.current_user_department_id();

  IF TG_OP = 'INSERT' THEN
    IF NEW.department_id IS DISTINCT FROM current_department_id THEN
      RAISE EXCEPTION '非管理员创建任务时所属部门必须是当前用户所在部门';
    END IF;

    IF public.is_manager() THEN
      SELECT department_id
      INTO owner_department_id
      FROM public.users
      WHERE id = NEW.owner_id;

      IF owner_department_id IS DISTINCT FROM current_department_id THEN
        RAISE EXCEPTION '部门长只能将任务负责人设置为本部门成员';
      END IF;
    ELSIF NEW.owner_id IS DISTINCT FROM current_id THEN
      RAISE EXCEPTION '普通员工只能将自己设为任务负责人';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
      RAISE EXCEPTION '非管理员不能修改任务负责人';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS enforce_task_owner_scope_on_tasks ON public.tasks;
CREATE TRIGGER enforce_task_owner_scope_on_tasks
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_task_owner_scope();
