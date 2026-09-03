-- Remove the task title upper bound while preserving the non-blank rule.
-- This is a follow-up migration: previously applied migrations remain unchanged.

BEGIN;

DO $$
DECLARE
  v_signature TEXT;
  v_function REGPROCEDURE;
  v_before TEXT;
  v_after TEXT;
  v_readiness_before TEXT;
  v_readiness_after TEXT;
  v_signatures CONSTANT TEXT[] := ARRAY[
    'public.mcp_validate_task_changes(jsonb,boolean)',
    'public.mcp_create_pad_task(jsonb,text)',
    'public.mcp_create_pad_task_scoped(jsonb,text)',
    'public.mcp_update_pad_task(text,jsonb,bigint,text)',
    'public.mcp_update_pad_task_scoped(text,jsonb,bigint,text)',
    'public.mcp_update_pad_task_with_review_sync(text,jsonb,text,text,integer,bigint,bigint,text)',
    'public.mcp_update_pad_task_with_review_sync_scoped(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])',
    'public.mcp_update_pad_task_impl_20260901(text,jsonb,bigint,text)',
    'public.mcp_update_pad_task_scoped_impl_20260901(text,jsonb,bigint,text)',
    'public.mcp_review_sync_impl_20260901(text,jsonb,text,text,integer,bigint,bigint,text)',
    'public.mcp_review_sync_scoped_impl_20260901(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NULL THEN
      CONTINUE;
    END IF;

    SELECT pg_get_functiondef(v_function) INTO v_before;
    v_after := v_before;

    -- These are the title checks present in the previously published write
    -- functions. Removing only the upper-bound clause keeps the blank-title
    -- check and every other validation rule intact.
    v_after := replace(v_after, ' OR length(p_changes->>''title'') > 200', '');
    v_after := replace(v_after, ' OR length(p_task->>''title'') > 200', '');
    v_after := replace(v_after, ' OR length(task_input->>''title'') > 200', '');
    v_after := replace(v_after, ' OR length(v_task->>''title'') > 200', '');
    v_after := replace(v_after, 'MCP_VALIDATION: title 长度必须在 1 到 200 个字符之间', 'MCP_VALIDATION: title 必填');
    v_after := replace(v_after, 'MCP_VALIDATION: title 必填且长度不能超过 200', 'MCP_VALIDATION: title 必填');

    IF v_after <> v_before THEN
      EXECUTE v_after;
    END IF;
  END LOOP;

  -- Publish a new release contract in this migration. As the contract file is
  -- excluded from the manifest digest, the digest below is not circular.
  v_function := to_regprocedure('public.mcp_get_readiness()');
  IF v_function IS NOT NULL THEN
    SELECT pg_get_functiondef(v_function) INTO v_readiness_before;
    v_readiness_after := v_readiness_before;
    v_readiness_after := replace(v_readiness_after, '2026-09-01-task-date-weeks', '2026-09-03-task-title-unbounded');
    v_readiness_after := replace(v_readiness_after, '9061382fd04ea9deb77565a3c90ffb82f9e49a8da1a20a94000783604392bf5c', 'd75620aa041aad362e91a67b58ac8727ba964bfe377abea9d8d3668900e4cac7');
    v_readiness_after := replace(
      v_readiness_after,
      '"2026-09-01_task_date_derived_week_binding_contract"\n    ]',
      '"2026-09-01_task_date_derived_week_binding_contract",\n      "2026-09-01_task_date_derived_week_binding_readiness_gate"\n    ]'
    );
    v_readiness_after := replace(
      v_readiness_after,
      '2026-09-01_task_date_derived_week_binding_readiness_gate',
      '2026-09-03_mcp_task_title_unbounded'
    );
    IF v_readiness_after <> v_readiness_before THEN
      EXECUTE v_readiness_after;
    END IF;
  END IF;
END;
$$;

COMMIT;
