-- Minimal unauthenticated readiness probe for the MCP deployment.
-- It returns only object-existence state and no business rows or credentials.

CREATE OR REPLACE FUNCTION public.mcp_get_readiness()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'status', CASE WHEN (
      to_regprocedure('public.mcp_get_personal_workbench_page(integer,bigint,text,text,bigint,text,text,bigint,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_visible_tasks_page(integer,bigint,text,text,text,text,text)') IS NOT NULL
      AND to_regprocedure('public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)') IS NOT NULL
    ) THEN 'ready' ELSE 'degraded' END,
    'migrationVersion', CASE WHEN to_regprocedure('public.mcp_get_personal_workbench_page(integer,bigint,text,text,bigint,text,text,bigint,text)') IS NOT NULL
      THEN '2026-08-27' ELSE NULL END,
    'personalWorkbenchRpc', to_regprocedure('public.mcp_get_personal_workbench_page(integer,bigint,text,text,bigint,text,text,bigint,text)') IS NOT NULL,
    'visibleTasksRpc', to_regprocedure('public.mcp_get_visible_tasks_page(integer,bigint,text,text,text,text,text)') IS NOT NULL,
    'reviewSyncRpc', to_regprocedure('public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)') IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.mcp_get_readiness() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_get_readiness() TO anon, authenticated;
