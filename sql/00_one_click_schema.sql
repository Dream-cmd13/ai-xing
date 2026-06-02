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
  task_review TEXT,
  task_review_score INTEGER,
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
WHERE (
    manager_user.name = department_row.manager_name
    OR manager_user.username = department_row.manager_name
  )
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
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS task_review TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS task_review_score INTEGER;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.tasks DROP COLUMN IF EXISTS visibility;

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

CREATE OR REPLACE FUNCTION public.current_auth_username()
RETURNS TEXT AS $$
  SELECT NULLIF(
    lower(split_part(COALESCE(auth.jwt()->>'email', current_setting('request.jwt.claim.email', true), ''), '@', 1)),
    ''
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.jsonb_text_values(p_value JSONB)
RETURNS TABLE(value TEXT) AS $$
BEGIN
  IF p_value IS NULL THEN
    RETURN;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    RETURN QUERY
    SELECT array_value.value
    FROM jsonb_array_elements_text(p_value) AS array_value(value);
  ELSIF jsonb_typeof(p_value) = 'string' THEN
    RETURN QUERY
    SELECT trim(both '"' from p_value::TEXT);
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users u
    WHERE (
      u.auth_id = auth.uid()
      OR lower(u.username) = public.current_auth_username()
    ) AND (
      u.role = 'Admin'
      OR (
        u.system_role_ids IS NOT NULL 
        AND EXISTS (
          SELECT 1
          FROM public.jsonb_text_values(u.system_role_ids) AS rid(value)
          JOIN public.system_roles sr ON sr.id = rid.value
          WHERE sr.name ILIKE 'admin' OR sr.id = 'admin'
        )
      )
    )
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
     OR lower(username) = public.current_auth_username()
  ORDER BY CASE WHEN auth_id = auth.uid() THEN 0 ELSE 1 END
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
  SELECT id
  FROM public.users
  WHERE auth_id = auth.uid()
     OR lower(username) = public.current_auth_username()
  ORDER BY CASE WHEN auth_id = auth.uid() THEN 0 ELSE 1 END
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_department_id()
RETURNS TEXT AS $$
  SELECT department_id
  FROM public.users
  WHERE auth_id = auth.uid()
     OR lower(username) = public.current_auth_username()
  ORDER BY CASE WHEN auth_id = auth.uid() THEN 0 ELSE 1 END
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_pad_permissions()
RETURNS JSONB AS $$
  SELECT CASE
    WHEN jsonb_typeof(pad_permissions) = 'array' THEN pad_permissions
    WHEN jsonb_typeof(pad_permissions) = 'string' THEN jsonb_build_array(trim(both '"' from pad_permissions::TEXT))
    ELSE '[]'::jsonb
  END
  FROM public.users
  WHERE auth_id = auth.uid()
     OR lower(username) = public.current_auth_username()
  ORDER BY CASE WHEN auth_id = auth.uid() THEN 0 ELSE 1 END
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.has_menu_permission(
  p_menu_id TEXT,
  p_action TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  user_record RECORD;
  custom_perm JSONB;
  role_id TEXT;
  role_record RECORD;
  role_perm JSONB;
BEGIN
  -- Admin always has permission
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  -- Get current user's custom_permissions and system_role_ids
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

  -- Check custom permissions first (override)
  IF user_record.custom_permissions IS NOT NULL
     AND jsonb_typeof(user_record.custom_permissions) = 'object'
     AND user_record.custom_permissions ? p_menu_id THEN
    custom_perm := user_record.custom_permissions -> p_menu_id;
    RETURN COALESCE((custom_perm ->> p_action)::BOOLEAN, false);
  END IF;

  -- Check system role permissions
  IF user_record.system_role_ids IS NOT NULL THEN
    FOR role_id IN
      SELECT value
      FROM public.jsonb_text_values(user_record.system_role_ids)
    LOOP
      SELECT permissions INTO role_record
      FROM public.system_roles
      WHERE id = role_id;

      IF role_record IS NOT NULL
         AND role_record.permissions IS NOT NULL
         AND role_record.permissions ? p_menu_id THEN
        role_perm := role_record.permissions -> p_menu_id;
        IF COALESCE((role_perm ->> p_action)::BOOLEAN, false) THEN
          RETURN true;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_has_department_visibility(target_department_id TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  current_department_id TEXT;
  pad_permissions JSONB;
  pad_department_id TEXT;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  IF target_department_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.is_department_manager(target_department_id) THEN
    RETURN true;
  END IF;

  current_department_id := public.current_user_department_id();
  IF current_department_id IS NOT NULL AND current_department_id = target_department_id THEN
    RETURN true;
  END IF;

  IF current_department_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.departments
    WHERE id = target_department_id
      AND public.find_department_in_tree(
        COALESCE(sub_departments, '[]'::jsonb),
        current_department_id
      ) IS NOT NULL
  ) THEN
    RETURN true;
  END IF;

  pad_permissions := public.current_user_pad_permissions();
  FOR pad_department_id IN
    SELECT value
    FROM public.jsonb_text_values(COALESCE(pad_permissions, '[]'::jsonb))
  LOOP
    IF pad_department_id = target_department_id THEN
      RETURN true;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.departments
      WHERE id = target_department_id
        AND public.find_department_in_tree(
          COALESCE(sub_departments, '[]'::jsonb),
          pad_department_id
        ) IS NOT NULL
    ) THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_can_save_departments()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN public.is_admin()
    OR public.has_menu_permission('org', 'create')
    OR public.has_menu_permission('org', 'update')
    OR public.has_menu_permission('okr', 'create')
    OR public.has_menu_permission('okr', 'update')
    OR public.has_menu_permission('okr-review', 'update');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.find_department_in_tree(
  p_departments JSONB,
  p_target_department_id TEXT
)
RETURNS JSONB AS $$
DECLARE
  department_node JSONB;
  found_node JSONB;
BEGIN
  IF p_target_department_id IS NULL
     OR p_departments IS NULL
     OR jsonb_typeof(p_departments) <> 'array' THEN
    RETURN NULL;
  END IF;

  FOR department_node IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_departments, '[]'::jsonb))
  LOOP
    IF department_node->>'id' = p_target_department_id THEN
      RETURN department_node;
    END IF;

    found_node := public.find_department_in_tree(
      department_node->'subDepartments',
      p_target_department_id
    );

    IF found_node IS NOT NULL THEN
      RETURN found_node;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

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
    WHERE manager_user_id = public.current_user_id()
      AND (
        id = target_department_id
        OR public.find_department_in_tree(
          COALESCE(sub_departments, '[]'::jsonb),
          target_department_id
        ) IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.departments
    WHERE COALESCE(
      public.find_department_in_tree(COALESCE(sub_departments, '[]'::jsonb), target_department_id)->>'managerUserId',
      ''
    ) = public.current_user_id()
  ) OR (
    public.is_manager()
    AND (
      target_department_id = public.current_user_department_id()
      OR EXISTS (
        SELECT 1
        FROM public.departments
        WHERE id = public.current_user_department_id()
          AND public.find_department_in_tree(
            COALESCE(sub_departments, '[]'::jsonb),
            target_department_id
          ) IS NOT NULL
      )
      OR EXISTS (
        SELECT 1
        FROM public.departments
        WHERE public.find_department_in_tree(
          COALESCE(sub_departments, '[]'::jsonb),
          public.current_user_department_id()
        ) IS NOT NULL
        AND (
          target_department_id = public.current_user_department_id()
          OR public.find_department_in_tree(
            COALESCE(
              public.find_department_in_tree(
                COALESCE(sub_departments, '[]'::jsonb),
                public.current_user_department_id()
              )->'subDepartments',
              '[]'::jsonb
            ),
            target_department_id
          ) IS NOT NULL
        )
      )
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.department_tree_has_manager(
  p_departments JSONB,
  p_manager_user_id TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  department_node JSONB;
BEGIN
  IF p_manager_user_id IS NULL
     OR p_departments IS NULL
     OR jsonb_typeof(p_departments) <> 'array' THEN
    RETURN false;
  END IF;

  FOR department_node IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_departments, '[]'::jsonb))
  LOOP
    IF COALESCE(department_node->>'managerUserId', '') = p_manager_user_id THEN
      RETURN true;
    END IF;

    IF public.department_tree_has_manager(
      department_node->'subDepartments',
      p_manager_user_id
    ) THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION public.current_user_can_manage_department_node(
  p_node JSONB,
  p_current_user_id TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  node_id TEXT;
  current_department_id TEXT;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node) <> 'object' THEN
    RETURN false;
  END IF;

  node_id := p_node->>'id';
  current_department_id := public.current_user_department_id();

  IF COALESCE(p_node->>'managerUserId', '') = COALESCE(p_current_user_id, '') THEN
    RETURN true;
  END IF;

  IF node_id IS NOT NULL
     AND current_department_id IS NOT NULL
     AND node_id = current_department_id THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_can_manage_department_tree(
  p_node JSONB,
  p_current_user_id TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  child_node JSONB;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node) <> 'object' THEN
    RETURN false;
  END IF;

  IF public.current_user_can_manage_department_node(p_node, p_current_user_id) THEN
    RETURN true;
  END IF;

  FOR child_node IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_node->'subDepartments', '[]'::jsonb))
  LOOP
    IF public.current_user_can_manage_department_tree(child_node, p_current_user_id) THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.sanitize_new_department_subtree_for_manager(
  p_node JSONB
)
RETURNS JSONB AS $$
DECLARE
  child_node JSONB;
  sanitized_children JSONB := '[]'::jsonb;
  sanitized_child JSONB;
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node) <> 'object' THEN
    RETURN NULL;
  END IF;

  FOR child_node IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_node->'subDepartments', '[]'::jsonb))
  LOOP
    sanitized_child := public.sanitize_new_department_subtree_for_manager(child_node);
    IF sanitized_child IS NOT NULL THEN
      sanitized_children := sanitized_children || jsonb_build_array(sanitized_child);
    END IF;
  END LOOP;

  RETURN jsonb_strip_nulls(
    (p_node - 'managerUserId' - 'managerName' - 'subDepartments')
    || jsonb_build_object(
      'managerUserId', NULL,
      'managerName', '',
      'subDepartments', sanitized_children
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION public.merge_department_subtree_for_manager(
  p_previous_node JSONB,
  p_next_node JSONB,
  p_current_user_id TEXT
)
RETURNS JSONB AS $$
DECLARE
  previous_child JSONB;
  next_child JSONB;
  merged_child JSONB;
  merged_children JSONB := '[]'::jsonb;
  managed_here BOOLEAN;
BEGIN
  IF p_previous_node IS NULL THEN
    RETURN public.sanitize_new_department_subtree_for_manager(p_next_node);
  END IF;

  IF p_next_node IS NULL THEN
    IF public.current_user_can_manage_department_node(p_previous_node, p_current_user_id) THEN
      RETURN NULL;
    END IF;
    RETURN p_previous_node;
  END IF;

  managed_here := public.current_user_can_manage_department_node(p_previous_node, p_current_user_id);

  IF managed_here THEN
    FOR next_child IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(p_next_node->'subDepartments', '[]'::jsonb))
    LOOP
      SELECT value
      INTO previous_child
      FROM jsonb_array_elements(COALESCE(p_previous_node->'subDepartments', '[]'::jsonb)) AS previous_values(value)
      WHERE previous_values.value->>'id' = next_child->>'id'
      LIMIT 1;

      merged_child := public.merge_department_subtree_for_manager(
        previous_child,
        next_child,
        p_current_user_id
      );

      IF merged_child IS NOT NULL THEN
        merged_children := merged_children || jsonb_build_array(merged_child);
      END IF;

      previous_child := NULL;
    END LOOP;

    IF public.has_menu_permission('org', 'update') THEN
      RETURN jsonb_strip_nulls(
        p_next_node || jsonb_build_object('subDepartments', merged_children)
      );
    END IF;

    RETURN jsonb_strip_nulls(
      (p_next_node - 'managerUserId' - 'managerName' - 'subDepartments')
      || jsonb_build_object(
        'managerUserId', p_previous_node->'managerUserId',
        'managerName', COALESCE(p_previous_node->>'managerName', ''),
        'subDepartments', merged_children
      )
    );
  END IF;

  FOR previous_child IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_previous_node->'subDepartments', '[]'::jsonb))
  LOOP
    SELECT value
    INTO next_child
    FROM jsonb_array_elements(COALESCE(p_next_node->'subDepartments', '[]'::jsonb)) AS next_values(value)
    WHERE next_values.value->>'id' = previous_child->>'id'
    LIMIT 1;

    merged_child := public.merge_department_subtree_for_manager(
      previous_child,
      next_child,
      p_current_user_id
    );

    IF merged_child IS NOT NULL THEN
      merged_children := merged_children || jsonb_build_array(merged_child);
    END IF;

    next_child := NULL;
  END LOOP;

  -- User is not the direct manager of this node, but may have org.update permission.
  -- Allow content edits (roleMembers, roles, responsibilities, attributes) to pass through
  -- while preserving manager identity fields (managerUserId, managerName).
  IF public.has_menu_permission('org', 'update') THEN
    RETURN jsonb_strip_nulls(
      p_previous_node
      || jsonb_build_object(
        'roles',            COALESCE(p_next_node->'roles',            p_previous_node->'roles'),
        'roleMembers',      COALESCE(p_next_node->'roleMembers',      p_previous_node->'roleMembers'),
        'responsibilities', COALESCE(p_next_node->>'responsibilities', p_previous_node->>'responsibilities', ''),
        'attributes',       COALESCE(p_next_node->>'attributes',       p_previous_node->>'attributes', ''),
        'subDepartments',   merged_children
      )
    );
  END IF;

  RETURN jsonb_strip_nulls(
    (p_previous_node - 'subDepartments')
    || jsonb_build_object(
      'subDepartments', merged_children
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

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
    FROM public.jsonb_text_values(COALESCE(task_participant_ids, '[]'::jsonb)) AS participant_value(value)
    WHERE participant_value.value = current_id
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.jsonb_text_values(COALESCE(task_approver_ids, '[]'::jsonb)) AS approver_value(value)
    WHERE approver_value.value = current_id
  ) THEN
    RETURN true;
  END IF;

  RETURN public.current_user_has_department_visibility(resolved_department_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.current_user_can_view_task_user(
  target_user_id TEXT
)
RETURNS BOOLEAN AS $$
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  IF target_user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.tasks task_row
    WHERE public.current_user_can_view_task(
      task_row.department_id,
      task_row.created_by,
      task_row.owner_id,
      task_row.participant_ids,
      task_row.approver_ids
    )
    AND (
      task_row.created_by = target_user_id
      OR task_row.owner_id = target_user_id
      OR EXISTS (
        SELECT 1
        FROM public.jsonb_text_values(COALESCE(task_row.participant_ids, '[]'::jsonb)) AS participant_value(value)
        WHERE participant_value.value = target_user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.jsonb_text_values(COALESCE(task_row.approver_ids, '[]'::jsonb)) AS approver_value(value)
        WHERE approver_value.value = target_user_id
      )
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.get_current_user_task_users()
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
    SELECT task_row.*
    FROM public.tasks task_row
    WHERE public.current_user_can_view_task(
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
    UNION
    SELECT log_item.value->>'userId' AS user_id
    FROM visible_tasks
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(COALESCE(visible_tasks.logs, '[]'::jsonb)) = 'array'
        THEN COALESCE(visible_tasks.logs, '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) AS log_item(value)
    WHERE log_item.value->>'userId' IS NOT NULL
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

CREATE OR REPLACE FUNCTION public.current_user_can_manage_task(
  task_department_id TEXT,
  task_owner_id TEXT,
  task_participant_ids JSONB,
  task_approver_ids JSONB
)
RETURNS BOOLEAN AS $$
DECLARE
  current_id TEXT;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;

  current_id := public.current_user_id();

  IF task_owner_id = current_id THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.jsonb_text_values(COALESCE(task_participant_ids, '[]'::jsonb)) AS participant_value(value)
    WHERE participant_value.value = current_id
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

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
          updated_at = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
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
    OR public.has_menu_permission('user', 'view')
    OR public.has_menu_permission('menu-permissions', 'view')
    OR auth_id = auth.uid()
    OR lower(username) = public.current_auth_username()
    OR department_id = public.current_user_department_id()
  );
CREATE POLICY users_insert ON public.users FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.has_menu_permission('user', 'create'));
CREATE POLICY users_update ON public.users FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.has_menu_permission('user', 'update')
    OR public.has_menu_permission('menu-permissions', 'update')
  )
  WITH CHECK (
    public.is_admin()
    OR public.has_menu_permission('user', 'update')
    OR public.has_menu_permission('menu-permissions', 'update')
  );
CREATE POLICY users_delete ON public.users FOR DELETE TO authenticated
  USING (public.is_admin() OR public.has_menu_permission('user', 'update'));

CREATE POLICY departments_select ON public.departments FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR public.has_menu_permission('org', 'view')
    OR public.current_user_has_department_visibility(id)
  );
CREATE POLICY departments_insert ON public.departments FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());
CREATE POLICY departments_update ON public.departments FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR (
      (
        public.has_menu_permission('org', 'update')
        OR public.has_menu_permission('okr', 'update')
        OR public.has_menu_permission('okr-review', 'update')
      )
      AND public.current_user_can_manage_department_tree(
        jsonb_build_object(
          'id', id,
          'managerUserId', manager_user_id,
          'subDepartments', COALESCE(sub_departments, '[]'::jsonb)
        ),
        public.current_user_id()
      )
    )
  )
  WITH CHECK (
    public.is_admin()
    OR (
      (
        public.has_menu_permission('org', 'update')
        OR public.has_menu_permission('okr', 'update')
        OR public.has_menu_permission('okr-review', 'update')
      )
      AND public.current_user_can_manage_department_tree(
        jsonb_build_object(
          'id', id,
          'managerUserId', manager_user_id,
          'subDepartments', COALESCE(sub_departments, '[]'::jsonb)
        ),
        public.current_user_id()
      )
    )
  );
CREATE POLICY departments_delete ON public.departments FOR DELETE TO authenticated
  USING (public.is_admin());

CREATE POLICY processes_select ON public.processes FOR SELECT TO authenticated USING (true);
CREATE POLICY processes_insert ON public.processes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY processes_update ON public.processes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY processes_delete ON public.processes FOR DELETE TO authenticated USING (true);

CREATE POLICY strategy_select ON public.strategy FOR SELECT TO authenticated USING (true);
CREATE POLICY strategy_insert ON public.strategy FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR public.has_menu_permission('business-definition', 'create')
    OR public.has_menu_permission('okr', 'create')
  );
CREATE POLICY strategy_update ON public.strategy FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.has_menu_permission('business-definition', 'update')
    OR public.has_menu_permission('okr', 'update')
  )
  WITH CHECK (
    public.is_admin()
    OR public.has_menu_permission('business-definition', 'update')
    OR public.has_menu_permission('okr', 'update')
  );
CREATE POLICY strategy_delete ON public.strategy FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY businesses_select ON public.businesses FOR SELECT TO authenticated USING (true);
CREATE POLICY businesses_insert ON public.businesses FOR INSERT TO authenticated WITH CHECK (public.is_admin() OR public.has_menu_permission('business-definition', 'create'));
CREATE POLICY businesses_update ON public.businesses FOR UPDATE TO authenticated USING (public.is_admin() OR public.has_menu_permission('business-definition', 'update')) WITH CHECK (public.is_admin() OR public.has_menu_permission('business-definition', 'update'));
CREATE POLICY businesses_delete ON public.businesses FOR DELETE TO authenticated USING (public.is_admin() OR public.has_menu_permission('business-definition', 'update'));

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
    OR public.has_menu_permission('task-center', 'create')
    OR public.has_menu_permission('execution', 'create')
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
    OR (
      (
        public.has_menu_permission('task-center', 'update')
        OR public.has_menu_permission('execution', 'update')
      )
      AND public.current_user_can_manage_task(department_id, owner_id, participant_ids, approver_ids)
    )
  )
  WITH CHECK (
    public.is_admin()
    OR (
      (
        public.has_menu_permission('task-center', 'update')
        OR public.has_menu_permission('execution', 'update')
      )
      AND public.current_user_can_manage_task(department_id, owner_id, participant_ids, approver_ids)
    )
  );
CREATE POLICY tasks_delete ON public.tasks FOR DELETE TO authenticated
  USING (
    public.is_admin()
    OR (
      (
        public.has_menu_permission('task-center', 'update')
        OR public.has_menu_permission('execution', 'update')
      )
      AND public.current_user_can_manage_task(department_id, owner_id, participant_ids, approver_ids)
    )
  );

CREATE POLICY system_roles_select ON public.system_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY system_roles_insert ON public.system_roles FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.has_menu_permission('menu-permissions', 'create'));
CREATE POLICY system_roles_update ON public.system_roles FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.has_menu_permission('menu-permissions', 'update'))
  WITH CHECK (public.is_admin() OR public.has_menu_permission('menu-permissions', 'update'));
CREATE POLICY system_roles_delete ON public.system_roles FOR DELETE TO authenticated
  USING (public.is_admin() OR public.has_menu_permission('menu-permissions', 'update'));

CREATE POLICY settings_select ON public.settings FOR SELECT TO authenticated USING (true);
CREATE POLICY settings_insert ON public.settings FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.has_menu_permission('system-config', 'create'));
CREATE POLICY settings_update ON public.settings FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.has_menu_permission('system-config', 'update'))
  WITH CHECK (public.is_admin() OR public.has_menu_permission('system-config', 'update'));
CREATE POLICY settings_delete ON public.settings FOR DELETE TO authenticated
  USING (public.is_admin() OR public.has_menu_permission('system-config', 'update'));

-- =========================
-- 6) Realtime publication
-- =========================
-- 当前前端已切换为“手动保存 + 乐观锁”模型，不再依赖前端 realtime 订阅。
-- 为避免额外的订阅、回显协调和维护成本，这里不再为业务表配置 realtime publication。

COMMIT;
