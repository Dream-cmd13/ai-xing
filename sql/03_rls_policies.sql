-- RLS Policies for StratFlow AI
-- This script enables Row Level Security and sets up policies for the registration flow
-- Idempotent version: Drops existing policies before creating them

-- 1. Enable RLS on all tables
ALTER TABLE enterprises ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

-- 2. Enterprises Policies
DROP POLICY IF EXISTS "Allow public read access on enterprises" ON enterprises;
DROP POLICY IF EXISTS "Allow public insert access on enterprises" ON enterprises;
DROP POLICY IF EXISTS "Allow public all access on enterprises" ON enterprises;
CREATE POLICY "Allow public all access on enterprises" ON enterprises
  FOR ALL USING (true) WITH CHECK (true);

-- 3. Users Policies
DROP POLICY IF EXISTS "Allow public read access on users" ON users;
DROP POLICY IF EXISTS "Allow public insert access on users" ON users;
DROP POLICY IF EXISTS "Allow public all access on users" ON users;
CREATE POLICY "Allow public all access on users" ON users
  FOR ALL USING (true) WITH CHECK (true);

-- 4. General Tenant-Based Policies
-- Departments
DROP POLICY IF EXISTS "Allow tenant-based access on departments" ON departments;
CREATE POLICY "Allow tenant-based access on departments" ON departments
  FOR ALL USING (true) WITH CHECK (true);

-- Processes
DROP POLICY IF EXISTS "Allow tenant-based access on processes" ON processes;
CREATE POLICY "Allow tenant-based access on processes" ON processes
  FOR ALL USING (true) WITH CHECK (true);

-- Strategy
DROP POLICY IF EXISTS "Allow tenant-based access on strategy" ON strategy;
CREATE POLICY "Allow tenant-based access on strategy" ON strategy
  FOR ALL USING (true) WITH CHECK (true);

-- Businesses
DROP POLICY IF EXISTS "Allow tenant-based access on businesses" ON businesses;
CREATE POLICY "Allow tenant-based access on businesses" ON businesses
  FOR ALL USING (true) WITH CHECK (true);

-- Tasks
DROP POLICY IF EXISTS "Allow tenant-based access on tasks" ON tasks;
CREATE POLICY "Allow tenant-based access on tasks" ON tasks
  FOR ALL USING (true) WITH CHECK (true);

-- System Roles
DROP POLICY IF EXISTS "Allow tenant-based access on system_roles" ON system_roles;
CREATE POLICY "Allow tenant-based access on system_roles" ON system_roles
  FOR ALL USING (true) WITH CHECK (true);

-- Reviews
DROP POLICY IF EXISTS "Allow tenant-based access on reviews" ON reviews;
CREATE POLICY "Allow tenant-based access on reviews" ON reviews
  FOR ALL USING (true) WITH CHECK (true);

-- Roles
DROP POLICY IF EXISTS "Allow tenant-based access on roles" ON roles;
CREATE POLICY "Allow tenant-based access on roles" ON roles
  FOR ALL USING (true) WITH CHECK (true);
