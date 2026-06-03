-- Standard audit fields rollout for all core tables.
-- Adds missing created_by / created_at / updated_by fields,
-- backfills historical rows, and switches write paths to database-managed audit metadata.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.processes ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.processes ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.processes ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE public.processes ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.strategy ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.strategy ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.strategy ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE public.strategy ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.system_roles ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.system_roles ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.system_roles ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE public.system_roles ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;

UPDATE public.processes AS process_row
SET created_by = COALESCE(process_row.created_by, owner_user.id)
FROM public.users AS owner_user
WHERE owner_user.name = process_row.owner
  AND process_row.created_by IS NULL;

UPDATE public.tasks
SET created_by = owner_id
WHERE created_by IS NULL;

UPDATE public.users
SET
  created_at = CASE
    WHEN COALESCE(created_at, 0) > 0 THEN created_at
    WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
    ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  END,
  updated_by = COALESCE(updated_by, created_by)
WHERE COALESCE(created_at, 0) = 0
   OR updated_by IS NULL;

UPDATE public.departments
SET
  created_at = CASE
    WHEN COALESCE(created_at, 0) > 0 THEN created_at
    WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
    ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  END,
  updated_by = COALESCE(updated_by, created_by)
WHERE COALESCE(created_at, 0) = 0
   OR updated_by IS NULL;

UPDATE public.processes
SET
  created_at = CASE
    WHEN COALESCE(created_at, 0) > 0 THEN created_at
    WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
    ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  END,
  updated_by = COALESCE(updated_by, created_by)
WHERE COALESCE(created_at, 0) = 0
   OR updated_by IS NULL;

UPDATE public.strategy
SET
  created_at = CASE
    WHEN COALESCE(created_at, 0) > 0 THEN created_at
    WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
    ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  END,
  updated_by = COALESCE(updated_by, created_by)
WHERE COALESCE(created_at, 0) = 0
   OR updated_by IS NULL;

UPDATE public.businesses
SET
  created_at = CASE
    WHEN COALESCE(created_at, 0) > 0 THEN created_at
    WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
    ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  END,
  updated_by = COALESCE(updated_by, created_by)
WHERE COALESCE(created_at, 0) = 0
   OR updated_by IS NULL;

UPDATE public.tasks
SET
  created_at = CASE
    WHEN COALESCE(created_at, 0) > 0 THEN created_at
    WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
    ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  END,
  updated_by = COALESCE(updated_by, created_by)
WHERE COALESCE(created_at, 0) = 0
   OR updated_by IS NULL;

UPDATE public.system_roles
SET
  created_at = CASE
    WHEN COALESCE(created_at, 0) > 0 THEN created_at
    WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
    ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  END,
  updated_by = COALESCE(updated_by, created_by)
WHERE COALESCE(created_at, 0) = 0
   OR updated_by IS NULL;

UPDATE public.settings
SET
  created_at = CASE
    WHEN COALESCE(created_at, 0) > 0 THEN created_at
    WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
    ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  END,
  updated_by = COALESCE(updated_by, created_by)
WHERE COALESCE(created_at, 0) = 0
   OR updated_by IS NULL;

CREATE OR REPLACE FUNCTION public.audit_now_ms()
RETURNS BIGINT AS $$
  SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
$$ LANGUAGE sql VOLATILE;

CREATE OR REPLACE FUNCTION public.audit_actor_user_id()
RETURNS TEXT AS $$
  SELECT public.current_user_id();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.apply_standard_audit_fields()
RETURNS TRIGGER AS $$
DECLARE
  actor_id TEXT;
  audit_now BIGINT;
BEGIN
  actor_id := public.audit_actor_user_id();
  audit_now := public.audit_now_ms();

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := audit_now;
    NEW.updated_at := audit_now;

    IF actor_id IS NOT NULL THEN
      NEW.created_by := actor_id;
      NEW.updated_by := actor_id;
    ELSE
      NEW.created_by := NULLIF(NEW.created_by, '');
      NEW.updated_by := COALESCE(NULLIF(NEW.updated_by, ''), NULLIF(NEW.created_by, ''));
    END IF;
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_at := COALESCE(NULLIF(OLD.created_at, 0), audit_now);
    NEW.updated_at := audit_now;

    IF actor_id IS NOT NULL THEN
      NEW.updated_by := actor_id;
    ELSE
      NEW.updated_by := COALESCE(OLD.updated_by, OLD.created_by);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE public.users ALTER COLUMN created_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.users ALTER COLUMN created_at SET DEFAULT public.audit_now_ms();
ALTER TABLE public.users ALTER COLUMN updated_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.users ALTER COLUMN updated_at SET DEFAULT public.audit_now_ms();

ALTER TABLE public.departments ALTER COLUMN created_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.departments ALTER COLUMN created_at SET DEFAULT public.audit_now_ms();
ALTER TABLE public.departments ALTER COLUMN updated_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.departments ALTER COLUMN updated_at SET DEFAULT public.audit_now_ms();

ALTER TABLE public.processes ALTER COLUMN created_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.processes ALTER COLUMN created_at SET DEFAULT public.audit_now_ms();
ALTER TABLE public.processes ALTER COLUMN updated_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.processes ALTER COLUMN updated_at SET DEFAULT public.audit_now_ms();

ALTER TABLE public.strategy ALTER COLUMN created_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.strategy ALTER COLUMN created_at SET DEFAULT public.audit_now_ms();
ALTER TABLE public.strategy ALTER COLUMN updated_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.strategy ALTER COLUMN updated_at SET DEFAULT public.audit_now_ms();

ALTER TABLE public.businesses ALTER COLUMN created_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.businesses ALTER COLUMN created_at SET DEFAULT public.audit_now_ms();
ALTER TABLE public.businesses ALTER COLUMN updated_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.businesses ALTER COLUMN updated_at SET DEFAULT public.audit_now_ms();

ALTER TABLE public.tasks ALTER COLUMN created_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.tasks ALTER COLUMN created_at SET DEFAULT public.audit_now_ms();
ALTER TABLE public.tasks ALTER COLUMN updated_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.tasks ALTER COLUMN updated_at SET DEFAULT public.audit_now_ms();

ALTER TABLE public.system_roles ALTER COLUMN created_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.system_roles ALTER COLUMN created_at SET DEFAULT public.audit_now_ms();
ALTER TABLE public.system_roles ALTER COLUMN updated_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.system_roles ALTER COLUMN updated_at SET DEFAULT public.audit_now_ms();

ALTER TABLE public.settings ALTER COLUMN created_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.settings ALTER COLUMN created_at SET DEFAULT public.audit_now_ms();
ALTER TABLE public.settings ALTER COLUMN updated_by SET DEFAULT public.audit_actor_user_id();
ALTER TABLE public.settings ALTER COLUMN updated_at SET DEFAULT public.audit_now_ms();

DROP TRIGGER IF EXISTS apply_standard_audit_fields_on_users ON public.users;
CREATE TRIGGER apply_standard_audit_fields_on_users
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.apply_standard_audit_fields();

DROP TRIGGER IF EXISTS apply_standard_audit_fields_on_departments ON public.departments;
CREATE TRIGGER apply_standard_audit_fields_on_departments
  BEFORE INSERT OR UPDATE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.apply_standard_audit_fields();

DROP TRIGGER IF EXISTS apply_standard_audit_fields_on_processes ON public.processes;
CREATE TRIGGER apply_standard_audit_fields_on_processes
  BEFORE INSERT OR UPDATE ON public.processes
  FOR EACH ROW EXECUTE FUNCTION public.apply_standard_audit_fields();

DROP TRIGGER IF EXISTS apply_standard_audit_fields_on_strategy ON public.strategy;
CREATE TRIGGER apply_standard_audit_fields_on_strategy
  BEFORE INSERT OR UPDATE ON public.strategy
  FOR EACH ROW EXECUTE FUNCTION public.apply_standard_audit_fields();

DROP TRIGGER IF EXISTS apply_standard_audit_fields_on_businesses ON public.businesses;
CREATE TRIGGER apply_standard_audit_fields_on_businesses
  BEFORE INSERT OR UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.apply_standard_audit_fields();

DROP TRIGGER IF EXISTS apply_standard_audit_fields_on_tasks ON public.tasks;
CREATE TRIGGER apply_standard_audit_fields_on_tasks
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.apply_standard_audit_fields();

DROP TRIGGER IF EXISTS apply_standard_audit_fields_on_system_roles ON public.system_roles;
CREATE TRIGGER apply_standard_audit_fields_on_system_roles
  BEFORE INSERT OR UPDATE ON public.system_roles
  FOR EACH ROW EXECUTE FUNCTION public.apply_standard_audit_fields();

DROP TRIGGER IF EXISTS apply_standard_audit_fields_on_settings ON public.settings;
CREATE TRIGGER apply_standard_audit_fields_on_settings
  BEFORE INSERT OR UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.apply_standard_audit_fields();

CREATE OR REPLACE FUNCTION public.save_departments_atomic(
  p_next_departments JSONB,
  p_previous_departments JSONB
)
RETURNS SETOF public.departments
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  next_item JSONB;
  previous_item JSONB;
  expected_row_version BIGINT;
  previous_snapshot JSONB;
  next_snapshot JSONB;
  current_id TEXT;
BEGIN
  current_id := public.current_user_id();

  IF current_id IS NULL THEN
    RAISE EXCEPTION '未识别当前登录用户，无法保存部门';
  END IF;

  IF NOT public.current_user_can_save_departments() THEN
    RAISE EXCEPTION '无权限保存部门';
  END IF;

  FOR previous_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_previous_departments, '[]'::jsonb))
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_next_departments, '[]'::jsonb)) AS next_values(value)
      WHERE next_values.value->>'id' = previous_item->>'id'
    ) THEN
      expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

      IF NOT public.is_admin() THEN
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(p_previous_departments, '[]'::jsonb)) AS managed_roots(value)
          WHERE public.current_user_can_manage_department_tree(managed_roots.value, current_id)
          AND public.find_department_in_tree(
            COALESCE(managed_roots.value->'subDepartments', '[]'::jsonb),
            previous_item->>'id'
          ) IS NOT NULL
        ) THEN
          RAISE EXCEPTION '仅管理员可删除顶层部门；部门长仅可删除自己负责部门树内的子部门';
        END IF;
      END IF;

      DELETE FROM public.departments
      WHERE id = previous_item->>'id'
        AND row_version = expected_row_version;

      IF NOT FOUND THEN
        RAISE EXCEPTION '部门已被其他人修改或删除，请刷新最新数据后再重试。';
      END IF;
    END IF;
  END LOOP;

  FOR next_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_next_departments, '[]'::jsonb))
  LOOP
    SELECT value
    INTO previous_item
    FROM jsonb_array_elements(COALESCE(p_previous_departments, '[]'::jsonb)) AS previous_values(value)
    WHERE previous_values.value->>'id' = next_item->>'id'
    LIMIT 1;

    IF previous_item IS NULL THEN
      IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only administrators can create root departments; users with organization create permission can create child departments only inside their own organization';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.departments
        WHERE id = next_item->>'id'
      ) THEN
        RAISE EXCEPTION '部门创建失败，可能是重复提交或记录已存在。';
      END IF;

      INSERT INTO public.departments (
        id,
        name,
        manager_name,
        manager_user_id,
        responsibilities,
        roles,
        role_members,
        attributes,
        sub_departments,
        okrs,
        reviews,
        row_version
      )
      VALUES (
        next_item->>'id',
        COALESCE(next_item->>'name', ''),
        COALESCE(next_item->>'managerName', ''),
        NULLIF(next_item->>'managerUserId', ''),
        COALESCE(next_item->>'responsibilities', ''),
        COALESCE(next_item->'roles', '[]'::jsonb),
        COALESCE(next_item->'roleMembers', '{}'::jsonb),
        COALESCE(next_item->>'attributes', ''),
        COALESCE(next_item->'subDepartments', '[]'::jsonb),
        COALESCE(next_item->'okrs', '{}'::jsonb),
        COALESCE(next_item->'reviews', '{}'::jsonb),
        0
      );
    ELSE
      previous_snapshot := jsonb_strip_nulls(previous_item - 'rowVersion' - 'updatedAt');
      next_snapshot := jsonb_strip_nulls(next_item - 'rowVersion' - 'updatedAt');

      IF previous_snapshot IS DISTINCT FROM next_snapshot THEN
        IF NOT public.is_admin() THEN
          IF NOT public.current_user_can_manage_department_tree(previous_item, current_id)
             AND NOT (
               previous_item->>'id' = public.current_user_department_id()
               OR public.find_department_in_tree(
                 COALESCE(previous_item->'subDepartments', '[]'::jsonb),
                 public.current_user_department_id()
               ) IS NOT NULL
             ) THEN
            RAISE EXCEPTION '仅允许修改自己负责的部门';
          END IF;

          next_item := public.merge_department_subtree_for_manager(
            previous_item,
            next_item,
            current_id
          );

          next_snapshot := jsonb_strip_nulls(next_item - 'rowVersion' - 'updatedAt');
        END IF;

        IF previous_snapshot IS DISTINCT FROM next_snapshot THEN
          expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, (next_item->>'rowVersion')::BIGINT, 0);

          UPDATE public.departments
          SET
            name = COALESCE(next_item->>'name', ''),
            manager_name = CASE
              WHEN public.is_admin() OR public.has_menu_permission('org', 'update') THEN COALESCE(next_item->>'managerName', '')
              ELSE COALESCE(previous_item->>'managerName', '')
            END,
            manager_user_id = CASE
              WHEN public.is_admin() OR public.has_menu_permission('org', 'update') THEN NULLIF(next_item->>'managerUserId', '')
              ELSE NULLIF(previous_item->>'managerUserId', '')
            END,
            responsibilities = COALESCE(next_item->>'responsibilities', ''),
            roles = COALESCE(next_item->'roles', '[]'::jsonb),
            role_members = COALESCE(next_item->'roleMembers', '{}'::jsonb),
            attributes = COALESCE(next_item->>'attributes', ''),
            sub_departments = COALESCE(next_item->'subDepartments', '[]'::jsonb),
            okrs = COALESCE(next_item->'okrs', '{}'::jsonb),
            reviews = COALESCE(next_item->'reviews', '{}'::jsonb),
            row_version = expected_row_version + 1
          WHERE id = next_item->>'id'
            AND row_version = expected_row_version;

          IF NOT FOUND THEN
            RAISE EXCEPTION '部门已被其他人修改，请刷新最新数据后再重试。';
          END IF;
        END IF;
      END IF;
    END IF;

    previous_item := NULL;
  END LOOP;

  RETURN QUERY
  SELECT *
  FROM public.departments d
  WHERE public.is_admin()
     OR public.has_menu_permission('org', 'view')
     OR public.current_user_has_department_visibility(d.id)
  ORDER BY id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_processes_atomic(
  p_next_processes JSONB,
  p_previous_processes JSONB
)
RETURNS SETOF public.processes
LANGUAGE plpgsql
AS $$
DECLARE
  next_item JSONB;
  previous_item JSONB;
  expected_row_version BIGINT;
  previous_snapshot JSONB;
  next_snapshot JSONB;
  current_id TEXT;
  current_department_id TEXT;
  target_department_id TEXT;
BEGIN
  current_id := public.current_user_id();
  current_department_id := public.current_user_department_id();

  IF current_id IS NULL THEN
    RAISE EXCEPTION '未识别当前登录用户，无法保存流程';
  END IF;

  FOR previous_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_previous_processes, '[]'::jsonb))
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_next_processes, '[]'::jsonb)) AS next_values(value)
      WHERE next_values.value->>'id' = previous_item->>'id'
    ) THEN
      expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

      DELETE FROM public.processes
      WHERE id = previous_item->>'id'
        AND row_version = expected_row_version;

      IF NOT FOUND THEN
        RAISE EXCEPTION '流程已被其他人修改或删除，请刷新最新数据后再重试。';
      END IF;
    END IF;
  END LOOP;

  FOR next_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_next_processes, '[]'::jsonb))
  LOOP
    SELECT value
    INTO previous_item
    FROM jsonb_array_elements(COALESCE(p_previous_processes, '[]'::jsonb)) AS previous_values(value)
    WHERE previous_values.value->>'id' = next_item->>'id'
    LIMIT 1;

    IF previous_item IS NULL THEN
      target_department_id := NULLIF(next_item->>'departmentId', '');

      IF EXISTS (
        SELECT 1
        FROM public.processes
        WHERE id = next_item->>'id'
      ) THEN
        RAISE EXCEPTION '流程创建失败，可能是重复提交或记录已存在。';
      END IF;

      INSERT INTO public.processes (
        id,
        department_id,
        name,
        category,
        level,
        version,
        is_active,
        type,
        owner,
        co_owner,
        objective,
        nodes,
        links,
        history,
        row_version
      )
      VALUES (
        next_item->>'id',
        CASE
          WHEN public.is_admin() THEN NULLIF(next_item->>'departmentId', '')
          WHEN public.is_manager() THEN target_department_id
          ELSE current_department_id
        END,
        COALESCE(next_item->>'name', ''),
        COALESCE(next_item->>'category', ''),
        COALESCE((next_item->>'level')::INTEGER, 1),
        COALESCE(next_item->>'version', 'Draft'),
        COALESCE((next_item->>'isActive')::BOOLEAN, false),
        COALESCE(next_item->>'type', 'main'),
        COALESCE(next_item->>'owner', ''),
        COALESCE(next_item->>'coOwner', ''),
        COALESCE(next_item->>'objective', ''),
        COALESCE(next_item->'nodes', '[]'::jsonb),
        COALESCE(next_item->'links', '[]'::jsonb),
        COALESCE(next_item->'history', '[]'::jsonb),
        0
      );
    ELSE
      previous_snapshot := jsonb_strip_nulls(previous_item - 'rowVersion' - 'updatedAt');
      next_snapshot := jsonb_strip_nulls(next_item - 'rowVersion' - 'updatedAt');

      IF previous_snapshot IS DISTINCT FROM next_snapshot THEN
        expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);
        target_department_id := COALESCE(NULLIF(next_item->>'departmentId', ''), NULLIF(previous_item->>'departmentId', ''));

        UPDATE public.processes
        SET
          department_id = CASE
            WHEN public.is_admin() THEN NULLIF(next_item->>'departmentId', '')
            WHEN public.is_manager() THEN target_department_id
            ELSE current_department_id
          END,
          name = COALESCE(next_item->>'name', ''),
          category = COALESCE(next_item->>'category', ''),
          level = COALESCE((next_item->>'level')::INTEGER, 1),
          version = COALESCE(next_item->>'version', 'Draft'),
          is_active = COALESCE((next_item->>'isActive')::BOOLEAN, false),
          type = COALESCE(next_item->>'type', 'main'),
          owner = COALESCE(next_item->>'owner', ''),
          co_owner = COALESCE(next_item->>'coOwner', ''),
          objective = COALESCE(next_item->>'objective', ''),
          nodes = COALESCE(next_item->'nodes', '[]'::jsonb),
          links = COALESCE(next_item->'links', '[]'::jsonb),
          history = COALESCE(next_item->'history', '[]'::jsonb),
          row_version = expected_row_version + 1
        WHERE id = next_item->>'id'
          AND row_version = expected_row_version;

        IF NOT FOUND THEN
          RAISE EXCEPTION '流程已被其他人修改，请刷新最新数据后再重试。';
        END IF;
      END IF;
    END IF;

    previous_item := NULL;
  END LOOP;

  RETURN QUERY
  SELECT *
  FROM public.processes
  ORDER BY id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_users_atomic(
  p_next_users JSONB,
  p_previous_users JSONB
)
RETURNS SETOF public.users
LANGUAGE plpgsql
AS $$
DECLARE
  next_item JSONB;
  previous_item JSONB;
  expected_row_version BIGINT;
  previous_snapshot JSONB;
  next_snapshot JSONB;
BEGIN
  IF NOT public.is_admin()
     AND NOT public.has_menu_permission('user', 'update')
     AND NOT public.has_menu_permission('menu-permissions', 'update') THEN
    RAISE EXCEPTION '无权限保存用户';
  END IF;

  FOR previous_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_previous_users, '[]'::jsonb))
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_next_users, '[]'::jsonb)) AS next_values(value)
      WHERE next_values.value->>'id' = previous_item->>'id'
    ) THEN
      expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

      DELETE FROM public.users
      WHERE id = previous_item->>'id'
        AND row_version = expected_row_version;

      IF NOT FOUND THEN
        RAISE EXCEPTION '用户已被其他人修改或删除，请刷新最新数据后再重试。';
      END IF;
    END IF;
  END LOOP;

  FOR next_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_next_users, '[]'::jsonb))
  LOOP
    SELECT value
    INTO previous_item
    FROM jsonb_array_elements(COALESCE(p_previous_users, '[]'::jsonb)) AS previous_values(value)
    WHERE previous_values.value->>'id' = next_item->>'id'
    LIMIT 1;

    IF previous_item IS NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.users
        WHERE id = next_item->>'id'
      ) THEN
        RAISE EXCEPTION '用户创建失败，可能是重复提交或记录已存在。';
      END IF;

      INSERT INTO public.users (
        id,
        username,
        name,
        role,
        department_id,
        pad_permissions,
        reviews,
        system_role_ids,
        custom_permissions,
        auth_id,
        row_version
      )
      VALUES (
        next_item->>'id',
        COALESCE(next_item->>'username', ''),
        COALESCE(next_item->>'name', ''),
        COALESCE(NULLIF(next_item->>'role', ''), 'Employee'),
        NULLIF(next_item->>'departmentId', ''),
        CASE WHEN next_item ? 'padPermissions' THEN COALESCE(next_item->'padPermissions', '[]'::jsonb) ELSE NULL END,
        CASE WHEN next_item ? 'reviews' THEN COALESCE(next_item->'reviews', '{}'::jsonb) ELSE NULL END,
        CASE WHEN next_item ? 'systemRoleIds' THEN COALESCE(next_item->'systemRoleIds', '[]'::jsonb) ELSE NULL END,
        CASE WHEN next_item ? 'customPermissions' THEN COALESCE(next_item->'customPermissions', '{}'::jsonb) ELSE NULL END,
        CASE WHEN NULLIF(next_item->>'auth_id', '') IS NULL THEN NULL ELSE (next_item->>'auth_id')::UUID END,
        0
      );
    ELSE
      previous_snapshot := jsonb_strip_nulls(previous_item - 'rowVersion' - 'updatedAt');
      next_snapshot := jsonb_strip_nulls(next_item - 'rowVersion' - 'updatedAt');

      IF previous_snapshot IS DISTINCT FROM next_snapshot THEN
        expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

        UPDATE public.users
        SET
          username = COALESCE(next_item->>'username', ''),
          name = COALESCE(next_item->>'name', ''),
          role = COALESCE(NULLIF(next_item->>'role', ''), 'Employee'),
          department_id = NULLIF(next_item->>'departmentId', ''),
          pad_permissions = CASE WHEN next_item ? 'padPermissions' THEN COALESCE(next_item->'padPermissions', '[]'::jsonb) ELSE NULL END,
          reviews = CASE WHEN next_item ? 'reviews' THEN COALESCE(next_item->'reviews', '{}'::jsonb) ELSE NULL END,
          system_role_ids = CASE WHEN next_item ? 'systemRoleIds' THEN COALESCE(next_item->'systemRoleIds', '[]'::jsonb) ELSE NULL END,
          custom_permissions = CASE WHEN next_item ? 'customPermissions' THEN COALESCE(next_item->'customPermissions', '{}'::jsonb) ELSE NULL END,
          row_version = expected_row_version + 1
        WHERE id = next_item->>'id'
          AND row_version = expected_row_version;

        IF NOT FOUND THEN
          RAISE EXCEPTION '用户已被其他人修改，请刷新最新数据后再重试。';
        END IF;
      END IF;
    END IF;

    previous_item := NULL;
  END LOOP;

  RETURN QUERY
  SELECT *
  FROM public.users
  ORDER BY id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_my_profile_name(
  p_name TEXT,
  p_expected_row_version BIGINT DEFAULT NULL
)
RETURNS public.users
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_auth_id UUID;
  updated_user public.users;
BEGIN
  current_auth_id := auth.uid();

  IF current_auth_id IS NULL THEN
    RAISE EXCEPTION '未登录，无法修改个人资料';
  END IF;

  IF COALESCE(BTRIM(p_name), '') = '' THEN
    RAISE EXCEPTION '姓名不能为空';
  END IF;

  UPDATE public.users
  SET
    name = BTRIM(p_name),
    row_version = row_version + 1
  WHERE auth_id = current_auth_id
    AND (
      p_expected_row_version IS NULL
      OR row_version = p_expected_row_version
    )
  RETURNING * INTO updated_user;

  IF updated_user.id IS NULL THEN
    RAISE EXCEPTION '个人资料已被其他人修改，请刷新后重试';
  END IF;

  RETURN updated_user;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_system_roles_atomic(
  p_next_roles JSONB,
  p_previous_roles JSONB
)
RETURNS SETOF public.system_roles
LANGUAGE plpgsql
AS $$
DECLARE
  next_item JSONB;
  previous_item JSONB;
  expected_row_version BIGINT;
  previous_snapshot JSONB;
  next_snapshot JSONB;
BEGIN
  IF NOT public.is_admin()
     AND NOT public.has_menu_permission('menu-permissions', 'update') THEN
    RAISE EXCEPTION '无权限保存系统角色';
  END IF;

  FOR previous_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_previous_roles, '[]'::jsonb))
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_next_roles, '[]'::jsonb)) AS next_values(value)
      WHERE next_values.value->>'id' = previous_item->>'id'
    ) THEN
      expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

      DELETE FROM public.system_roles
      WHERE id = previous_item->>'id'
        AND row_version = expected_row_version;

      IF NOT FOUND THEN
        RAISE EXCEPTION '系统角色已被其他人修改或删除，请刷新最新数据后再重试。';
      END IF;
    END IF;
  END LOOP;

  FOR next_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_next_roles, '[]'::jsonb))
  LOOP
    SELECT value
    INTO previous_item
    FROM jsonb_array_elements(COALESCE(p_previous_roles, '[]'::jsonb)) AS previous_values(value)
    WHERE previous_values.value->>'id' = next_item->>'id'
    LIMIT 1;

    IF previous_item IS NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.system_roles
        WHERE id = next_item->>'id'
      ) THEN
        RAISE EXCEPTION '系统角色创建失败，可能是重复提交或记录已存在。';
      END IF;

      INSERT INTO public.system_roles (
        id,
        name,
        description,
        permissions,
        row_version
      )
      VALUES (
        next_item->>'id',
        COALESCE(next_item->>'name', ''),
        COALESCE(next_item->>'description', ''),
        COALESCE(next_item->'permissions', '{}'::jsonb),
        0
      );
    ELSE
      previous_snapshot := jsonb_strip_nulls(previous_item - 'rowVersion' - 'updatedAt');
      next_snapshot := jsonb_strip_nulls(next_item - 'rowVersion' - 'updatedAt');

      IF previous_snapshot IS DISTINCT FROM next_snapshot THEN
        expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

        UPDATE public.system_roles
        SET
          name = COALESCE(next_item->>'name', ''),
          description = COALESCE(next_item->>'description', ''),
          permissions = COALESCE(next_item->'permissions', '{}'::jsonb),
          row_version = expected_row_version + 1
        WHERE id = next_item->>'id'
          AND row_version = expected_row_version;

        IF NOT FOUND THEN
          RAISE EXCEPTION '系统角色已被其他人修改，请刷新最新数据后再重试。';
        END IF;
      END IF;
    END IF;

    previous_item := NULL;
  END LOOP;

  RETURN QUERY
  SELECT *
  FROM public.system_roles
  ORDER BY id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_businesses_atomic(
  p_next_businesses JSONB,
  p_previous_businesses JSONB
)
RETURNS SETOF public.businesses
LANGUAGE plpgsql
AS $$
DECLARE
  next_item JSONB;
  previous_item JSONB;
  expected_row_version BIGINT;
  previous_snapshot JSONB;
  next_snapshot JSONB;
BEGIN
  IF NOT public.is_admin() AND NOT public.has_menu_permission('business-definition', 'update') THEN
    RAISE EXCEPTION '无权限保存业务定义';
  END IF;

  FOR previous_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_previous_businesses, '[]'::jsonb))
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_next_businesses, '[]'::jsonb)) AS next_values(value)
      WHERE next_values.value->>'id' = previous_item->>'id'
    ) THEN
      expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

      DELETE FROM public.businesses
      WHERE id = previous_item->>'id'
        AND row_version = expected_row_version;

      IF NOT FOUND THEN
        RAISE EXCEPTION '业务定义已被其他人修改或删除，请刷新最新数据后再重试。';
      END IF;
    END IF;
  END LOOP;

  FOR next_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_next_businesses, '[]'::jsonb))
  LOOP
    SELECT value
    INTO previous_item
    FROM jsonb_array_elements(COALESCE(p_previous_businesses, '[]'::jsonb)) AS previous_values(value)
    WHERE previous_values.value->>'id' = next_item->>'id'
    LIMIT 1;

    IF previous_item IS NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.businesses
        WHERE id = next_item->>'id'
      ) THEN
        RAISE EXCEPTION '业务定义创建失败，可能是重复提交或记录已存在。';
      END IF;

      INSERT INTO public.businesses (
        id,
        name,
        business_format,
        customer_persona,
        customer_needs,
        surface_product_power,
        core_product_power,
        row_version
      )
      VALUES (
        next_item->>'id',
        COALESCE(next_item->>'name', ''),
        COALESCE(next_item->>'businessFormat', ''),
        COALESCE(next_item->>'customerPersona', ''),
        COALESCE(next_item->>'customerNeeds', ''),
        COALESCE(next_item->>'surfaceProductPower', ''),
        COALESCE(next_item->>'coreProductPower', ''),
        0
      );
    ELSE
      previous_snapshot := jsonb_strip_nulls(previous_item - 'rowVersion' - 'updatedAt');
      next_snapshot := jsonb_strip_nulls(next_item - 'rowVersion' - 'updatedAt');

      IF previous_snapshot IS DISTINCT FROM next_snapshot THEN
        expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

        UPDATE public.businesses
        SET
          name = COALESCE(next_item->>'name', ''),
          business_format = COALESCE(next_item->>'businessFormat', ''),
          customer_persona = COALESCE(next_item->>'customerPersona', ''),
          customer_needs = COALESCE(next_item->>'customerNeeds', ''),
          surface_product_power = COALESCE(next_item->>'surfaceProductPower', ''),
          core_product_power = COALESCE(next_item->>'coreProductPower', ''),
          row_version = expected_row_version + 1
        WHERE id = next_item->>'id'
          AND row_version = expected_row_version;

        IF NOT FOUND THEN
          RAISE EXCEPTION '业务定义已被其他人修改，请刷新最新数据后再重试。';
        END IF;
      END IF;
    END IF;

    previous_item := NULL;
  END LOOP;

  RETURN QUERY
  SELECT *
  FROM public.businesses
  ORDER BY id;
END;
$$;

COMMIT;
