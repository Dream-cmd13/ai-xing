# MCP Task Title Unbounded Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the task-title maximum-length validation from the database while continuing to reject null, empty, and whitespace-only titles, so monthly review updates can touch legacy long-title tasks.

**Architecture:** Add a follow-up transactional SQL migration; do not edit any already-applied migration. The migration replaces the canonical validator and active task write functions with the same signatures, preserving all other validation and permissions while removing only the title upper bound. The migration runner manifest and release contract are advanced together so the change remains ledger-tracked.

**Tech Stack:** PostgreSQL PL/pgSQL, Node.js migration runner, SHA-256 release manifest checks.

---

### Task 1: Add the follow-up SQL migration

**Files:**
- Create: `sql/2026-09-03_mcp_task_title_unbounded.sql`
- Reference: `sql/2026-09-01_mcp_task_validation_and_people_security.sql`
- Reference: `sql/2026-08-21_mcp_write_rpc.sql`
- Reference: `sql/2026-08-25_mcp_task_defaults_people_submit.sql`
- Reference: `sql/2026-08-25_mcp_task_review_sync_rpc.sql`
- Reference: `sql/2026-08-29_nested_department_scope.sql`

- [ ] Define a `BEGIN`/`COMMIT` migration that keeps `title` as `TEXT` and changes only title validation.
- [ ] Replace `public.mcp_validate_task_changes(jsonb, boolean)` so title must be a string with non-empty `btrim`, without checking `length(...) > 200`.
- [ ] Replace `public.mcp_validate_task_row_contract()` so INSERT/UPDATE rows use the new validator and legacy long titles pass.
- [ ] Replace every active create/update/review-sync path that still contains the old inline `> 200` check, retaining the blank-title check and all other checks.
- [ ] Preserve existing signatures, SECURITY DEFINER, search path, permissions, audit logging, optimistic locking, and review-period checks.

### Task 2: Register the migration and release contract

**Files:**
- Modify: `mcp-server/scripts/migrate.mjs`
- Modify: `mcp-server/src/release-contract.mjs`
- Modify: `sql/2026-09-03_mcp_task_title_unbounded.sql` if the new readiness contract needs to be defined there

- [ ] Append the migration filename to `MIGRATION_MANIFEST` as the final transactional entry.
- [ ] Publish a new release ID and compute its manifest digest from the ordered manifest.
- [ ] Update the readiness function/contract expected release values in the new migration so the existing readiness gate remains `ready` after the migration runner records the new contract.

### Task 3: Validate without reading the production database

**Files:**
- Test: existing migration runner and SQL contract tests under `mcp-server/test/`

- [ ] Run migration envelope and manifest tests locally.
- [ ] Replay the full migration chain in an isolated database and verify: blank title is rejected; 201+ character title is accepted; review-only updates on a long-title task are accepted.
- [ ] Confirm no production connection, production data query, frontend change, or MCP runtime deployment is performed in this phase.

### Task 4: Execute the approved migration in production

**Files:**
- Use: `mcp-server/scripts/migrate.mjs`

- [ ] Confirm the operator has selected the approved production migration connection without printing it.
- [ ] Run `node --env-file=.env mcp-server/scripts/migrate.mjs` from the approved `main` release.
- [ ] Record only migration counts, failure status, release ID, and manifest digest; do not output database credentials or business rows.
- [ ] After success, retry the monthly review operation. Do not run frontend/MCP deployment as part of this hotfix.

### Task 5: Rollback guidance

**Files:**
- Reference: `sql/2026-09-03_mcp_task_title_unbounded.sql`

- [ ] Do not automatically roll back after success because restoring the 200-character rule would make existing long-title rows fail on future updates again.
- [ ] If rollback is explicitly required, restore the prior function definitions through a separately reviewed migration and accept that monthly review may be blocked until affected titles are handled.
