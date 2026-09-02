-- Read-only task-period and historical review-reference diagnostic.

WITH RECURSIVE raw_tasks AS (
  SELECT
    t.id AS task_id,
    t.department_id,
    t.start_date,
    t.due_date,
    t.row_version,
    CASE
      WHEN jsonb_typeof(t.target_weeks) = 'array' THEN t.target_weeks
      ELSE '[]'::JSONB
    END AS stored_weeks,
    CASE
      WHEN t.start_date IS NOT NULL AND t.due_date IS NOT NULL AND t.start_date <= t.due_date
      THEN (to_timestamp(t.start_date / 1000.0) AT TIME ZONE 'Asia/Shanghai')::DATE
      ELSE NULL
    END AS start_day,
    CASE
      WHEN t.start_date IS NOT NULL AND t.due_date IS NOT NULL AND t.start_date <= t.due_date
      THEN (to_timestamp(t.due_date / 1000.0) AT TIME ZONE 'Asia/Shanghai')::DATE
      ELSE NULL
    END AS due_day
  FROM public.tasks AS t
), task_periods AS (
  SELECT
    raw_tasks.*,
    derived.expected_weeks,
    derived.week_count
  FROM raw_tasks
  LEFT JOIN LATERAL (
    SELECT
      count(*)::INTEGER AS week_count,
      jsonb_agg(to_char(week_start, 'IYYY-"W"IW') ORDER BY week_start) AS expected_weeks
    FROM generate_series(
      date_trunc('week', raw_tasks.start_day::TIMESTAMP),
      date_trunc('week', raw_tasks.due_day::TIMESTAMP),
      INTERVAL '7 days'
    ) AS week_start
    WHERE raw_tasks.start_day IS NOT NULL AND raw_tasks.due_day IS NOT NULL
  ) AS derived ON TRUE
), task_diagnostics AS (
  SELECT
    task_periods.*,
    COALESCE((
      SELECT jsonb_agg(value ORDER BY value)
      FROM jsonb_array_elements_text(task_periods.stored_weeks) AS current_week(value)
      WHERE task_periods.expected_weeks IS NULL OR NOT (task_periods.expected_weeks ? value)
    ), '[]'::JSONB) AS extra_weeks,
    COALESCE((
      SELECT jsonb_agg(value ORDER BY value)
      FROM jsonb_array_elements_text(COALESCE(task_periods.expected_weeks, '[]'::JSONB)) AS expected_week(value)
      WHERE NOT (task_periods.stored_weeks ? value)
    ), '[]'::JSONB) AS missing_weeks,
    CASE
      WHEN task_periods.start_date IS NULL OR task_periods.due_date IS NULL THEN 'MISSING_DATE'
      WHEN task_periods.start_date > task_periods.due_date THEN 'DATE_RANGE_REVERSED'
      WHEN task_periods.week_count > 53 THEN 'DATE_RANGE_TOO_LONG'
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(task_periods.stored_weeks) AS stored_week(value)
        WHERE CASE
          WHEN value ~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
          THEN to_char(to_date(value, 'IYYY-"W"IW'), 'IYYY-"W"IW') <> value
          ELSE TRUE
        END
      ) THEN 'INVALID_WEEK'
      WHEN task_periods.stored_weeks IS DISTINCT FROM task_periods.expected_weeks THEN 'WEEK_MISMATCH'
      ELSE NULL
    END AS reason
  FROM task_periods
), department_nodes AS (
  SELECT
    d.id AS department_id,
    jsonb_build_object(
      'id', d.id,
      'reviews', COALESCE(d.reviews, '{}'::JSONB),
      'subDepartments', COALESCE(d.sub_departments, '[]'::JSONB)
    ) AS node
  FROM public.departments AS d
  UNION ALL
  SELECT
    COALESCE(child.node->>'id', child.node->>'departmentId') AS department_id,
    child.node
  FROM department_nodes AS parent
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(parent.node->'subDepartments', parent.node->'sub_departments', '[]'::JSONB)
  ) AS child(node)
), review_entries AS (
  SELECT
    department_nodes.department_id,
    period_entry.key AS review_period_key,
    review_entry.value AS review_entry
  FROM department_nodes
  CROSS JOIN LATERAL jsonb_each(COALESCE(department_nodes.node->'reviews', '{}'::JSONB)) AS period_entry(key, value)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(period_entry.value) = 'array' THEN period_entry.value ELSE '[]'::JSONB END
  ) AS review_entry(value)
), review_task_references AS (
  SELECT DISTINCT
    review_entries.department_id,
    review_entries.review_period_key,
    referenced_task.task_id
  FROM review_entries
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(review_entries.review_entry->'okrDetails') = 'object'
      THEN review_entries.review_entry->'okrDetails' ELSE '{}'::JSONB END
  ) AS objective_entry(key, value)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(objective_entry.value->'krReviews') = 'array'
      THEN objective_entry.value->'krReviews' ELSE '[]'::JSONB END
  ) AS kr_entry(value)
  CROSS JOIN LATERAL (
    SELECT task_key AS task_id
    FROM jsonb_object_keys(
      CASE WHEN jsonb_typeof(kr_entry.value->'taskEvaluations') = 'object'
        THEN kr_entry.value->'taskEvaluations' ELSE '{}'::JSONB END
    ) AS task_key
    UNION
    SELECT task_key AS task_id
    FROM jsonb_object_keys(
      CASE WHEN jsonb_typeof(kr_entry.value->'taskScores') = 'object'
        THEN kr_entry.value->'taskScores' ELSE '{}'::JSONB END
    ) AS task_key
  ) AS referenced_task
)
SELECT
  'TASK_PERIOD'::TEXT AS record_type,
  task_diagnostics.task_id,
  task_diagnostics.department_id,
  task_diagnostics.start_date,
  task_diagnostics.due_date,
  task_diagnostics.row_version,
  task_diagnostics.stored_weeks AS current_weeks,
  COALESCE(task_diagnostics.expected_weeks, '[]'::JSONB) AS expected_weeks,
  task_diagnostics.extra_weeks,
  task_diagnostics.missing_weeks,
  NULL::TEXT AS review_period_key,
  task_diagnostics.reason
FROM task_diagnostics
WHERE task_diagnostics.reason IS NOT NULL
UNION ALL
SELECT
  'REVIEW_REFERENCE'::TEXT AS record_type,
  task_diagnostics.task_id,
  review_task_references.department_id,
  task_diagnostics.start_date,
  task_diagnostics.due_date,
  task_diagnostics.row_version,
  task_diagnostics.stored_weeks AS current_weeks,
  COALESCE(task_diagnostics.expected_weeks, '[]'::JSONB) AS expected_weeks,
  '[]'::JSONB AS extra_weeks,
  '[]'::JSONB AS missing_weeks,
  review_task_references.review_period_key,
  'REVIEW_PERIOD_NOT_IN_DERIVED_WEEKS'::TEXT AS reason
FROM review_task_references
JOIN task_diagnostics ON task_diagnostics.task_id = review_task_references.task_id
WHERE review_task_references.review_period_key ~ '^\d{4}-W'
  AND (
    task_diagnostics.expected_weeks IS NULL
    OR NOT (task_diagnostics.expected_weeks ? review_task_references.review_period_key)
  )
ORDER BY task_id, record_type, review_period_key;
