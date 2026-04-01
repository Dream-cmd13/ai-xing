-- Initialization script for StratFlow AI Supabase database
-- Optimized for performance and flat task structure

-- Enterprises table
CREATE TABLE IF NOT EXISTS enterprises (
  name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password TEXT NOT NULL,
  ai_settings JSONB -- Store AI settings here
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  ent_name TEXT REFERENCES enterprises(name) ON DELETE CASCADE,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  department_id TEXT,
  pad_permissions JSONB,
  reviews JSONB,
  system_role_ids JSONB,
  custom_permissions JSONB
);
CREATE INDEX IF NOT EXISTS idx_users_ent_name ON users(ent_name);
CREATE INDEX IF NOT EXISTS idx_users_department_id ON users(department_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Departments table
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  ent_name TEXT REFERENCES enterprises(name) ON DELETE CASCADE,
  name TEXT NOT NULL,
  manager_name TEXT,
  responsibilities TEXT,
  roles JSONB,
  role_members JSONB,
  attributes TEXT,
  sub_departments JSONB,
  okrs JSONB,
  reviews JSONB
);
CREATE INDEX IF NOT EXISTS idx_departments_ent_name ON departments(ent_name);

-- Processes table
CREATE TABLE IF NOT EXISTS processes (
  id TEXT PRIMARY KEY,
  ent_name TEXT REFERENCES enterprises(name) ON DELETE CASCADE,
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
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processes_ent_name ON processes(ent_name);

-- Strategies table
CREATE TABLE IF NOT EXISTS strategy (
  ent_name TEXT PRIMARY KEY REFERENCES enterprises(name) ON DELETE CASCADE,
  mission TEXT,
  vision TEXT,
  customer_issues TEXT,
  employee_issues TEXT,
  company_okrs JSONB
);

-- Businesses table
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  ent_name TEXT REFERENCES enterprises(name) ON DELETE CASCADE,
  name TEXT NOT NULL,
  business_format TEXT,
  customer_persona TEXT,
  customer_needs TEXT,
  surface_product_power TEXT,
  core_product_power TEXT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_businesses_ent_name ON businesses(ent_name);

-- Tasks table (Flat structure for performance)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  ent_name TEXT REFERENCES enterprises(name) ON DELETE CASCADE,
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
  deliverable TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_ent_name ON tasks(ent_name);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_department_id ON tasks(department_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

-- System Roles table
CREATE TABLE IF NOT EXISTS system_roles (
  id TEXT PRIMARY KEY,
  ent_name TEXT REFERENCES enterprises(name) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_roles_ent_name ON system_roles(ent_name);

-- Reviews table
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  ent_name TEXT REFERENCES enterprises(name) ON DELETE CASCADE,
  target_type TEXT NOT NULL, -- 'user' or 'department'
  target_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  date TEXT NOT NULL,
  content TEXT,
  score INTEGER,
  reviewer TEXT,
  okr_progress JSONB,
  okr_details JSONB,
  pad_entries JSONB
);
CREATE INDEX IF NOT EXISTS idx_reviews_ent_name ON reviews(ent_name);
CREATE INDEX IF NOT EXISTS idx_reviews_target ON reviews(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reviews_period ON reviews(period_id);

-- Roles table (Department roles)
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  ent_name TEXT REFERENCES enterprises(name) ON DELETE CASCADE,
  department_id TEXT NOT NULL,
  name TEXT NOT NULL,
  members JSONB
);
CREATE INDEX IF NOT EXISTS idx_roles_ent_name ON roles(ent_name);
CREATE INDEX IF NOT EXISTS idx_roles_department_id ON roles(department_id);
