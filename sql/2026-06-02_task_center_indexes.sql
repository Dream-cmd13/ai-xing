-- Run this file separately from 00_one_click_schema.sql.
-- These indexes can be expensive on existing task data, so they must not run inside a transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_participant_ids_gin ON public.tasks USING GIN(participant_ids);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_approver_ids_gin ON public.tasks USING GIN(approver_ids);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_updated_at_desc ON public.tasks(updated_at DESC);
