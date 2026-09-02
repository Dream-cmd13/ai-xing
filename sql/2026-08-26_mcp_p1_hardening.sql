-- Phase 2 P1 hardening, local/test Supabase only.
-- This migration does not change application tables, RLS policies, or website RPCs.
-- save_review_record is deliberately limited to department-level review content.
BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_review_entry_has_task_fields(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  child JSONB;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) NOT IN ('object', 'array') THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    IF p_value ? 'taskEvaluations' OR p_value ? 'taskScores' THEN
      RETURN true;
    END IF;
    FOR child IN SELECT value FROM jsonb_each(p_value) LOOP
      IF public.mcp_review_entry_has_task_fields(child) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSE
    FOR child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF public.mcp_review_entry_has_task_fields(child) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

ALTER FUNCTION public.mcp_save_review_record(TEXT, TEXT, JSONB, BIGINT, TEXT)
  RENAME TO mcp_save_review_record_impl_20260826;

CREATE OR REPLACE FUNCTION public.mcp_save_review_record(
  p_department_id TEXT,
  p_period_key TEXT,
  p_entry JSONB,
  p_expected_row_version BIGINT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_entry IS NOT NULL
     AND jsonb_typeof(p_entry) = 'object'
     AND public.mcp_review_entry_has_task_fields(p_entry->'okrDetails') THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务复盘请通过 commit_update_pad_task 提交';
  END IF;

  RETURN public.mcp_save_review_record_impl_20260826(
    p_department_id,
    p_period_key,
    p_entry,
    p_expected_row_version,
    p_request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_review_entry_has_task_fields(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_save_review_record_impl_20260826(TEXT, TEXT, JSONB, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_save_review_record(TEXT, TEXT, JSONB, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_save_review_record(TEXT, TEXT, JSONB, BIGINT, TEXT)
  TO authenticated;

COMMIT;
