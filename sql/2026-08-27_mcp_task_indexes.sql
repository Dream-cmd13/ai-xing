-- Candidate indexes for MCP keyset pagination.
-- These statements intentionally are not wrapped in BEGIN/COMMIT: PostgreSQL
-- CREATE INDEX CONCURRENTLY must run outside a transaction. Verify with
-- EXPLAIN (ANALYZE, BUFFERS) on the target test dataset before applying.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_updated_id_desc
  ON public.tasks (updated_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_department_updated_id_desc
  ON public.tasks (department_id, updated_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_target_weeks_gin
  ON public.tasks USING GIN (target_weeks jsonb_path_ops);
