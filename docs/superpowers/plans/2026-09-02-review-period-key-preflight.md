# Review Period Key Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the review-data preflight recognize valid weekly, monthly, and quarterly review period keys, then remove the resulting false 45-record release blocker from deployment guidance.

**Architecture:** Keep the preflight as a read-only SQL asset. Replace its week-only key predicate with the canonical W/M/Q predicate already used by the scoped department-review contract, and recursively scan the baseline `departments` JSONB structure without calling a function created by a candidate migration. Static SQL contract tests lock down the accepted formats and baseline-safe scan scope; documentation gates on real findings rather than a historical count.

**Tech Stack:** PostgreSQL JSONB preflight SQL, Node.js `node:test`, Markdown deployment documentation.

---

### Task 1: Lock down the corrected preflight contract

**Files:**
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs:426-437`
- Test: `mcp-server/test/phase2-sql-contract.test.mjs`

- [ ] **Step 1: Add failing assertions for all three canonical period-key formats and nested-node coverage**

```js
assert.match(sql, /\\^\\\\d\{4\}-W\(0\[1-9\]\\|\[1-4\]\\\\d\\|5\[0-3\]\)\\$/);
assert.match(sql, /\\^\\\\d\{4\}-M\(0\[1-9\]\\|1\[0-2\]\)\\$/);
assert.match(sql, /\\^\\\\d\{4\}-Q\[1-4\]\\$/);
assert.match(sql, /WITH RECURSIVE department_nodes/i);
assert.doesNotMatch(sql, /mcp_department_tree_nodes/i);
assert.match(sql, /REVIEW_PERIOD_KEY_INVALID/i);
assert.match(sql, /REVIEW_PERIOD_FORMAT_INVALID/i);
```

- [ ] **Step 2: Run the focused test to verify the month, quarter, and tree assertions fail**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs`

Expected: the existing week-only scanner fails at least the monthly, quarterly, or tree-scope assertion.

- [ ] **Step 3: Commit the test-first change**

```bash
git add mcp-server/test/phase2-sql-contract.test.mjs
git commit -m "补充复盘周期预检回归测试"
```

### Task 2: Implement the read-only scanner correction

**Files:**
- Modify: `sql/2026-08-27_mcp_review_data_scan.sql:1-62`

- [ ] **Step 1: Replace root-only period enumeration with a baseline-safe recursive JSONB tree**

```sql
RECURSIVE department_nodes AS (
  SELECT
    d.id AS root_id,
    d.id AS node_id,
    ARRAY[d.id]::TEXT[] AS node_path,
    jsonb_build_object(
      'reviews', d.reviews,
      'subDepartments', COALESCE(to_jsonb(d)->'sub_departments', to_jsonb(d)->'subDepartments', '[]'::JSONB)
    ) AS node
  FROM public.departments AS d

  UNION ALL

  SELECT
    parent.root_id,
    child.value->>'id',
    parent.node_path || (child.value->>'id'),
    child.value
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
    AND NOT ((child.value->>'id') = ANY(parent.node_path))
), review_nodes AS (
  SELECT root_id, node_id, node->'reviews' AS reviews
  FROM department_nodes
), review_periods AS (
  SELECT node.root_id, node.node_id, period.key AS period_key, period.value AS period_value
  FROM review_nodes AS node
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(node.reviews) = 'object' THEN node.reviews ELSE '{}'::JSONB END
  ) AS period(key, value)
)
```

- [ ] **Step 2: Use the canonical W/M/Q predicate while retaining malformed-value checks**

```sql
CASE
  WHEN period_key !~ '^\\d{4}-W(0[1-9]|[1-4]\\d|5[0-3])$'
   AND period_key !~ '^\\d{4}-M(0[1-9]|1[0-2])$'
   AND period_key !~ '^\\d{4}-Q[1-4]$'
    THEN 'REVIEW_PERIOD_KEY_INVALID'
  WHEN jsonb_typeof(period_value) <> 'array' THEN 'REVIEW_PERIOD_FORMAT_INVALID'
  ELSE NULL
END
```

Add a separate `review_container_issues` CTE that emits `REVIEWS_FORMAT_INVALID` when a node has a non-null, non-object `reviews` value. Use `node_id` as the returned department object ID for container, period, and entry issues, and retain the existing no-content output projection.

- [ ] **Step 3: Run focused tests to verify the implementation passes**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs`

Expected: PASS with the preflight remaining outside `MIGRATION_MANIFEST` and containing no write SQL.

- [ ] **Step 4: Commit the scanner and test**

```bash
git add sql/2026-08-27_mcp_review_data_scan.sql mcp-server/test/phase2-sql-contract.test.mjs
git commit -m "修正复盘周期预检误报"
```

### Task 3: Replace the stale deployment blocker with a dynamic gate

**Files:**
- Modify: `docs/mcp-production-deployment-preparation.md:9-18, 198-205, 315-321, 436-472, 482-488`
- Modify: `docs/production-deployment-quick-guide.md:17-24, 83-123`

- [ ] **Step 1: Remove statements that assert 45 unresolved `REVIEW_PERIOD_KEY_INVALID` records**

Replace the fixed count with this operational rule: run the corrected read-only review scan on the formal database; stop if it emits any `REVIEW_PERIOD_KEY_INVALID`, `REVIEW_PERIOD_FORMAT_INVALID`, or `REVIEWS_FORMAT_INVALID` row; do not auto-rewrite review history.

- [ ] **Step 2: Preserve the independent task-date/week gate**

Keep the existing task-period dry-run requirements (`exceptions=0`, human handling for missing or inverted dates, backup, and controlled backfill) unchanged. This preflight correction must not make task-period remediation appear complete on the formal database.

- [ ] **Step 3: Verify the two deployment documents no longer treat 45 as a release blocker**

Run: `rg -n "45 条|45.*REVIEW_PERIOD_KEY_INVALID|REVIEW_PERIOD_KEY_INVALID" docs/mcp-production-deployment-preparation.md docs/production-deployment-quick-guide.md`

Expected: no hard-coded 45 count remains; remaining references describe dynamic zero-real-finding gates.

- [ ] **Step 4: Commit the deployment guidance update**

```bash
git add docs/mcp-production-deployment-preparation.md docs/production-deployment-quick-guide.md
git commit -m "更新复盘预检发布门禁"
```

### Task 4: Run final read-only verification

**Files:**
- Verify: `sql/2026-08-27_mcp_review_data_scan.sql`
- Verify: `mcp-server/test/phase2-sql-contract.test.mjs`
- Verify: `mcp-server/test/migration-runner.test.mjs`
- Verify: `mcp-server/test/deployment-assets.test.mjs`
- Verify: `local-test-files/package-production.test.mjs`

- [ ] **Step 1: Run the affected automated checks**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs mcp-server/test/migration-runner.test.mjs mcp-server/test/deployment-assets.test.mjs local-test-files/package-production.test.mjs`

Expected: all tests pass.

- [ ] **Step 2: Re-run the configured test-database read-only period-key audit**

Expected: 100 weekly, 33 monthly, 12 quarterly; zero invalid keys, zero legacy no-`M` monthly keys, and zero invalid review-value formats. Do not connect to the formal database.

- [ ] **Step 3: Check repository hygiene**

Run: `git diff --check` and `git status --short`

Expected: no whitespace error; only intended tracked changes before the final commit.

- [ ] **Step 4: Commit the completed implementation**

```bash
git add sql/2026-08-27_mcp_review_data_scan.sql mcp-server/test/phase2-sql-contract.test.mjs docs/mcp-production-deployment-preparation.md docs/production-deployment-quick-guide.md docs/superpowers/specs/2026-09-02-review-period-key-preflight-design.md docs/superpowers/plans/2026-09-02-review-period-key-preflight.md
git commit -m "完成复盘预检门禁更新"
```
