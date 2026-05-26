-- StratFlow AI - one-click schema (single-tenant, idempotent)
-- Includes only tables required by current code:
-- users, departments, processes, strategy, businesses, tasks, system_roles, settings
-- Compatibility fix included: tasks.pad_id, tasks.version

BEGIN;

-- =========================
-- 1) Core tables
-- =========================

CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  department_id TEXT,
  pad_permissions JSONB,
  reviews JSONB,
  system_role_ids JSONB,
  custom_permissions JSONB,
  auth_id UUID UNIQUE,
  updated_at BIGINT NOT NULL DEFAULT 0,
  row_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manager_name TEXT,
  manager_user_id TEXT,
  responsibilities TEXT,
  roles JSONB,
  role_members JSONB,
  attributes TEXT,
  sub_departments JSONB,
  okrs JSONB,
  reviews JSONB,
  updated_at BIGINT NOT NULL DEFAULT 0,
  row_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.processes (
  id TEXT PRIMARY KEY,
  department_id TEXT,
  created_by TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  level INTEGER NOT NULL,
  version TEXT NOT NULL,
  is_active BOOLEAN NOT NULL,
  type TEXT NOT NULL,
  owner TEXT,
  co_owner TEXT,
  objective TEXT,
  nodes JSONB,
  links JSONB,
  history JSONB,
  updated_at BIGINT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.strategy (
  id TEXT PRIMARY KEY DEFAULT 'default',
  mission TEXT,
  vision TEXT,
  customer_issues TEXT,
  employee_issues TEXT,
  company_okrs JSONB,
  updated_at BIGINT NOT NULL DEFAULT 0,
  row_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  business_format TEXT,
  customer_persona TEXT,
  customer_needs TEXT,
  surface_product_power TEXT,
  core_product_power TEXT,
  updated_at BIGINT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id TEXT PRIMARY KEY,
  department_id TEXT,
  created_by TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  aligned_kr_id TEXT,
  target_weeks JSONB,
  start_date BIGINT,
  due_date BIGINT,
  tags JSONB,
  participant_ids JSONB,
  approver_ids JSONB,
  logs JSONB,
  plan TEXT,
  action TEXT,
  deliverable TEXT,
  pad_id TEXT,
  version TEXT,
  updated_at BIGINT NOT NULL DEFAULT 0,
  row_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.system_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT 0,
  row_version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  ai_settings JSONB,
  updated_at BIGINT NOT NULL DEFAULT 0,
  row_version BIGINT NOT NULL DEFAULT 0
);

-- =========================
-- 2) Compatibility patches
-- =========================

-- Legacy columns cleanup and required columns backfill
ALTER TABLE public.users DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.users DROP COLUMN IF EXISTS password;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.departments DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS manager_user_id TEXT;
ALTER TABLE public.processes DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.processes ADD COLUMN IF NOT EXISTS department_id TEXT;
ALTER TABLE public.processes ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.processes ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

UPDATE public.processes AS process_row
SET
  department_id = COALESCE(process_row.department_id, owner_user.department_id),
  created_by = COALESCE(process_row.created_by, owner_user.id)
FROM public.users AS owner_user
WHERE owner_user.name = process_row.owner
  AND (process_row.department_id IS NULL OR process_row.created_by IS NULL);

UPDATE public.departments AS department_row
SET manager_user_id = manager_user.id
FROM public.users AS manager_user
WHERE manager_user.name = department_row.manager_name
  AND department_row.manager_user_id IS NULL;

UPDATE public.users
SET role = 'Employee'
WHERE role = 'User';
ALTER TABLE public.businesses DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.system_roles DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.system_roles ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.system_roles ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.tasks DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS pad_id TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS version TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

UPDATE public.tasks
SET created_by = owner_id
WHERE created_by IS NULL;

-- Strategy migration from old multi-tenant shape (ent_name as PK) to id='default'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'strategy' AND column_name = 'ent_name'
  ) THEN
    ALTER TABLE public.strategy DROP CONSTRAINT IF EXISTS strategy_pkey;
    ALTER TABLE public.strategy DROP CONSTRAINT IF EXISTS strategy_ent_name_fkey;
    ALTER TABLE public.strategy DROP COLUMN IF EXISTS ent_name;
  END IF;
END $$;

ALTER TABLE public.strategy ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE public.strategy ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.strategy ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

UPDATE public.strategy
SET id = 'default'
WHERE id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'strategy_pkey'
      AND conrelid = 'public.strategy'::regclass
  ) THEN
    ALTER TABLE public.strategy ADD CONSTRAINT strategy_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE public.strategy ALTER COLUMN id SET DEFAULT 'default';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

-- Remove old enterprises table if present
DROP TABLE IF EXISTS public.enterprises CASCADE;

-- =========================
-- 3) Indexes
-- =========================

CREATE INDEX IF NOT EXISTS idx_users_auth_id ON public.users(auth_id);
CREATE INDEX IF NOT EXISTS idx_users_department_id ON public.users(department_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users(username);
CREATE INDEX IF NOT EXISTS idx_departments_manager_user_id ON public.departments(manager_user_id);

CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON public.tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON public.tasks(created_by);
CREATE INDEX IF NOT EXISTS idx_tasks_department_id ON public.tasks(department_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON public.tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON public.tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_pad_id ON public.tasks(pad_id);
CREATE INDEX IF NOT EXISTS idx_processes_department_id ON public.processes(department_id);
CREATE INDEX IF NOT EXISTS idx_processes_created_by ON public.processes(created_by);

-- =========================
-- 4) Security helper functions
-- =========================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_id = auth.uid() AND role = 'Admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT AS $$
  SELECT CASE
    WHEN role = 'User' THEN 'Employee'
    ELSE role
  END
  FROM public.users
  WHERE auth_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN public.current_user_role() = 'Manager';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_employee()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN public.current_user_role() = 'Employee';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS TEXT AS $$
  SELECT id FROM public.users WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_department_id()
RETURNS TEXT AS $$
  SELECT department_id FROM public.users WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_pad_permissions()
RETURNS JSONB AS $$
  SELECT COALESCE(pad_permissions, '[]'::jsonb)
  FROM public.users
  WHERE auth_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_has_department_visibility(target_department_id TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  current_department_id TEXT;
  pad_permissions JSONB;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  IF public.is_manager() THEN
    RETURN true;
  END IF;

  IF target_department_id IS NULL THEN
    RETURN false;
  END IF;

  current_department_id := public.current_user_department_id();
  IF current_department_id IS NOT NULL AND current_department_id = target_department_id THEN
    RETURN true;
  END IF;

  pad_permissions := public.current_user_pad_permissions();
  RETURN EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(pad_permissions, '[]'::jsonb)) AS permission_value(value)
    WHERE permission_value.value = target_department_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_department_manager(target_department_id TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  IF target_department_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.departments
    WHERE id = target_department_id
      AND manager_user_id = public.current_user_id()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_can_view_task(
  task_department_id TEXT,
  task_created_by TEXT,
  task_owner_id TEXT,
  task_participant_ids JSONB,
  task_approver_ids JSONB
)
RETURNS BOOLEAN AS $$
DECLARE
  current_id TEXT;
  resolved_department_id TEXT;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  current_id := public.current_user_id();
  resolved_department_id := COALESCE(
    task_department_id,
    (SELECT department_id FROM public.users WHERE id = task_owner_id LIMIT 1)
  );

  IF task_created_by = current_id OR task_owner_id = current_id THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(task_participant_ids, '[]'::jsonb)) AS participant_value(value)
    WHERE participant_value.value = current_id
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(task_approver_ids, '[]'::jsonb)) AS approver_value(value)
    WHERE approver_value.value = current_id
  ) THEN
    RETURN true;
  END IF;

  RETURN public.current_user_has_department_visibility(resolved_department_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_can_view_process(
  process_department_id TEXT,
  process_created_by TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  current_id TEXT;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  current_id := public.current_user_id();
  IF process_created_by = current_id THEN
    RETURN true;
  END IF;

  RETURN public.current_user_has_department_visibility(process_department_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

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

  IF NOT public.is_admin() AND NOT public.is_manager() THEN
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
        RAISE EXCEPTION '部门长暂不允许删除部门结构';
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
        RAISE EXCEPTION '部门长暂不允许创建部门结构';
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
        updated_at,
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
        FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
        0
      );
    ELSE
      previous_snapshot := jsonb_strip_nulls(previous_item - 'rowVersion' - 'updatedAt');
      next_snapshot := jsonb_strip_nulls(next_item - 'rowVersion' - 'updatedAt');

      IF previous_snapshot IS DISTINCT FROM next_snapshot THEN
        expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);

        IF NOT public.is_admin() AND NOT public.is_department_manager(previous_item->>'id') THEN
          RAISE EXCEPTION '仅允许修改自己负责的部门';
        END IF;

        UPDATE public.departments
        SET
          name = COALESCE(next_item->>'name', ''),
          manager_name = CASE
            WHEN public.is_admin() THEN COALESCE(next_item->>'managerName', '')
            ELSE COALESCE(previous_item->>'managerName', '')
          END,
          manager_user_id = CASE
            WHEN public.is_admin() THEN NULLIF(next_item->>'managerUserId', '')
            ELSE NULLIF(previous_item->>'managerUserId', '')
          END,
          responsibilities = COALESCE(next_item->>'responsibilities', ''),
          roles = COALESCE(next_item->'roles', '[]'::jsonb),
          role_members = COALESCE(next_item->'roleMembers', '{}'::jsonb),
          attributes = COALESCE(next_item->>'attributes', ''),
          sub_departments = COALESCE(next_item->'subDepartments', '[]'::jsonb),
          okrs = COALESCE(next_item->'okrs', '{}'::jsonb),
          reviews = COALESCE(next_item->'reviews', '{}'::jsonb),
          updated_at = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
          row_version = expected_row_version + 1
        WHERE id = next_item->>'id'
          AND row_version = expected_row_version;

        IF NOT FOUND THEN
          RAISE EXCEPTION '部门已被其他人修改，请刷新最新数据后再重试。';
        END IF;
      END IF;
    END IF;

    previous_item := NULL;
  END LOOP;

  RETURN QUERY
  SELECT *
  FROM public.departments
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

      IF NOT public.is_admin()
         AND NOT public.is_department_manager(COALESCE(previous_item->>'departmentId', current_department_id))
         AND COALESCE(previous_item->>'createdBy', '') <> current_id THEN
        RAISE EXCEPTION '仅允许删除自己创建的流程';
      END IF;

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
        created_by,
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
        updated_at,
        row_version
      )
      VALUES (
        next_item->>'id',
        CASE
          WHEN public.is_admin() THEN NULLIF(next_item->>'departmentId', '')
          WHEN public.is_manager() THEN target_department_id
          ELSE current_department_id
        END,
        CASE
          WHEN public.is_admin() THEN COALESCE(NULLIF(next_item->>'createdBy', ''), current_id)
          WHEN public.is_manager() THEN COALESCE(NULLIF(next_item->>'createdBy', ''), current_id)
          ELSE current_id
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
        FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
        0
      );

      IF public.is_manager() AND NOT public.is_department_manager(target_department_id) THEN
        RAISE EXCEPTION '部门长仅允许在自己负责的部门下创建流程';
      END IF;

      IF NOT public.is_admin() AND NOT public.is_manager() AND current_department_id IS DISTINCT FROM COALESCE(next_item->>'departmentId', current_department_id) THEN
        RAISE EXCEPTION '仅允许在自己部门下创建流程';
      END IF;
    ELSE
      previous_snapshot := jsonb_strip_nulls(previous_item - 'rowVersion' - 'updatedAt');
      next_snapshot := jsonb_strip_nulls(next_item - 'rowVersion' - 'updatedAt');

      IF previous_snapshot IS DISTINCT FROM next_snapshot THEN
        expected_row_version := COALESCE((previous_item->>'rowVersion')::BIGINT, 0);
        target_department_id := COALESCE(NULLIF(next_item->>'departmentId', ''), NULLIF(previous_item->>'departmentId', ''));

        IF NOT public.is_admin()
           AND NOT public.is_department_manager(COALESCE(previous_item->>'departmentId', current_department_id))
           AND COALESCE(previous_item->>'createdBy', '') <> current_id THEN
          RAISE EXCEPTION '仅允许修改自己创建的流程';
        END IF;

        IF public.is_manager()
           AND NOT public.is_department_manager(target_department_id) THEN
          RAISE EXCEPTION '部门长仅允许将流程保存在自己负责的部门下';
        END IF;

        IF NOT public.is_admin()
           AND NOT public.is_manager()
           AND current_department_id IS DISTINCT FROM COALESCE(next_item->>'departmentId', previous_item->>'departmentId') THEN
          RAISE EXCEPTION '仅允许将流程保存在自己部门下';
        END IF;

        UPDATE public.processes
        SET
          department_id = CASE
            WHEN public.is_admin() THEN NULLIF(next_item->>'departmentId', '')
            WHEN public.is_manager() THEN target_department_id
            ELSE current_department_id
          END,
          created_by = CASE
            WHEN public.is_admin() THEN COALESCE(NULLIF(next_item->>'createdBy', ''), current_id)
            WHEN public.is_manager() THEN COALESCE(NULLIF(previous_item->>'createdBy', ''), current_id)
            ELSE current_id
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
          updated_at = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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
  IF NOT public.is_admin() THEN
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
        updated_at,
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
        FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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
          updated_at = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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
    updated_at = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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
  IF NOT public.is_admin() THEN
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
        updated_at,
        row_version
      )
      VALUES (
        next_item->>'id',
        COALESCE(next_item->>'name', ''),
        COALESCE(next_item->>'description', ''),
        COALESCE(next_item->'permissions', '{}'::jsonb),
        FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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
          updated_at = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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
  IF NOT public.is_admin() THEN
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
        updated_at,
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
        FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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
          updated_at = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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

-- =========================
-- 5) RLS policies (reset + recreate)
-- =========================

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'users', 'departments', 'processes', 'strategy',
        'businesses', 'tasks', 'system_roles', 'settings'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select ON public.users FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR public.is_manager()
    OR auth_id = auth.uid()
    OR department_id = public.current_user_department_id()
  );
CREATE POLICY users_insert ON public.users FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY users_update ON public.users FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
CREATE POLICY users_delete ON public.users FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY departments_select ON public.departments FOR SELECT TO authenticated
  USING (public.current_user_has_department_visibility(id));
CREATE POLICY departments_insert ON public.departments FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY departments_update ON public.departments FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
CREATE POLICY departments_delete ON public.departments FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY processes_select ON public.processes FOR SELECT TO authenticated
  USING (public.current_user_can_view_process(department_id, created_by));
CREATE POLICY processes_insert ON public.processes FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (
      public.is_manager()
      AND public.is_department_manager(department_id)
    )
    OR (
      created_by = public.current_user_id()
      AND department_id = public.current_user_department_id()
    )
  );
CREATE POLICY processes_update ON public.processes FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.is_department_manager(department_id)
    OR created_by = public.current_user_id()
  )
  WITH CHECK (
    public.is_admin()
    OR public.is_department_manager(department_id)
    OR (
      created_by = public.current_user_id()
      AND department_id = public.current_user_department_id()
    )
  );
CREATE POLICY processes_delete ON public.processes FOR DELETE TO authenticated
  USING (
    public.is_admin()
    OR public.is_department_manager(department_id)
    OR created_by = public.current_user_id()
  );

CREATE POLICY strategy_select ON public.strategy FOR SELECT TO authenticated USING (true);
CREATE POLICY strategy_insert ON public.strategy FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY strategy_update ON public.strategy FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY strategy_delete ON public.strategy FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY businesses_select ON public.businesses FOR SELECT TO authenticated USING (true);
CREATE POLICY businesses_insert ON public.businesses FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY businesses_update ON public.businesses FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY businesses_delete ON public.businesses FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated
  USING (
    public.current_user_can_view_task(
      department_id,
      created_by,
      owner_id,
      participant_ids,
      approver_ids
    )
  );
CREATE POLICY tasks_insert ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (
      public.is_manager()
      AND public.is_department_manager(department_id)
    )
    OR (
      created_by = public.current_user_id()
      AND department_id = public.current_user_department_id()
    )
  );
CREATE POLICY tasks_update ON public.tasks FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.is_department_manager(department_id)
    OR created_by = public.current_user_id()
  )
  WITH CHECK (
    public.is_admin()
    OR public.is_department_manager(department_id)
    OR (
      created_by = public.current_user_id()
      AND department_id = public.current_user_department_id()
    )
  );
CREATE POLICY tasks_delete ON public.tasks FOR DELETE TO authenticated
  USING (
    public.is_admin()
    OR public.is_department_manager(department_id)
    OR created_by = public.current_user_id()
  );

CREATE POLICY system_roles_select ON public.system_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY system_roles_insert ON public.system_roles FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY system_roles_update ON public.system_roles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY system_roles_delete ON public.system_roles FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY settings_select ON public.settings FOR SELECT TO authenticated USING (true);
CREATE POLICY settings_insert ON public.settings FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY settings_update ON public.settings FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY settings_delete ON public.settings FOR DELETE TO authenticated USING (public.is_admin());

-- =========================
-- 6) Realtime publication
-- =========================
-- 当前前端已切换为“手动保存 + 乐观锁”模型，不再依赖前端 realtime 订阅。
-- 为避免额外的订阅、回显协调和维护成本，这里不再为业务表配置 realtime publication。

COMMIT;
