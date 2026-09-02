-- Release gate for database-owned web review capability and atomic submission.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_get_readiness()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH expected AS (
    SELECT '2026-09-01-child-review'::TEXT AS release_id,
      '1e00b4e55a3c355af2c232cb31e26ed8a6568118e582cb8c9ca566a037cae5d4'::TEXT AS manifest_digest,
      '[
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
      "2026-09-01_mcp_task_validation_and_people_security",
      "2026-09-01_mcp_release_contract",
      "2026-09-01_web_child_department_review_contract"
    ]'::JSONB AS required_versions
  ), contract AS (
    SELECT contract_row.*
    FROM mcp_internal.release_contracts AS contract_row
    JOIN expected ON expected.release_id = contract_row.release_id
  ), checks AS (
    SELECT
      expected.release_id,
      contract.manifest_digest,
      COALESCE(contract.deferred_indexes, '{}'::JSONB) AS deferred_indexes,
      contract.required_versions = expected.required_versions
        AND contract.manifest_digest = expected.manifest_digest
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(expected.required_versions) AS required(version)
          LEFT JOIN mcp_internal.schema_migrations AS migration
            ON migration.version = required.version
          WHERE migration.version IS NULL OR migration.status <> 'success'
        ) AS required_migrations,
      to_regprocedure('public.web_get_department_review_capability(text)') IS NOT NULL
        AND to_regprocedure('public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])') IS NOT NULL
        AND to_regprocedure('public.mcp_update_pad_task(text,jsonb,bigint,text)') IS NOT NULL
        AND to_regprocedure('public.web_get_visible_tasks_scope_v2(text,text[],integer,text)') IS NOT NULL
        AND to_regprocedure('public.mcp_get_department_okrs_scope_v2(text,text,integer,text,boolean,integer)') IS NOT NULL
        AS required_functions,
      COALESCE(has_function_privilege(
        'authenticated',
        to_regprocedure('public.web_get_department_review_capability(text)'),
        'EXECUTE'
      ), FALSE)
        AND COALESCE(has_function_privilege(
          'authenticated',
          to_regprocedure('public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])'),
          'EXECUTE'
        ), FALSE)
        AND NOT COALESCE(has_function_privilege(
          'anon',
          to_regprocedure('public.web_get_department_review_capability(text)'),
          'EXECUTE'
        ), FALSE)
        AND NOT COALESCE(has_function_privilege(
          'anon',
          to_regprocedure('public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])'),
          'EXECUTE'
        ), FALSE)
        AND COALESCE(has_function_privilege(
          'authenticated',
          to_regprocedure('public.mcp_update_pad_task(text,jsonb,bigint,text)'),
          'EXECUTE'
        ), FALSE)
        AND NOT COALESCE(has_function_privilege(
          'anon',
          to_regprocedure('public.mcp_update_pad_task(text,jsonb,bigint,text)'),
          'EXECUTE'
        ), FALSE)
        AS function_privileges
    FROM expected
    LEFT JOIN contract ON TRUE
  )
  SELECT jsonb_build_object(
    'status', CASE
      WHEN required_migrations AND required_functions AND function_privileges THEN 'ready'
      ELSE 'degraded'
    END,
    'reason', CASE
      WHEN required_migrations AND required_functions AND function_privileges THEN NULL
      ELSE 'RELEASE_CONTRACT_MISMATCH'
    END,
    'releaseId', release_id,
    'migrationVersion', '2026-09-01_web_child_department_review_readiness_gate',
    'manifestDigest', manifest_digest,
    'requiredMigrations', COALESCE(required_migrations, FALSE),
    'functionPrivileges', COALESCE(function_privileges, FALSE),
    'deferredIndexes', deferred_indexes,
    'reviewCapabilityRpc', to_regprocedure('public.web_get_department_review_capability(text)') IS NOT NULL,
    'reviewAtomicSubmitRpc', to_regprocedure('public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])') IS NOT NULL,
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
