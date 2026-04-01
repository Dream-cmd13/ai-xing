-- Remove multi-tenant architecture and switch to single-tenant

-- 1. Drop foreign key constraints and ent_name columns from all tables
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_ent_name_fkey;
ALTER TABLE users DROP COLUMN IF EXISTS ent_name;

ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_ent_name_fkey;
ALTER TABLE departments DROP COLUMN IF EXISTS ent_name;

ALTER TABLE processes DROP CONSTRAINT IF EXISTS processes_ent_name_fkey;
ALTER TABLE processes DROP COLUMN IF EXISTS ent_name;

ALTER TABLE strategy DROP CONSTRAINT IF EXISTS strategy_pkey;
ALTER TABLE strategy DROP CONSTRAINT IF EXISTS strategy_ent_name_fkey;
ALTER TABLE strategy DROP COLUMN IF EXISTS ent_name;
ALTER TABLE strategy ADD COLUMN IF NOT EXISTS id TEXT PRIMARY KEY DEFAULT 'default';

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_ent_name_fkey;
ALTER TABLE businesses DROP COLUMN IF EXISTS ent_name;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_ent_name_fkey;
ALTER TABLE tasks DROP COLUMN IF EXISTS ent_name;

ALTER TABLE system_roles DROP CONSTRAINT IF EXISTS system_roles_ent_name_fkey;
ALTER TABLE system_roles DROP COLUMN IF EXISTS ent_name;

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_ent_name_fkey;
ALTER TABLE reviews DROP COLUMN IF EXISTS ent_name;

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_ent_name_fkey;
ALTER TABLE roles DROP COLUMN IF EXISTS ent_name;

-- 2. Drop enterprises table
DROP TABLE IF EXISTS enterprises;

-- 3. Create a settings table for AI settings (previously in enterprises)
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  ai_settings JSONB
);

-- 4. Insert default admin user if not exists
INSERT INTO users (id, username, password, name, role)
VALUES ('admin-user-id', 'admin', '888888', '系统管理员', 'Admin')
ON CONFLICT (id) DO UPDATE SET 
  username = EXCLUDED.username,
  password = EXCLUDED.password,
  role = EXCLUDED.role;
