-- Complete release contract for readiness. The migrator records the digest
-- only after all required transactional migrations have succeeded.

BEGIN;

CREATE TABLE IF NOT EXISTS mcp_internal.release_contracts (
  release_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  required_versions JSONB NOT NULL CHECK (jsonb_typeof(required_versions) = 'array'),
  deferred_indexes JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(deferred_indexes) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  recorded_by TEXT NOT NULL DEFAULT current_user
);

REVOKE ALL ON TABLE mcp_internal.release_contracts FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mcp_get_readiness()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH expected AS (
    SELECT '2026-09-01'::TEXT AS release_id, '[
      "2026-08-21_mcp_write_infra_tables",
      "2026-08-21_mcp_write_rpc",
      "2026-08-25_mcp_name_identity_queries",
      "2026-08-25_mcp_task_defaults_people_submit",
      "2026-08-25_mcp_task_review_sync_rpc",
      "2026-08-26_fix_task_users_timeout",
      "2026-08-26_mcp_p1_hardening",
      "2026-08-27_mcp_migration_control",
      "2026-08-27_mcp_review_slot_hardening",
      "2026-08-27_mcp_task_pagination",
      "2026-08-27_mcp_readiness",
      "2026-08-28_web_task_load_p0_p1",
      "2026-08-28_mcp_okr_queries",
      "2026-08-29_nested_department_scope",
      "2026-08-29_nested_department_permission_alignment",
      "2026-08-29_department_tree_peer_read_visibility",
      "2026-08-29_department_tree_peer_read_performance",
      "2026-08-29_department_scope_task_read_performance",
      "2026-08-29_nested_department_task_write_trigger_alignment",
      "2026-08-30_mcp_department_okr_periods_fix",
      "2026-08-31_mcp_okr_contract_hardening",
      "2026-08-31_mcp_okr_task_attachment_fix",
      "2026-08-31_mcp_okr_task_attachment_json_fallback",
      "2026-08-31_mcp_okr_readiness_gate",
      "2026-08-31_web_task_center_scoped_pagination",
      "2026-09-01_mcp_task_validation_and_people_security"
    ]'::JSONB AS required_versions
  ), contract AS (
    SELECT contract_row.*
    FROM mcp_internal.release_contracts contract_row
    JOIN expected ON expected.release_id = contract_row.release_id
  ), checks AS (
    SELECT
      expected.release_id,
      contract.manifest_digest,
      COALESCE(contract.deferred_indexes, '{}'::JSONB) AS deferred_indexes,
      contract.required_versions = expected.required_versions
        AND contract.manifest_digest ~ '^[0-9a-f]{64}$'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(expected.required_versions) required(version)
          LEFT JOIN mcp_internal.schema_migrations migration ON migration.version = required.version
          WHERE migration.version IS NULL OR migration.status <> 'success'
        ) AS required_migrations,
      to_regprocedure('public.mcp_update_pad_task(text,jsonb,bigint,text)') IS NOT NULL
        AND to_regprocedure('public.mcp_update_pad_task_scoped(text,jsonb,bigint,text)') IS NOT NULL
        AND to_regprocedure('public.mcp_update_pad_task_with_review_sync_scoped(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])') IS NOT NULL
        AND to_regprocedure('public.web_get_visible_tasks_scope_v2(text,text[],integer,text)') IS NOT NULL
        AND to_regprocedure('public.mcp_get_department_okrs_scope_v2(text,text,integer,text,boolean,integer)') IS NOT NULL AS required_functions,
      COALESCE(has_function_privilege('authenticated', to_regprocedure('public.mcp_update_pad_task(text,jsonb,bigint,text)'), 'EXECUTE'), FALSE)
        AND COALESCE(has_function_privilege('authenticated', to_regprocedure('public.mcp_update_pad_task_scoped(text,jsonb,bigint,text)'), 'EXECUTE'), FALSE)
        AND COALESCE(has_function_privilege('authenticated', to_regprocedure('public.get_current_user_task_users_for_tasks(text[])'), 'EXECUTE'), FALSE)
        AND NOT COALESCE(has_function_privilege('anon', to_regprocedure('public.mcp_update_pad_task(text,jsonb,bigint,text)'), 'EXECUTE'), FALSE)
        AND NOT COALESCE(has_function_privilege('anon', to_regprocedure('public.get_current_user_task_users_for_tasks(text[])'), 'EXECUTE'), FALSE) AS function_privileges
    FROM expected
    LEFT JOIN contract ON TRUE
  )
  SELECT jsonb_build_object(
    'status', CASE WHEN required_migrations AND required_functions AND function_privileges THEN 'ready' ELSE 'degraded' END,
    'reason', CASE WHEN required_migrations AND required_functions AND function_privileges THEN NULL ELSE 'RELEASE_CONTRACT_MISMATCH' END,
    'releaseId', release_id,
    'migrationVersion', '2026-09-01_mcp_release_contract',
    'manifestDigest', manifest_digest,
    'requiredMigrations', COALESCE(required_migrations, FALSE),
    'functionPrivileges', COALESCE(function_privileges, FALSE),
    'deferredIndexes', deferred_indexes,
    'companyOkrsRpc', to_regprocedure('public.mcp_get_company_okrs(integer,boolean)') IS NOT NULL,
    'departmentOkrsRpc', to_regprocedure('public.mcp_get_department_okrs(text,integer,text,boolean,integer)') IS NOT NULL,
    'scopedDepartmentOkrsRpc', to_regprocedure('public.mcp_get_department_okrs_scope_v2(text,text,integer,text,boolean,integer)') IS NOT NULL,
    'okrNormalizer', to_regprocedure('public.mcp_normalize_okr_entry(jsonb)') IS NOT NULL,
    'taskCenterRpc', to_regprocedure('public.web_get_task_center_page(text,text,text,text,text,integer,bigint,text)') IS NOT NULL
  )
  FROM checks;
$$;

REVOKE ALL ON FUNCTION public.mcp_get_readiness() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_get_readiness() TO anon, authenticated;

COMMIT;
