-- Hotfix: tasks can belong to nested departments stored inside departments.sub_departments JSON.
-- A direct FK from tasks.department_id to departments.id rejects valid nested department ids.

BEGIN;

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_department_id_fkey;

COMMIT;
