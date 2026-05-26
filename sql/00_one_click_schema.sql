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
ALTER TABLE public.processes DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.processes ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.businesses DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.system_roles DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.system_roles ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.system_roles ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.tasks DROP COLUMN IF EXISTS ent_name;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS pad_id TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS version TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

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

CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON public.tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_department_id ON public.tasks(department_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON public.tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON public.tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_pad_id ON public.tasks(pad_id);

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

CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS TEXT AS $$
  SELECT id FROM public.users WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

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

CREATE POLICY users_select ON public.users FOR SELECT TO authenticated USING (true);
CREATE POLICY users_insert ON public.users FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY users_update ON public.users FOR UPDATE TO authenticated
  USING (auth_id = auth.uid() OR public.is_admin())
  WITH CHECK (auth_id = auth.uid() OR public.is_admin());
CREATE POLICY users_delete ON public.users FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY departments_select ON public.departments FOR SELECT TO authenticated USING (true);
CREATE POLICY departments_insert ON public.departments FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY departments_update ON public.departments FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY departments_delete ON public.departments FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY processes_select ON public.processes FOR SELECT TO authenticated USING (true);
CREATE POLICY processes_insert ON public.processes FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY processes_update ON public.processes FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY processes_delete ON public.processes FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY strategy_select ON public.strategy FOR SELECT TO authenticated USING (true);
CREATE POLICY strategy_insert ON public.strategy FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY strategy_update ON public.strategy FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY strategy_delete ON public.strategy FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY businesses_select ON public.businesses FOR SELECT TO authenticated USING (true);
CREATE POLICY businesses_insert ON public.businesses FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY businesses_update ON public.businesses FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY businesses_delete ON public.businesses FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY tasks_insert ON public.tasks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY tasks_update ON public.tasks FOR UPDATE TO authenticated
  USING (owner_id = public.current_user_id() OR public.is_admin())
  WITH CHECK (owner_id = public.current_user_id() OR public.is_admin());
CREATE POLICY tasks_delete ON public.tasks FOR DELETE TO authenticated USING (public.is_admin());

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
