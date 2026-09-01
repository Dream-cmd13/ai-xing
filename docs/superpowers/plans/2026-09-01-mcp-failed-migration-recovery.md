# MCP 失败迁移受控恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复测试库上阻断 release contract 的 SQL 语法错误，受控恢复唯一失败账本，并让当前 MCP 在不重启的情况下恢复 ready。

**Architecture:** 保持 28 项 manifest 顺序不变，只修正尚未成功应用的迁移内容，并将变化后的事务 manifest digest 同步到 Node 和 SQL 契约。失败账本只在版本、旧 checksum、错误码、回滚对象和后续版本守卫全部匹配时删除，再由原迁移器完成写入和契约记录。

**Tech Stack:** Node.js ESM、PostgreSQL、Supabase Session Pooler、Node test runner、Express MCP readiness。

---

## 文件结构

- Modify: `sql/2026-09-01_mcp_task_validation_and_people_security.sql` — 修正 PL/pgSQL `CASE` 条件。
- Modify: `mcp-server/src/release-contract.mjs` — 固定修正后的事务 manifest digest。
- Modify: `sql/2026-09-01_mcp_release_contract.sql` — 让数据库 readiness 核对同一 digest。
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs` — 锁定括号语法和摘要一致性。
- Create ignored evidence: `local-test-files/mcp-migration-recovery-evidence-2026-09-01.json` — 保存安全失败证据，不含连接信息。

### Task 1: 修复 SQL 并同步发布摘要

**Files:**
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs`
- Modify: `sql/2026-09-01_mcp_task_validation_and_people_security.sql`
- Modify: `mcp-server/src/release-contract.mjs`
- Modify: `sql/2026-09-01_mcp_release_contract.sql`

- [ ] **Step 1: 增加失败断言**

在任务校验迁移测试中增加：

```js
assert.match(sql, />\s*\(CASE WHEN v_key = 'participant_ids' THEN 50 ELSE 20 END\)\s*THEN/i);
assert.doesNotMatch(sql, />\s*CASE WHEN v_key = 'participant_ids' THEN 50 ELSE 20 END\s*THEN/i);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs`

Expected: 新增括号断言失败。

- [ ] **Step 3: 实施最小语法修复和摘要更新**

将条件改为：

```sql
OR jsonb_array_length(p_changes->v_key) > (CASE WHEN v_key = 'participant_ids' THEN 50 ELSE 20 END) THEN
```

并把 `mcp-server/src/release-contract.mjs` 与 `sql/2026-09-01_mcp_release_contract.sql` 的期望摘要同步为：

```text
284d74705f7c31ab645f834f868b349ef7568077ea667502afdf10066a728c0d
```

- [ ] **Step 4: 运行静态和迁移器测试**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs mcp-server/test/migration-runner.test.mjs`

Expected: 全部通过，迁移器动态 digest 与固定摘要一致。

### Task 2: 证明回滚并受控恢复失败账本

**Files:**
- Create ignored evidence: `local-test-files/mcp-migration-recovery-evidence-2026-09-01.json`
- Database: 当前 MCP 实际连接的测试库

- [ ] **Step 1: 在事务中执行修正迁移并回滚**

使用 5432 Session Pooler，执行 `BEGIN`、修正后的迁移正文、`ROLLBACK`，然后断言验证函数和 release contract 表仍不存在。

Expected: SQL 完整解析和执行成功，回滚后两个对象均不存在。

- [ ] **Step 2: 保存安全失败证据**

证据文件只包含版本、文件名、旧 checksum、`42601`、成功/失败计数和回滚对象布尔状态，不包含主机、用户、密码、URL、Key 或业务数据。

- [ ] **Step 3: 执行带守卫的账本恢复事务**

获取 `pg_advisory_lock(hashtext('ai-xing:mcp:migrations:v1'))` 后锁定失败行。仅当旧失败行完全匹配、26 条其他记录全部成功、没有后续成功版本且回滚对象不存在时执行：

```sql
DELETE FROM mcp_internal.schema_migrations
WHERE version = '2026-09-01_mcp_task_validation_and_people_security'
  AND status = 'failed'
  AND error_code = '42601'
RETURNING version;
```

返回行数不是 1 时回滚；完成后释放 advisory lock。

- [ ] **Step 4: 重新运行默认迁移器**

调用 `runMigrations({ adoptExisting: false, includeIndexes: false })`。

Expected: 既有版本 skipped，索引保持 deferred，两个 2026-09-01 版本 applied，release contract 成功记录。

### Task 3: 验证数据库契约和 MCP 可用性

**Files:**
- Read-only: database ledger/release contract/readiness
- Read-only: local HTTP endpoints

- [ ] **Step 1: 核对账本和 release contract**

Expected: 28 条成功、0 条失败；release ID 为 `2026-09-01`；manifest digest 为修正后摘要；required versions 和函数权限通过。

- [ ] **Step 2: 核对 HTTP readiness**

Run: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/health`

Run: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/ready`

Expected: 两者均为 HTTP 200，`/ready` 返回完整匹配的 release contract。

- [ ] **Step 3: 核对 MCP 协议入口**

向 `http://127.0.0.1:8787/mcp` 发送无凭据 initialize 请求。

Expected: 返回 401 `AUTHENTICATION_REQUIRED`，而不是 503，证明 readiness 门禁已通过且协议路由正常。

- [ ] **Step 4: 全量回归**

Run: `npm run mcp:test`

Run: `npm run lint:app`

Run: `git diff --check`

Expected: 284 项 MCP 测试通过、TypeScript 零错误、差异检查通过。
