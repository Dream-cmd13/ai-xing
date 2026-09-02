-- Final release gate for date-derived task week bindings.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_get_readiness()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH expected AS (
    SELECT '2026-09-01-task-date-weeks'::TEXT AS release_id,
      '9061382fd04ea9deb77565a3c90ffb82f9e49a8da1a20a94000783604392bf5c'::TEXT AS manifest_digest,
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
      "2026-09-01_web_child_department_review_contract",
      "2026-09-01_web_child_department_review_readiness_gate",
      "2026-09-01_task_date_derived_week_binding_contract"
    ]'::JSONB AS required_versions
  ), contract AS (
    SELECT contract_row.*
    FROM mcp_internal.release_contracts AS contract_row
    JOIN expected ON expected.release_id = contract_row.release_id
  ), data_check AS (
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.tasks AS task_row
      WHERE CASE
        WHEN task_row.start_date IS NULL OR task_row.due_date IS NULL THEN TRUE
        WHEN task_row.start_date > task_row.due_date THEN TRUE
        WHEN (
          (
            date_trunc('week', (to_timestamp(task_row.due_date / 1000.0) AT TIME ZONE 'Asia/Shanghai'))::DATE
            - date_trunc('week', (to_timestamp(task_row.start_date / 1000.0) AT TIME ZONE 'Asia/Shanghai'))::DATE
          ) / 7
        ) + 1 > 53 THEN TRUE
        ELSE task_row.target_weeks IS DISTINCT FROM public.mcp_task_weeks_from_dates(
          task_row.start_date,
          task_row.due_date
        )
      END
    ) AS task_period_data_consistent
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
        AND to_regprocedure('public.mcp_task_weeks_from_dates(bigint,bigint)') IS NOT NULL
        AND to_regprocedure('public.mcp_enforce_task_date_weeks()') IS NOT NULL
        AS required_functions,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgname = 'mcp_enforce_task_date_weeks_trigger'
          AND trigger_row.tgrelid = 'public.tasks'::regclass
          AND NOT trigger_row.tgisinternal
      ) AS task_date_week_trigger,
      COALESCE(has_function_privilege(
        'authenticated', to_regprocedure('public.web_get_department_review_capability(text)'), 'EXECUTE'
      ), FALSE)
        AND COALESCE(has_function_privilege(
          'authenticated', to_regprocedure('public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])'), 'EXECUTE'
        ), FALSE)
        AND COALESCE(has_function_privilege(
          'authenticated', to_regprocedure('public.mcp_update_pad_task(text,jsonb,bigint,text)'), 'EXECUTE'
        ), FALSE)
        AND NOT COALESCE(has_function_privilege(
          'anon', to_regprocedure('public.web_get_department_review_capability(text)'), 'EXECUTE'
        ), FALSE)
        AND NOT COALESCE(has_function_privilege(
          'anon', to_regprocedure('public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])'), 'EXECUTE'
        ), FALSE)
        AND NOT COALESCE(has_function_privilege(
          'anon', to_regprocedure('public.mcp_update_pad_task(text,jsonb,bigint,text)'), 'EXECUTE'
        ), FALSE)
        AND NOT COALESCE(has_function_privilege(
          'anon', to_regprocedure('public.mcp_task_weeks_from_dates(bigint,bigint)'), 'EXECUTE'
        ), FALSE)
        AND NOT COALESCE(has_function_privilege(
          'authenticated', to_regprocedure('public.mcp_task_weeks_from_dates(bigint,bigint)'), 'EXECUTE'
        ), FALSE)
        AS function_privileges,
      data_check.task_period_data_consistent
    FROM expected
    CROSS JOIN data_check
    LEFT JOIN contract ON TRUE
  )
  SELECT jsonb_build_object(
    'status', CASE
      WHEN required_migrations AND required_functions AND function_privileges
        AND task_date_week_trigger AND task_period_data_consistent THEN 'ready'
      ELSE 'degraded'
    END,
    'reason', CASE
      WHEN required_migrations AND required_functions AND function_privileges
        AND task_date_week_trigger AND task_period_data_consistent THEN NULL
      WHEN NOT task_period_data_consistent THEN 'TASK_PERIOD_DATA_INCONSISTENT'
      ELSE 'RELEASE_CONTRACT_MISMATCH'
    END,
    'releaseId', release_id,
    'migrationVersion', '2026-09-01_task_date_derived_week_binding_readiness_gate',
    'manifestDigest', manifest_digest,
    'requiredMigrations', COALESCE(required_migrations, FALSE),
    'functionPrivileges', COALESCE(function_privileges, FALSE),
    'deferredIndexes', deferred_indexes,
    'taskDateWeekFunction', to_regprocedure('public.mcp_task_weeks_from_dates(bigint,bigint)') IS NOT NULL,
    'taskDateWeekTrigger', COALESCE(task_date_week_trigger, FALSE),
    'taskPeriodDataConsistent', COALESCE(task_period_data_consistent, FALSE),
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
