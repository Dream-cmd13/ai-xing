-- 1. 为 users 表添加 auth_id 列，关联 Supabase Auth
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE;
CREATE INDEX IF NOT EXISTS idx_users_auth_id ON public.users(auth_id);

-- 2. RLS 辅助函数
-- 判断当前用户是否是 Admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_id = auth.uid() AND role = 'Admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 获取当前用户在 users 表中的业务 id (TEXT 类型)
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS TEXT AS $$
  SELECT id FROM public.users WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;



-- 1. 清理所有旧策略
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- 2. 启用所有表的 RLS
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- ========================================
-- 3. Users 表
-- ========================================
CREATE POLICY "users_select" ON public.users FOR SELECT TO authenticated USING (true);
CREATE POLICY "users_insert" ON public.users FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "users_update" ON public.users FOR UPDATE TO authenticated USING (auth_id = auth.uid() OR public.is_admin()) WITH CHECK (auth_id = auth.uid() OR public.is_admin());
CREATE POLICY "users_delete" ON public.users FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 4. Departments 表
-- ========================================
CREATE POLICY "departments_select" ON public.departments FOR SELECT TO authenticated USING (true);
CREATE POLICY "departments_insert" ON public.departments FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "departments_update" ON public.departments FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "departments_delete" ON public.departments FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 5. Processes 表
-- ========================================
CREATE POLICY "processes_select" ON public.processes FOR SELECT TO authenticated USING (true);
CREATE POLICY "processes_insert" ON public.processes FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "processes_update" ON public.processes FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "processes_delete" ON public.processes FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 6. Strategy 表
-- ========================================
CREATE POLICY "strategy_select" ON public.strategy FOR SELECT TO authenticated USING (true);
CREATE POLICY "strategy_insert" ON public.strategy FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "strategy_update" ON public.strategy FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "strategy_delete" ON public.strategy FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 7. Businesses 表
-- ========================================
CREATE POLICY "businesses_select" ON public.businesses FOR SELECT TO authenticated USING (true);
CREATE POLICY "businesses_insert" ON public.businesses FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "businesses_update" ON public.businesses FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "businesses_delete" ON public.businesses FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 8. Tasks 表（所有认证用户可建，owner/admin可改）
-- ========================================
CREATE POLICY "tasks_select" ON public.tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "tasks_insert" ON public.tasks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tasks_update" ON public.tasks FOR UPDATE TO authenticated USING (owner_id = public.current_user_id() OR public.is_admin()) WITH CHECK (owner_id = public.current_user_id() OR public.is_admin());
CREATE POLICY "tasks_delete" ON public.tasks FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 9. System Roles 表
-- ========================================
CREATE POLICY "system_roles_select" ON public.system_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "system_roles_insert" ON public.system_roles FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "system_roles_update" ON public.system_roles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "system_roles_delete" ON public.system_roles FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 10. Reviews 表
-- ========================================
CREATE POLICY "reviews_select" ON public.reviews FOR SELECT TO authenticated USING (true);
CREATE POLICY "reviews_insert" ON public.reviews FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "reviews_update" ON public.reviews FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "reviews_delete" ON public.reviews FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 11. Roles 表（部门角色）
-- ========================================
CREATE POLICY "roles_select" ON public.roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "roles_insert" ON public.roles FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "roles_update" ON public.roles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "roles_delete" ON public.roles FOR DELETE TO authenticated USING (public.is_admin());

-- ========================================
-- 12. Settings 表
-- ========================================
CREATE POLICY "settings_select" ON public.settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "settings_insert" ON public.settings FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "settings_update" ON public.settings FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "settings_delete" ON public.settings FOR DELETE TO authenticated USING (public.is_admin());

-- 清空用户表密码字段

ALTER TABLE public.users DROP COLUMN IF EXISTS password;



