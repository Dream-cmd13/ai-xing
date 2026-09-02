-- Read-only preflight scan for malformed task review data.
-- This file is not a migration and must not be added to the migration ledger.
-- It returns only object IDs, JSON paths and reason codes, never review content.

WITH RECURSIVE task_slot_issues AS (
  SELECT
    'task'::TEXT AS object_type,
    t.id AS object_id,
    'aligned_kr_id'::TEXT AS json_path,
    CASE
      WHEN length(t.aligned_kr_id) > 128 THEN 'ALIGNED_KR_ID_TOO_LONG'
      WHEN t.aligned_kr_id !~ '^(.+)-kr-([0-9]+)$' THEN 'ALIGNED_KR_ID_INVALID'
      WHEN length(substring(t.aligned_kr_id FROM '-kr-([0-9]+)$')) > 3 THEN 'KR_INDEX_OUT_OF_RANGE'
      WHEN substring(t.aligned_kr_id FROM '-kr-([0-9]+)$')::INTEGER > 100 THEN 'KR_INDEX_OUT_OF_RANGE'
      ELSE NULL
    END AS reason
  FROM public.tasks AS t
  WHERE t.aligned_kr_id IS NOT NULL AND btrim(t.aligned_kr_id) <> ''
), department_nodes AS (
  SELECT
    d.id AS root_id,
    d.id AS object_id,
    ARRAY[d.id]::TEXT[] AS node_path,
    jsonb_build_object(
      'reviews', d.reviews,
      'subDepartments', CASE
        WHEN jsonb_typeof(to_jsonb(d)->'sub_departments') = 'array' THEN to_jsonb(d)->'sub_departments'
        WHEN jsonb_typeof(to_jsonb(d)->'subDepartments') = 'array' THEN to_jsonb(d)->'subDepartments'
        ELSE '[]'::JSONB
      END
    ) AS node
  FROM public.departments AS d
  WHERE d.id IS NOT NULL
  UNION ALL
  SELECT
    parent.root_id,
    child.value->>'id' AS object_id,
    parent.node_path || (child.value->>'id'),
    child.value AS node
  FROM department_nodes AS parent
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(parent.node->'subDepartments') = 'array' THEN parent.node->'subDepartments'
      WHEN jsonb_typeof(parent.node->'sub_departments') = 'array' THEN parent.node->'sub_departments'
      ELSE '[]'::JSONB
    END
  ) AS child(value)
  WHERE jsonb_typeof(child.value) = 'object'
    AND NULLIF(btrim(child.value->>'id'), '') IS NOT NULL
    AND array_length(parent.node_path, 1) < 101
    AND NOT ((child.value->>'id') = ANY(parent.node_path))
), review_container_issues AS (
  SELECT
    'department'::TEXT AS object_type,
    object_id,
    'reviews'::TEXT AS json_path,
    'REVIEWS_FORMAT_INVALID'::TEXT AS reason
  FROM department_nodes
  WHERE jsonb_typeof(node->'reviews') NOT IN ('object', 'null')
), review_periods AS (
  SELECT node.object_id AS department_id, period.key AS period_key, period.value AS period_value
  FROM department_nodes AS node
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(node.node->'reviews') = 'object' THEN node.node->'reviews' ELSE '{}'::JSONB END
  ) AS period(key, value)
), period_issues AS (
  SELECT
    'department'::TEXT AS object_type,
    department_id AS object_id,
    'reviews.' || period_key AS json_path,
    CASE
      WHEN period_key !~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'
       AND period_key !~ '^\d{4}-M(0[1-9]|1[0-2])$'
       AND period_key !~ '^\d{4}-Q[1-4]$' THEN 'REVIEW_PERIOD_KEY_INVALID'
      WHEN jsonb_typeof(period_value) <> 'array' THEN 'REVIEW_PERIOD_FORMAT_INVALID'
      ELSE NULL
    END AS reason
  FROM review_periods
), review_entries AS (
  SELECT
    department_id,
    period_key,
    entry.ordinality - 1 AS entry_index,
    entry.value AS entry_value
  FROM review_periods
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(period_value) = 'array' THEN period_value ELSE '[]'::JSONB END
  ) WITH ORDINALITY AS entry(value, ordinality)
), entry_issues AS (
  SELECT
    'department'::TEXT AS object_type,
    department_id AS object_id,
    'reviews.' || period_key || '[' || entry_index || ']' AS json_path,
    CASE
      WHEN jsonb_typeof(entry_value) <> 'object' THEN 'REVIEW_ENTRY_FORMAT_INVALID'
      WHEN entry_value ? 'okrDetails' AND jsonb_typeof(entry_value->'okrDetails') <> 'object' THEN 'OKR_DETAILS_FORMAT_INVALID'
      ELSE NULL
    END AS reason
  FROM review_entries
), objective_reviews AS (
  SELECT
    entry.department_id,
    entry.period_key,
    entry.entry_index,
    objective.key AS objective_key,
    objective.value AS objective_value
  FROM review_entries AS entry
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(entry.entry_value->'okrDetails') = 'object'
      THEN entry.entry_value->'okrDetails' ELSE '{}'::JSONB END
  ) AS objective(key, value)
), objective_issues AS (
  SELECT
    'department'::TEXT AS object_type,
    department_id AS object_id,
    'reviews.' || period_key || '[' || entry_index || '].okrDetails.' || objective_key AS json_path,
    CASE
      WHEN jsonb_typeof(objective_value) <> 'object' THEN 'OBJECTIVE_REVIEW_FORMAT_INVALID'
      WHEN objective_value ? 'krReviews' AND jsonb_typeof(objective_value->'krReviews') <> 'array' THEN 'KR_REVIEWS_FORMAT_INVALID'
      WHEN jsonb_typeof(objective_value->'krReviews') = 'array'
        AND jsonb_array_length(objective_value->'krReviews') > 101 THEN 'KR_REVIEWS_OUT_OF_RANGE'
      ELSE NULL
    END AS reason
  FROM objective_reviews
)
SELECT object_type, object_id, json_path, reason
FROM (
  SELECT * FROM task_slot_issues
  UNION ALL SELECT * FROM review_container_issues
  UNION ALL SELECT * FROM period_issues
  UNION ALL SELECT * FROM entry_issues
  UNION ALL SELECT * FROM objective_issues
) AS issues
WHERE reason IS NOT NULL
ORDER BY object_type, object_id, json_path, reason;
