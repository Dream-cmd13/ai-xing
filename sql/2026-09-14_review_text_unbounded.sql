-- Remove application-level character limits from the three approved review
-- text fields without changing table definitions or historical data.

BEGIN;

DO $$
DECLARE
  v_signature TEXT;
  v_function REGPROCEDURE;
  v_before TEXT;
  v_normalized TEXT;
  v_after TEXT;
  v_actual TEXT;
  v_signatures CONSTANT TEXT[] := ARRAY[
    'public.mcp_create_pad_task(jsonb,text)',
    'public.mcp_review_sync_scoped_impl_20260901(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])',
    'public.mcp_save_review_record_impl_20260826(text,text,jsonb,bigint,text)',
    'public.mcp_save_review_record_scoped(text,text,jsonb,bigint,text,text,text[])',
    'public.mcp_update_pad_task_impl_20260901(text,jsonb,bigint,text)',
    'public.mcp_update_pad_task_with_review_sync_impl_20260827(text,jsonb,text,text,integer,bigint,bigint,text)',
    'public.mcp_validate_task_changes_impl_date_weeks_20260901(jsonb,boolean)',
    'public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'MCP_REVIEW_TEXT_PATCH_FAILED: required function is missing: %', v_signature;
    END IF;

    SELECT pg_get_functiondef(v_function) INTO v_before;
    v_normalized := replace(v_before, E'\r\n', E'\n');
    v_after := v_normalized;

    CASE v_signature
      WHEN 'public.mcp_create_pad_task(jsonb,text)' THEN
        v_after := replace(
          v_after,
          'ARRAY[''plan'', ''action'', ''deliverable'']',
          'ARRAY[''plan'', ''action'']'
        );

      WHEN 'public.mcp_update_pad_task_impl_20260901(text,jsonb,bigint,text)',
           'public.mcp_update_pad_task_with_review_sync_impl_20260827(text,jsonb,text,text,integer,bigint,bigint,text)' THEN
        v_after := replace(
          v_after,
          'ARRAY[''plan'', ''action'', ''deliverable'', ''task_review'']',
          'ARRAY[''plan'', ''action'']'
        );

      WHEN 'public.mcp_review_sync_scoped_impl_20260901(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])' THEN
        v_after := replace(
          v_after,
          '  IF p_changes ? ''task_review'' AND length(p_changes->>''task_review'') > 2000 THEN RAISE EXCEPTION ''MCP_VALIDATION: task_review 长度不能超过 2000''; END IF;',
          '  -- task_review has no application-level character limit.'
        );

      WHEN 'public.mcp_save_review_record_impl_20260826(text,text,jsonb,bigint,text)' THEN
        v_after := replace(
          v_after,
          'IF COALESCE(length(btrim(p_entry->>''content'')), 0) = 0 OR length(p_entry->>''content'') > 2000 THEN',
          'IF COALESCE(length(btrim(p_entry->>''content'')), 0) = 0 THEN'
        );
        v_after := replace(
          v_after,
          'MCP_VALIDATION: content 必填且长度不能超过 2000',
          'MCP_VALIDATION: content 必填'
        );

      WHEN 'public.mcp_save_review_record_scoped(text,text,jsonb,bigint,text,text,text[])' THEN
        v_after := replace(
          v_after,
          E'\n     OR length(p_entry->>''content'') > 2000',
          ''
        );

      WHEN 'public.mcp_validate_task_changes_impl_date_weeks_20260901(jsonb,boolean)' THEN
        v_after := replace(
          v_after,
          'jsonb_typeof(p_changes->v_key) <> ''string'' OR length(p_changes->>v_key) > 2000',
          'jsonb_typeof(p_changes->v_key) <> ''string'' OR (v_key IN (''plan'', ''action'') AND length(p_changes->>v_key) > 2000)'
        );
        v_after := replace(
          v_after,
          'MCP_VALIDATION: % 长度不能超过 2000 个字符',
          'MCP_VALIDATION: % 类型无效或长度超过限制'
        );

      WHEN 'public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])' THEN
        v_after := replace(
          v_after,
          E'  IF length(COALESCE(p_entry->>''content'', '''')) > 2000 THEN\n    RAISE EXCEPTION ''MCP_VALIDATION: 复盘总结长度不能超过 2000 个字符'';\n  END IF;',
          '  -- content has no application-level character limit.'
        );
        v_after := replace(
          v_after,
          E'jsonb_typeof(v_changes->''deliverable'') <> ''string''\n      OR length(v_changes->>''deliverable'') > 2000',
          'jsonb_typeof(v_changes->''deliverable'') <> ''string'''
        );
        v_after := replace(
          v_after,
          'MCP_VALIDATION: deliverable 长度不能超过 2000 个字符',
          'MCP_VALIDATION: deliverable 必须是字符串'
        );
        v_after := replace(
          v_after,
          E'jsonb_typeof(v_changes->''taskReview'') <> ''string''\n      OR length(v_changes->>''taskReview'') > 2000',
          'jsonb_typeof(v_changes->''taskReview'') <> ''string'''
        );
        v_after := replace(
          v_after,
          'MCP_VALIDATION: taskReview 长度不能超过 2000 个字符',
          'MCP_VALIDATION: taskReview 必须是字符串'
        );
    END CASE;

    IF v_after = v_normalized THEN
      RAISE EXCEPTION 'MCP_REVIEW_TEXT_PATCH_FAILED: expected validation was not found: %', v_signature;
    END IF;

    EXECUTE v_after;

    SELECT replace(pg_get_functiondef(to_regprocedure(v_signature)), E'\r\n', E'\n')
    INTO v_actual;

    CASE v_signature
      WHEN 'public.mcp_create_pad_task(jsonb,text)' THEN
        IF position('ARRAY[''plan'', ''action'']' IN v_actual) = 0
           OR position('ARRAY[''plan'', ''action'', ''deliverable'']' IN v_actual) > 0 THEN
          RAISE EXCEPTION 'MCP_REVIEW_TEXT_POSTCONDITION_FAILED: %', v_signature;
        END IF;

      WHEN 'public.mcp_update_pad_task_impl_20260901(text,jsonb,bigint,text)',
           'public.mcp_update_pad_task_with_review_sync_impl_20260827(text,jsonb,text,text,integer,bigint,bigint,text)' THEN
        IF position('ARRAY[''plan'', ''action'']' IN v_actual) = 0
           OR position('ARRAY[''plan'', ''action'', ''deliverable'', ''task_review'']' IN v_actual) > 0 THEN
          RAISE EXCEPTION 'MCP_REVIEW_TEXT_POSTCONDITION_FAILED: %', v_signature;
        END IF;

      WHEN 'public.mcp_review_sync_scoped_impl_20260901(text,jsonb,text,text,integer,bigint,bigint,text,text,text[])' THEN
        IF position('task_review has no application-level character limit' IN v_actual) = 0
           OR position('length(p_changes->>''task_review'') > 2000' IN v_actual) > 0 THEN
          RAISE EXCEPTION 'MCP_REVIEW_TEXT_POSTCONDITION_FAILED: %', v_signature;
        END IF;

      WHEN 'public.mcp_save_review_record_impl_20260826(text,text,jsonb,bigint,text)' THEN
        IF position('COALESCE(length(btrim(p_entry->>''content'')), 0) = 0 THEN' IN v_actual) = 0
           OR position('length(p_entry->>''content'') > 2000' IN v_actual) > 0 THEN
          RAISE EXCEPTION 'MCP_REVIEW_TEXT_POSTCONDITION_FAILED: %', v_signature;
        END IF;

      WHEN 'public.mcp_save_review_record_scoped(text,text,jsonb,bigint,text,text,text[])' THEN
        IF position('COALESCE(length(btrim(p_entry->>''content'')), 0) = 0' IN v_actual) = 0
           OR position('length(p_entry->>''content'') > 2000' IN v_actual) > 0 THEN
          RAISE EXCEPTION 'MCP_REVIEW_TEXT_POSTCONDITION_FAILED: %', v_signature;
        END IF;

      WHEN 'public.mcp_validate_task_changes_impl_date_weeks_20260901(jsonb,boolean)' THEN
        IF position('v_key IN (''plan'', ''action'') AND length(p_changes->>v_key) > 2000' IN v_actual) = 0
           OR position('jsonb_typeof(p_changes->v_key) <> ''string'' OR length(p_changes->>v_key) > 2000' IN v_actual) > 0 THEN
          RAISE EXCEPTION 'MCP_REVIEW_TEXT_POSTCONDITION_FAILED: %', v_signature;
        END IF;

      WHEN 'public.web_submit_department_review_scoped(text,text,jsonb,jsonb,bigint,text,text,text[])' THEN
        IF position('content has no application-level character limit' IN v_actual) = 0
           OR position('length(COALESCE(p_entry->>''content'', '''')) > 2000' IN v_actual) > 0
           OR position('length(v_changes->>''deliverable'') > 2000' IN v_actual) > 0
           OR position('length(v_changes->>''taskReview'') > 2000' IN v_actual) > 0 THEN
          RAISE EXCEPTION 'MCP_REVIEW_TEXT_POSTCONDITION_FAILED: %', v_signature;
        END IF;
    END CASE;
  END LOOP;
END;
$$;

DO $$
DECLARE
  v_function REGPROCEDURE;
  v_readiness_before TEXT;
  v_readiness_after TEXT;
BEGIN
  v_function := to_regprocedure('public.mcp_get_readiness()');
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'MCP_RELEASE_CONTRACT_UPDATE_FAILED: readiness function is missing';
  END IF;

  SELECT pg_get_functiondef(v_function) INTO v_readiness_before;
  v_readiness_after := replace(v_readiness_before, E'\r\n', E'\n');
  v_readiness_after := replace(
    v_readiness_after,
    '2026-09-07-workbench-shanghai-day',
    '2026-09-14-review-text-unbounded'
  );
  v_readiness_after := replace(
    v_readiness_after,
    '624c3fdb85ce9702e9d7e64b1b9a38f24fcf76b1ecb280172e97ce448d543a97',
    '02093539289439df2e5081c4208ea41e0528d27b8cbe54b301070c36ab039376'
  );
  IF position('"2026-09-07_workbench_shanghai_calendar_day"' IN v_readiness_after) = 0 THEN
    v_readiness_after := replace(
      v_readiness_after,
      E'"2026-09-04_mcp_task_title_contract_fix"\n    ]',
      E'"2026-09-04_mcp_task_title_contract_fix",\n      "2026-09-07_workbench_shanghai_calendar_day"\n    ]'
    );
  END IF;
  v_readiness_after := replace(
    v_readiness_after,
    '''migrationVersion'', ''2026-09-07_workbench_shanghai_calendar_day''',
    '''migrationVersion'', ''2026-09-14_review_text_unbounded'''
  );

  IF position('2026-09-14-review-text-unbounded' IN v_readiness_after) = 0
     OR position('02093539289439df2e5081c4208ea41e0528d27b8cbe54b301070c36ab039376' IN v_readiness_after) = 0
     OR position('"2026-09-07_workbench_shanghai_calendar_day"' IN v_readiness_after) = 0
     OR position('''migrationVersion'', ''2026-09-14_review_text_unbounded''' IN v_readiness_after) = 0 THEN
    RAISE EXCEPTION 'MCP_RELEASE_CONTRACT_UPDATE_FAILED: readiness contract was not updated';
  END IF;

  EXECUTE v_readiness_after;
END;
$$;

COMMIT;
