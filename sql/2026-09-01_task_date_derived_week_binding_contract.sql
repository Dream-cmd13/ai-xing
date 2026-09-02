-- Enforce date-derived task week bindings without changing historical rows.

BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_task_weeks_from_dates(
  p_start_date BIGINT,
  p_due_date BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_start_day DATE;
  v_due_day DATE;
  v_first_monday DATE;
  v_last_monday DATE;
  v_week_count INTEGER;
  v_result JSONB;
BEGIN
  IF p_start_date IS NULL OR p_due_date IS NULL OR p_start_date < 0 OR p_due_date < 0 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务开始和截止日期必须完整';
  END IF;

  v_start_day := (to_timestamp(p_start_date / 1000.0) AT TIME ZONE 'Asia/Shanghai')::DATE;
  v_due_day := (to_timestamp(p_due_date / 1000.0) AT TIME ZONE 'Asia/Shanghai')::DATE;
  IF v_start_day > v_due_day THEN
    RAISE EXCEPTION 'MCP_VALIDATION: due_date 不能早于 start_date';
  END IF;

  v_first_monday := date_trunc('week', v_start_day::TIMESTAMP)::DATE;
  v_last_monday := date_trunc('week', v_due_day::TIMESTAMP)::DATE;
  v_week_count := ((v_last_monday - v_first_monday) / 7) + 1;
  IF v_week_count > 53 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务日期跨度最多覆盖 53 个 ISO 周';
  END IF;

  SELECT jsonb_agg(to_char(week_start, 'IYYY-"W"IW') ORDER BY week_start)
  INTO v_result
  FROM generate_series(v_first_monday, v_last_monday, INTERVAL '7 days') AS week_start;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('public.mcp_validate_task_changes_impl_date_weeks_20260901(jsonb,boolean)') IS NULL THEN
    ALTER FUNCTION public.mcp_validate_task_changes(JSONB, BOOLEAN)
      RENAME TO mcp_validate_task_changes_impl_date_weeks_20260901;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_validate_task_changes(
  p_changes JSONB,
  p_allow_submitted BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_expected_weeks JSONB;
BEGIN
  PERFORM public.mcp_validate_task_changes_impl_date_weeks_20260901(p_changes, p_allow_submitted);

  IF p_changes ? 'start_date'
     AND p_changes ? 'due_date'
     AND p_changes ? 'target_weeks'
     AND jsonb_typeof(p_changes->'start_date') <> 'null'
     AND jsonb_typeof(p_changes->'due_date') <> 'null' THEN
    v_expected_weeks := public.mcp_task_weeks_from_dates(
      (p_changes->>'start_date')::BIGINT,
      (p_changes->>'due_date')::BIGINT
    );
    IF p_changes->'target_weeks' IS DISTINCT FROM v_expected_weeks THEN
      RAISE EXCEPTION 'MCP_TASK_PERIOD_MISMATCH: target_weeks 与任务日期派生周不一致';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_enforce_task_date_weeks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected_weeks JSONB;
  v_dates_changed BOOLEAN;
  v_weeks_changed BOOLEAN;
BEGIN
  IF NEW.start_date IS NULL OR NEW.due_date IS NULL THEN
    RAISE EXCEPTION 'MCP_VALIDATION: 任务开始和截止日期必须完整';
  END IF;

  v_expected_weeks := public.mcp_task_weeks_from_dates(NEW.start_date, NEW.due_date);
  IF TG_OP = 'INSERT' THEN
    IF NEW.target_weeks IS NULL OR NEW.target_weeks = '[]'::JSONB THEN
      NEW.target_weeks := v_expected_weeks;
    ELSIF NEW.target_weeks IS DISTINCT FROM v_expected_weeks THEN
      RAISE EXCEPTION 'MCP_TASK_PERIOD_MISMATCH: target_weeks 与任务日期派生周不一致';
    END IF;
    RETURN NEW;
  END IF;

  v_dates_changed := NEW.start_date IS DISTINCT FROM OLD.start_date
    OR NEW.due_date IS DISTINCT FROM OLD.due_date;
  v_weeks_changed := NEW.target_weeks IS DISTINCT FROM OLD.target_weeks;
  IF v_dates_changed AND NOT v_weeks_changed THEN
    NEW.target_weeks := v_expected_weeks;
  ELSIF NEW.target_weeks IS DISTINCT FROM v_expected_weeks THEN
    RAISE EXCEPTION 'MCP_TASK_PERIOD_MISMATCH: target_weeks 与任务日期派生周不一致';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mcp_enforce_task_date_weeks_trigger ON public.tasks;
CREATE TRIGGER mcp_enforce_task_date_weeks_trigger
  BEFORE INSERT OR UPDATE OF start_date, due_date, target_weeks ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.mcp_enforce_task_date_weeks();

REVOKE ALL ON FUNCTION public.mcp_task_weeks_from_dates(BIGINT, BIGINT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_validate_task_changes_impl_date_weeks_20260901(JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_validate_task_changes(JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_enforce_task_date_weeks() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
