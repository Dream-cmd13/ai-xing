# Workbench Shanghai Calendar Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make “今日工作” include every personal task whose date range covers the current `Asia/Shanghai` calendar day.

**Architecture:** Reuse the existing Shanghai date conversion boundaries in the web and MCP date utilities, then apply the same inclusive calendar-day predicate in the React view, MCP fallback grouping, and database pagination RPC. Publish the SQL change as a forward transactional migration and advance the release contract without changing task data.

**Tech Stack:** React 19, TypeScript/JavaScript ESM, Node.js 20 test runner, PostgreSQL PL/pgSQL, Supabase RPC.

---

### Task 1: Add the web calendar-day predicate

**Files:**
- Modify: `utils/reviewPeriodConsistency.js`
- Modify: `components/WorkbenchView.tsx`
- Test: `mcp-server/test/review-period-consistency.test.mjs`

- [ ] **Step 1: Write the failing utility tests**

Add assertions for a task stored from `2026-09-07T12:00:00Z` through `2026-09-13T12:00:00Z`. At `2026-09-07T01:00:00Z` it must be active because all values resolve to Shanghai calendar dates. Verify inclusive end day, the previous day, the following day, and missing dates.

```js
assert.equal(isTaskActiveOnShanghaiDay(task, Date.parse('2026-09-07T01:00:00Z')), true);
assert.equal(isTaskActiveOnShanghaiDay(task, Date.parse('2026-09-13T15:59:59Z')), true);
assert.equal(isTaskActiveOnShanghaiDay(task, Date.parse('2026-09-06T15:59:59Z')), false);
assert.equal(isTaskActiveOnShanghaiDay(task, Date.parse('2026-09-13T16:00:00Z')), false);
assert.equal(isTaskActiveOnShanghaiDay({ startDate: null, dueDate: task.dueDate }, task.startDate), false);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test mcp-server/test/review-period-consistency.test.mjs`

Expected: FAIL because `isTaskActiveOnShanghaiDay` is not exported.

- [ ] **Step 3: Implement the utility and use it in the workbench**

Export a predicate based on the existing `getShanghaiBusinessDay` conversion, returning false for missing or invalid bounds. Replace the precise timestamp comparison in `WorkbenchView`:

```js
export const isTaskActiveOnShanghaiDay = (task, now = Date.now()) => {
  try {
    if (task?.startDate == null || task?.dueDate == null) return false;
    const start = getShanghaiBusinessDay(task.startDate);
    const due = getShanghaiBusinessDay(task.dueDate);
    const current = getShanghaiBusinessDay(now);
    return start.epochDay <= current.epochDay && current.epochDay <= due.epochDay;
  } catch {
    return false;
  }
};
```

```ts
const todayTasks = useMemo(
  () => allMyTasks.filter((task) => isTaskActiveOnShanghaiDay(task, today.getTime())),
  [allMyTasks, today]
);
```

- [ ] **Step 4: Run the focused test and TypeScript check**

Run: `node --test mcp-server/test/review-period-consistency.test.mjs`

Expected: PASS.

Run: `npm run lint:app`

Expected: TypeScript exits with code 0.

### Task 2: Align the MCP fallback grouping

**Files:**
- Modify: `mcp-server/src/task-period-defaults.mjs`
- Modify: `mcp-server/src/repositories/task-read-repository.mjs`
- Test: `mcp-server/test/task-period-defaults.test.mjs`
- Test: `mcp-server/test/repository.test.mjs`

- [ ] **Step 1: Write failing MCP utility and repository tests**

Test the same Shanghai calendar-day vectors in `task-period-defaults.test.mjs`. In the repository fallback test, use a Monday task whose stored start timestamp is later than the injected current instant but falls on the same Shanghai date, and assert that it appears in both `todayTasks` and `thisWeekTasks`.

- [ ] **Step 2: Run focused MCP tests and verify failure**

Run: `node --test mcp-server/test/task-period-defaults.test.mjs mcp-server/test/repository.test.mjs`

Expected: the same-day-before-start-time case is absent from `todayTasks`.

- [ ] **Step 3: Export and apply the MCP predicate**

Add `isTaskActiveOnShanghaiDay(task, nowMs)` beside the existing Shanghai date conversion and import it in `task-read-repository.mjs`. Replace the fallback `todayMs >= start && todayMs <= due` predicate with:

```js
const isToday = (row) => isTaskActiveOnShanghaiDay({
  startDate: row?.start_date ?? row?.startDate,
  dueDate: row?.due_date ?? row?.dueDate,
}, todayMs);
```

- [ ] **Step 4: Run focused MCP tests**

Run: `node --test mcp-server/test/task-period-defaults.test.mjs mcp-server/test/repository.test.mjs`

Expected: PASS.

### Task 3: Align the database workbench RPC and release contract

**Files:**
- Create: `sql/2026-09-07_workbench_shanghai_calendar_day.sql`
- Modify: `mcp-server/scripts/migrate.mjs`
- Modify: `mcp-server/src/release-contract.mjs`
- Test: `mcp-server/test/phase2-sql-contract.test.mjs`
- Test: `mcp-server/test/migration-runner.test.mjs`

- [ ] **Step 1: Write failing SQL and manifest contract tests**

Require the new migration to be transactional, to redefine `mcp_get_personal_workbench_page`, to compare `Asia/Shanghai` dates, and to preserve authenticated-only execution. Require the manifest tail and release ID to advance to `2026-09-07-workbench-shanghai-day`.

- [ ] **Step 2: Run focused contract tests and verify failure**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs mcp-server/test/migration-runner.test.mjs`

Expected: FAIL because the migration and new release contract do not exist.

- [ ] **Step 3: Add the transactional migration**

Copy the current RPC definition and replace its precise-time today condition with an inclusive Shanghai date comparison:

```sql
(to_timestamp(start_date / 1000.0) AT TIME ZONE 'Asia/Shanghai')::DATE
  <= (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::DATE
AND (to_timestamp(due_date / 1000.0) AT TIME ZONE 'Asia/Shanghai')::DATE
  >= (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::DATE
```

Keep the function signature, `SECURITY DEFINER`, fixed `search_path`, cursor behavior, revokes, and authenticated grant unchanged. Update the readiness function text to require the previous title-contract migration and the new release ID/digest.

- [ ] **Step 4: Add the migration and compute the release digest**

Append the migration to `MIGRATION_MANIFEST`, set it as `RELEASE_CONTRACT_FILE`, set `RELEASE_ID`, then calculate the digest using the repository's `releaseManifestDigest` implementation and place the exact value in `release-contract.mjs` and the migration readiness replacement.

- [ ] **Step 5: Run focused contract tests**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs mcp-server/test/migration-runner.test.mjs`

Expected: PASS with manifest/release digest equality.

### Task 4: Verify the complete candidate

**Files:**
- Verify all files changed in Tasks 1–3

- [ ] **Step 1: Run formatting and source checks**

Run: `git diff --check`

Expected: exits with code 0.

Run: PowerShell loop invoking `node --check` for all `mcp-server/src/*.mjs`, `mcp-server/scripts/*.mjs`, and `scripts/*.mjs` files.

Expected: every file exits with code 0.

- [ ] **Step 2: Run application build gates**

Run: `npm run lint:app`

Expected: exits with code 0.

Run: `npm run build:secure`

Expected: Vite build and distribution secret scan pass.

- [ ] **Step 3: Run the complete MCP suite**

Run: `npm run mcp:test`

Expected: all tests pass. Do not run `mcp:test:live` because it may write external data.

- [ ] **Step 4: Review the final diff**

Confirm no task rows, environment files, credentials, or the existing untracked test-plan document are included. Confirm the SQL migration does not rerun historical migrations, task-period backfill, or deferred indexes.
