-- Normalize legacy OKR JSON shapes for all MCP OKR readers.
-- Additive: no business rows are rewritten and no permission policy is widened.
BEGIN;

CREATE OR REPLACE FUNCTION public.mcp_okr_text(p_value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_text TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_value) IN ('string', 'number', 'boolean') THEN
    RETURN NULLIF(btrim(p_value #>> '{}'), '');
  END IF;
  IF jsonb_typeof(p_value) <> 'object' THEN
    RETURN NULL;
  END IF;
  FOREACH v_key IN ARRAY ARRAY['text', 'name', 'title', 'description', 'value', 'label'] LOOP
    v_text := NULLIF(btrim(p_value->>v_key), '');
    IF v_text IS NOT NULL THEN
      RETURN v_text;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_okr_id(p_okr JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(btrim(COALESCE(p_okr->>'id', p_okr->>'okrId', p_okr->>'goalId')), '');
$$;

CREATE OR REPLACE FUNCTION public.mcp_okr_objective(p_okr JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_text TEXT;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['objective', 'title', 'goal', 'description'] LOOP
    v_text := public.mcp_okr_text(p_okr->v_key);
    IF v_text IS NOT NULL THEN
      RETURN v_text;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_okr_key_results_raw(p_okr JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_value JSONB;
  v_key TEXT;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['keyResults', 'key_results', 'krs'] LOOP
    v_value := p_okr->v_key;
    IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(v_value) = 'array' THEN
      RETURN v_value;
    END IF;
    IF jsonb_typeof(v_value) = 'object' THEN
      FOREACH v_key IN ARRAY ARRAY['items', 'results', 'values', 'list'] LOOP
        IF jsonb_typeof(v_value->v_key) = 'array' THEN
          RETURN v_value->v_key;
        END IF;
      END LOOP;
      RETURN (
        SELECT COALESCE(jsonb_agg(value ORDER BY key), '[]'::JSONB)
        FROM jsonb_each(v_value)
      );
    END IF;
    RETURN v_value;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_okr_key_results(p_okr JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_raw JSONB := public.mcp_okr_key_results_raw(p_okr);
  v_item JSONB;
  v_result JSONB := '[]'::JSONB;
BEGIN
  IF v_raw IS NULL OR jsonb_typeof(v_raw) <> 'array' THEN
    RETURN '[]'::JSONB;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_raw) LOOP
    -- Keep empty slots so legacy aligned_kr_id indexes never shift.
    v_result := v_result || jsonb_build_array(COALESCE(public.mcp_okr_text(v_item), ''));
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_normalize_okr_entry(p_okr JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_id TEXT := public.mcp_okr_id(p_okr);
  v_objective TEXT := public.mcp_okr_objective(p_okr);
  v_raw_krs JSONB := public.mcp_okr_key_results_raw(p_okr);
  v_krs JSONB := public.mcp_okr_key_results(p_okr);
  v_item JSONB;
  v_issues JSONB := '[]'::JSONB;
  v_kr_count INTEGER := jsonb_array_length(v_krs);
BEGIN
  IF v_id IS NULL THEN
    v_issues := v_issues || jsonb_build_array('OKR_ID_MISSING');
  END IF;
  IF v_objective IS NULL THEN
    v_issues := v_issues || jsonb_build_array('OKR_OBJECTIVE_MISSING');
  END IF;
  IF v_raw_krs IS NULL THEN
    v_issues := v_issues || jsonb_build_array('KR_MISSING');
  ELSIF jsonb_typeof(v_raw_krs) <> 'array' THEN
    v_issues := v_issues || jsonb_build_array('KR_FORMAT_INVALID');
  ELSE
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_raw_krs) LOOP
      IF public.mcp_okr_text(v_item) IS NULL THEN
        v_issues := v_issues || jsonb_build_array('KR_ITEM_INVALID');
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_kr_count > 101 THEN
    v_issues := v_issues || jsonb_build_array('KR_COUNT_OVER_LIMIT');
  END IF;

  -- MCP keeps the public payload bounded while krCount retains the real count.
  IF v_kr_count > 20 THEN
    v_krs := (
      SELECT COALESCE(jsonb_agg(value ORDER BY ordinality), '[]'::JSONB)
      FROM jsonb_array_elements(v_krs) WITH ORDINALITY AS entries(value, ordinality)
      WHERE ordinality <= 20
    );
  END IF;

  IF jsonb_array_length(v_issues) = 0 THEN
    RETURN jsonb_build_object(
      'id', v_id,
      'objective', COALESCE(v_objective, ''),
      'keyResults', v_krs,
      'krCount', v_kr_count,
      'truncated', v_kr_count > 20
    );
  END IF;
  RETURN jsonb_build_object(
    'id', v_id,
    'objective', COALESCE(v_objective, ''),
    'keyResults', v_krs,
    'krCount', v_kr_count,
    'truncated', v_kr_count > 20,
    'dataQuality', jsonb_build_object('valid', false, 'issues', v_issues)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mcp_normalize_okr_entries(p_okrs JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_result JSONB := '[]'::JSONB;
  v_okr JSONB;
  v_count INTEGER := 0;
BEGIN
  IF p_okrs IS NULL OR jsonb_typeof(p_okrs) <> 'array' THEN
    RETURN '[]'::JSONB;
  END IF;
  FOR v_okr IN SELECT value FROM jsonb_array_elements(p_okrs) LOOP
    IF v_okr IS NULL OR jsonb_typeof(v_okr) <> 'object' THEN
      CONTINUE;
    END IF;
    v_count := v_count + 1;
    IF v_count <= 20 THEN
      v_result := v_result || jsonb_build_array(public.mcp_normalize_okr_entry(v_okr));
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

-- Replace the recursive collector so nested department and legacy RPC paths
-- use the same normalized OKR projection and support omitted years.
CREATE OR REPLACE FUNCTION public.mcp_collect_department_okr_nodes(
  p_node JSONB,
  p_year INTEGER,
  p_period TEXT,
  p_parent_name TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_result JSONB := '[]'::JSONB;
  v_child JSONB;
  v_okrs JSONB;
  v_year_okrs JSONB;
  v_periods JSONB := '{}'::JSONB;
  v_period_key TEXT;
  v_period_value JSONB;
  v_okr_list JSONB;
  v_okr JSONB;
  v_effective_year INTEGER := COALESCE(p_year, (EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Shanghai')))::INTEGER);
BEGIN
  IF p_node IS NULL OR jsonb_typeof(p_node) <> 'object' THEN
    RETURN '[]'::JSONB;
  END IF;

  IF public.current_user_has_department_visibility(p_node->>'id') THEN
    v_okrs := p_node->'okrs';
    IF v_okrs IS NOT NULL AND jsonb_typeof(v_okrs) = 'object' THEN
      v_year_okrs := COALESCE(v_okrs->v_effective_year::TEXT, v_okrs->(to_jsonb(v_effective_year)::TEXT));
      IF v_year_okrs IS NOT NULL AND jsonb_typeof(v_year_okrs) = 'object' THEN
        FOR v_period_key, v_period_value IN SELECT * FROM jsonb_each(v_year_okrs) LOOP
          IF (p_period IS NULL OR v_period_key = p_period)
             AND jsonb_typeof(v_period_value) = 'array'
             AND jsonb_array_length(v_period_value) > 0 THEN
            v_okr_list := public.mcp_normalize_okr_entries(v_period_value);
            IF jsonb_array_length(v_okr_list) > 0 THEN
              v_periods := v_periods || jsonb_build_object(v_period_key, v_okr_list);
            END IF;
          END IF;
        END LOOP;
      END IF;
    END IF;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'id', p_node->>'id',
      'name', COALESCE(p_node->>'name', ''),
      'managerName', COALESCE(p_node->>'managerName', p_node->>'manager_name', ''),
      'parentName', p_parent_name,
      'periods', v_periods
    ));
  END IF;

  FOR v_child IN
    SELECT value FROM jsonb_array_elements(public.mcp_nested_department_children(p_node))
  LOOP
    v_result := v_result || public.mcp_collect_department_okr_nodes(
      v_child, v_effective_year, p_period, COALESCE(p_node->>'name', '')
    );
  END LOOP;
  RETURN v_result;
END;
$$;

-- Company data may be year-keyed or a direct array in older snapshots.
CREATE OR REPLACE FUNCTION public.mcp_get_company_okrs(
  p_year INTEGER DEFAULT NULL,
  p_include_tasks BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_year INTEGER := COALESCE(p_year, (EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Shanghai')))::INTEGER);
  v_company_okrs JSONB;
  v_year_okrs JSONB;
  v_okrs JSONB;
BEGIN
  IF v_year < 2000 OR v_year > 3000 THEN
    RAISE EXCEPTION 'MCP_VALIDATION: invalid year';
  END IF;
  SELECT company_okrs INTO v_company_okrs FROM public.strategy WHERE id = 'default';
  IF jsonb_typeof(v_company_okrs) = 'array' THEN
    v_year_okrs := v_company_okrs;
  ELSIF jsonb_typeof(v_company_okrs) = 'object' THEN
    v_year_okrs := COALESCE(v_company_okrs->v_year::TEXT, v_company_okrs->(to_jsonb(v_year)::TEXT));
  END IF;
  v_okrs := CASE WHEN jsonb_typeof(v_year_okrs) = 'array' THEN v_year_okrs ELSE '[]'::JSONB END;
  v_okrs := public.mcp_normalize_okr_entries(v_okrs);
  IF COALESCE(p_include_tasks, TRUE) THEN
    v_okrs := public.mcp_attach_tasks_to_okrs(v_okrs);
  END IF;
  RETURN jsonb_build_object('year', v_year, 'okrCount', jsonb_array_length(v_okrs), 'okrs', v_okrs);
END;
$$;

-- Keep readiness truthful after this migration instead of a hard-coded date.
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

REVOKE ALL ON FUNCTION public.mcp_okr_text(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_okr_id(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_okr_objective(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_okr_key_results_raw(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_okr_key_results(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_normalize_okr_entry(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_normalize_okr_entries(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_collect_department_okr_nodes(JSONB, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mcp_get_company_okrs(INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_get_company_okrs(INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_get_readiness() TO anon, authenticated;

COMMIT;
