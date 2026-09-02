-- Keep readiness degraded until the complete OKR task-attachment chain is
-- recorded successfully. This does not read or rewrite business data.
BEGIN;

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
      AND to_regprocedure('public.mcp_get_company_okrs(integer,boolean)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_department_okrs(text,integer,text,boolean,integer)') IS NOT NULL
      AND to_regprocedure('public.mcp_get_department_okrs_scope_v2(text,text,integer,text,boolean,integer)') IS NOT NULL
      AND to_regprocedure('public.mcp_normalize_okr_entry(jsonb)') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'mcp_internal')
      AND EXISTS (SELECT 1 FROM mcp_internal.schema_migrations WHERE version = '2026-08-31_mcp_okr_contract_hardening' AND status = 'success')
      AND EXISTS (SELECT 1 FROM mcp_internal.schema_migrations WHERE version = '2026-08-31_mcp_okr_task_attachment_fix' AND status = 'success')
      AND EXISTS (SELECT 1 FROM mcp_internal.schema_migrations WHERE version = '2026-08-31_mcp_okr_task_attachment_json_fallback' AND status = 'success')
    ) THEN 'ready' ELSE 'degraded' END,
    'migrationVersion', (
      SELECT version FROM mcp_internal.schema_migrations
      WHERE status = 'success' ORDER BY applied_at DESC LIMIT 1
    ),
    'companyOkrsRpc', to_regprocedure('public.mcp_get_company_okrs(integer,boolean)') IS NOT NULL,
    'departmentOkrsRpc', to_regprocedure('public.mcp_get_department_okrs(text,integer,text,boolean,integer)') IS NOT NULL,
    'scopedDepartmentOkrsRpc', to_regprocedure('public.mcp_get_department_okrs_scope_v2(text,text,integer,text,boolean,integer)') IS NOT NULL,
    'okrNormalizer', to_regprocedure('public.mcp_normalize_okr_entry(jsonb)') IS NOT NULL
  );
$$;

GRANT EXECUTE ON FUNCTION public.mcp_get_readiness() TO anon, authenticated;

COMMIT;
