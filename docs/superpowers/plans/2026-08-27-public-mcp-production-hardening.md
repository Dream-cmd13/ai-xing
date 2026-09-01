# MCP 正式服上线加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不连接正式数据库、不执行正式迁移的前提下，完成方案 B 的本地代码、测试和可审计迁移文件，使 MCP 与工作台能够安全处理非法 KR、大量任务、异常复盘数据和正式服运行约束。

**Architecture:** 继续使用现有 MCP Node 服务、Supabase SECURITY DEFINER RPC 和 React 工作台。新增统一的槽位校验、数据库游标分页和迁移执行器；保留旧 RPC 作为兼容入口，新代码只调用安全的新接口或经过加固的同签名函数。Session、确认令牌和限流本次仍为单实例内存状态。

**Tech Stack:** Node.js ESM、`@modelcontextprotocol/sdk`、Zod、Supabase/PostgreSQL、React/TypeScript、Node test runner、Vite、PM2/Nginx 部署配置。

---

## 文件边界

- Create: `mcp-server/src/review-slot.mjs` — MCP 端 `aligned_kr_id` 解析和安全范围校验。
- Modify: `mcp-server/src/write-tools.mjs` — 创建/更新入参的槽位校验。
- Modify: `mcp-server/src/write-repository.mjs` — 预览阶段使用统一槽位解析，不再把坏值降级为任务槽位。
- Modify: `utils/reviewTaskState.js` — 网页端读取坏槽位时分类，写入前禁止无限扩容。
- Modify: `components/WorkbenchView.tsx` — 用 ISO 日期计算下一周。
- Modify: `mcp-server/src/repository.mjs` — 工作台三栏分页、人员补全分批、可见任务游标读取。
- Modify: `mcp-server/src/tools.mjs` — 工作台分页输出和兼容字段语义。
- Modify: `data.ts` — 网页端按分页接口加载个人工作台任务。
- Modify: `mcp-server/src/app.mjs`、`mcp-server/src/config.mjs`、`mcp-server/src/index.mjs` — 工具级限流、就绪状态和优雅停止。
- Create: `sql/2026-08-27_mcp_review_slot_hardening.sql` — KR、复盘 JSON 和周复盘缺口的数据库加固。
- Create: `sql/2026-08-27_mcp_task_pagination.sql` — 工作台和可见任务的游标分页 RPC。
- Create: `sql/2026-08-27_mcp_task_indexes.sql` — 经 `EXPLAIN ANALYZE` 验证后添加的索引。
- Create: `sql/2026-08-27_mcp_readiness.sql` — 只返回状态/版本的最小就绪检查 RPC。
- Create: `mcp-server/scripts/migrate.mjs` — 生产迁移清单、锁、校验和和幂等执行器；本计划只实现和本地验证，不连接正式库。
- Modify: `mcp-server/package.json`、`mcp-server/package-lock.json` — 迁移执行器的独立 PostgreSQL 客户端依赖。
- Modify: `mcp-server/test/repository.test.mjs`、`mcp-server/test/tools.test.mjs`、`mcp-server/test/write-repository.test.mjs`、`mcp-server/test/task-review-sync.test.mjs`、`mcp-server/test/phase2-sql-contract.test.mjs` — 新行为和 SQL 契约测试。
- Create: `mcp-server/test/review-slot.test.mjs`、`mcp-server/test/migration-runner.test.mjs` — 单元测试。
- Modify: `docs/mcp-phase2-deployment.md`、`docs/mcp-phase2-acceptance.md` — 迁移清单、正式运行和验收条件。

本计划不删除现有第二阶段迁移文件，不修改正式库，不执行 Supabase 迁移。每个提交只使用明确的文件路径，避免把工作区既有暂存改动混入修复提交。

### Task 0: 保护现有工作区并建立修复起点

**Files:**
- Read-only check: `.git/index`、当前工作区和 `aab58c6..HEAD`；不修改已有第二阶段暂存内容。

- [ ] **Step 1: 记录当前状态和基线**

Run: `git status --short; git rev-parse --short HEAD; git log --oneline --decorate aab58c6..HEAD`

Expected: 确认正式基线为 `aab58c6`、当前代码提交为 `763da68`，并记录现有暂存文件，后续提交不得覆盖或删除这些内容。

- [ ] **Step 2: 确认本地操作边界**

本批次只允许修改本计划列出的源代码、测试、文档和新增迁移文件；禁止读取 `.env` 中的密钥，禁止运行任何 Supabase 迁移命令，禁止访问正式域名或正式数据库。

- [ ] **Step 3: 以最小文件集开始第一个测试提交**

后续所有 `git add` 和 `git commit` 都使用显式文件路径；若目标文件已有暂存版本，先检查 `git diff --cached -- <path>` 与工作区差异，再只提交本批次的最终内容。

### Task 1: 建立 KR 槽位契约的失败测试

**Files:**
- Create: `mcp-server/test/review-slot.test.mjs`
- Modify: `mcp-server/test/write-repository.test.mjs`
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs`

- [ ] **Step 1: 写解析契约失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewSlot } from '../src/review-slot.mjs';

test('accepts an unaligned task as its synthetic slot', () => {
  assert.deepEqual(parseReviewSlot(null, 'task-1'), {
    ok: true, reviewKey: '__task__:task-1', krIndex: 0, aligned: false,
  });
});

test('accepts only a bounded non-negative decimal KR index', () => {
  assert.deepEqual(parseReviewSlot('okr-1-kr-2', 'task-1'), {
    ok: true, reviewKey: 'okr-1', krIndex: 2, aligned: true,
  });
  for (const value of ['okr-1-kr--1', 'okr-1-kr-1.5', 'okr-1-kr-1e2', 'okr-1-kr-😀', 'okr-1-kr-101']) {
    assert.equal(parseReviewSlot(value, 'task-1').ok, false, value);
  }
});

test('rejects an index that is unsafe before numeric conversion', () => {
  const result = parseReviewSlot(`okr-1-kr-${'9'.repeat(40)}`, 'task-1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'KR_INDEX_OUT_OF_RANGE');
});
```

- [ ] **Step 2: 为任务创建/更新增加坏槽位用例**

在 `mcp-server/test/write-repository.test.mjs` 增加断言：`prepareUpdatePadTask` 对 `alignedKrId: 'okr-1-kr-1.5'` 抛出 `INVALID_ARGUMENT`，并且 `prepareCreatePadTask` 对 101 号下标同样拒绝；对未对齐任务保持 `__task__:<id>`。

- [ ] **Step 3: 增加 SQL 静态契约断言**

在 `mcp-server/test/phase2-sql-contract.test.mjs` 断言新迁移包含 `MCP_VALIDATION`、真实 KR 数量校验和 `jsonb_typeof` 分支，并断言新迁移不包含无界 `WHILE jsonb_array_length(kr_reviews) <= p_kr_index`。

- [ ] **Step 4: 运行测试确认当前实现失败**

Run: `node --test mcp-server/test/review-slot.test.mjs mcp-server/test/write-repository.test.mjs mcp-server/test/phase2-sql-contract.test.mjs`

Expected: FAIL because `mcp-server/src/review-slot.mjs` does not exist and旧路径仍接受无界下标。

- [ ] **Step 5: Commit only the new tests**

```powershell
git add -- mcp-server/test/review-slot.test.mjs mcp-server/test/write-repository.test.mjs mcp-server/test/phase2-sql-contract.test.mjs
git commit --only mcp-server/test/review-slot.test.mjs mcp-server/test/write-repository.test.mjs mcp-server/test/phase2-sql-contract.test.mjs -m "test: define bounded review slot contract"
```

### Task 2: 实现 MCP 和网页端 KR 校验

**Files:**
- Create: `mcp-server/src/review-slot.mjs`
- Modify: `mcp-server/src/write-tools.mjs`
- Modify: `mcp-server/src/write-repository.mjs`
- Modify: `utils/reviewTaskState.js`
- Modify: `components/WorkbenchView.tsx`

- [ ] **Step 1: 写最小 MCP 解析器**

`mcp-server/src/review-slot.mjs` 使用以下完整实现，所有调用方共享同一错误原因：

```js
const DEFAULT_MAX_KR_INDEX = 100;
const SLOT_PATTERN = /^(.+)-kr-([0-9]+)$/;

export function parseReviewSlot(alignedKrId, taskId, maxKrIndex = DEFAULT_MAX_KR_INDEX) {
  if (alignedKrId === null || alignedKrId === undefined || alignedKrId === '') {
    return { ok: true, aligned: false, reviewKey: `__task__:${taskId || 'unknown'}`, krIndex: 0 };
  }
  if (typeof alignedKrId !== 'string' || alignedKrId.length > 128) {
    return { ok: false, reason: 'ALIGNED_KR_ID_INVALID' };
  }
  const match = SLOT_PATTERN.exec(alignedKrId);
  if (!match || match[1].trim().length === 0) {
    return { ok: false, reason: 'ALIGNED_KR_ID_INVALID' };
  }
  const digits = match[2];
  if (digits.length > 3) return { ok: false, reason: 'KR_INDEX_OUT_OF_RANGE' };
  const krIndex = Number(digits);
  if (!Number.isSafeInteger(krIndex) || krIndex < 0 || krIndex > maxKrIndex) {
    return { ok: false, reason: 'KR_INDEX_OUT_OF_RANGE' };
  }
  return { ok: true, aligned: true, reviewKey: match[1], krIndex };
}

export { DEFAULT_MAX_KR_INDEX };
```

- [ ] **Step 2: 让写入参数和预览使用解析器**

在 `write-tools.mjs` 的 `validateTaskPayload` 和 `validateTaskChanges` 中调用 `parseReviewSlot`；失败时抛出 `INVALID_ARGUMENT`。在 `write-repository.mjs` 的 `reviewSlot` 中调用同一函数，失败时抛出 `INVALID_ARGUMENT`，不得返回 `__task__` 兜底。

- [ ] **Step 3: 让网页读取坏数据可见但不扩容**

将 `utils/reviewTaskState.js` 的返回类型扩展为 `{ state: 'valid' | 'unaligned' | 'invalid', reason, reviewKey, krIndex }`。读取时对坏槽位返回 `invalid`；`updateTaskReviewState` 遇到 `invalid` 直接抛出带原因的错误，删除 `while (newKrReviews.length <= krIndex)`，仅允许对已确认的真实 KR 数量进行有限补齐。

- [ ] **Step 4: 修正网页下一周跨年计算**

`components/WorkbenchView.tsx` 不再拼接 `${currentWeek + 1}`，改为从 `Date` 加 7 天后调用现有 ISO 周计算函数，确保第 52/53 周得到下一 ISO 年的 `W01`。

- [ ] **Step 5: 运行单元和构建验证**

Run: `node --test mcp-server/test/review-slot.test.mjs mcp-server/test/write-repository.test.mjs`

Run: `npm run build`

Expected: PASS；坏格式、负数、小数、超大数和乱码全部在 Node 层返回参数错误。

- [ ] **Step 6: Commit the bounded parser and callers**

```powershell
git add -- mcp-server/src/review-slot.mjs mcp-server/src/write-tools.mjs mcp-server/src/write-repository.mjs utils/reviewTaskState.js components/WorkbenchView.tsx
git commit --only mcp-server/src/review-slot.mjs mcp-server/src/write-tools.mjs mcp-server/src/write-repository.mjs utils/reviewTaskState.js components/WorkbenchView.tsx -m "fix: bound task review KR slots"
```

### Task 3: 实现数据库 KR/复盘安全迁移（只写文件，不执行）

**Files:**
- Create: `sql/2026-08-27_mcp_review_slot_hardening.sql`
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs`
- Modify: `mcp-server/test/task-review-sync.test.mjs`

- [ ] **Step 1: 增加数据库辅助函数**

在新迁移中定义 `public.mcp_parse_review_slot(TEXT,TEXT)` 和 `public.mcp_resolve_task_kr_count(TEXT,TEXT,TEXT)`。解析函数先用正则验证末尾数字和数字长度，再转换整数；解析失败返回结构化状态，不让 PostgreSQL 抛出转换异常。数量函数按周次推导年份/季度，从 `strategy.company_okrs` 和 `departments.okrs` 查找唯一目标及 `keyResults` 数量，数量为 0、目标重复或超过 100 时返回无效状态。

- [ ] **Step 2: 用同签名 `CREATE OR REPLACE` 加固复盘同步 RPC**

复制当前 `mcp_update_pad_task_with_review_sync` 的权限和事务边界，只替换槽位和 JSON 校验部分：

```sql
IF jsonb_typeof(period_reviews) <> 'array' OR jsonb_array_length(period_reviews) = 0 THEN
  RAISE EXCEPTION 'MCP_VALIDATION: 目标复盘周期不存在或格式错误';
END IF;
IF jsonb_typeof(old_entry) <> 'object' THEN
  RAISE EXCEPTION 'MCP_VALIDATION: 周复盘记录格式错误';
END IF;
IF old_objective_review ? 'krReviews'
   AND jsonb_typeof(old_objective_review->'krReviews') <> 'array' THEN
  RAISE EXCEPTION 'MCP_VALIDATION: krReviews 必须是数组';
END IF;
IF p_kr_index < 0 OR p_kr_index > 100 OR p_kr_index >= actual_kr_count THEN
  RAISE EXCEPTION 'MCP_VALIDATION: KR 下标不存在';
END IF;
```

合法但缺少 `krReviews` 时只按 `actual_kr_count` 有限初始化；不得保留无限 `WHILE`。任务行和部门行的锁、`row_version`、原子更新、幂等和审计逻辑保持不变。

- [ ] **Step 3: 加固周复盘缺口查询**

在 `mcp_get_weekly_review_gaps` 的 LATERAL 分支中先判断 `jsonb_typeof`，把错误类型映射为 `reviewState='invalid'` 和原因码；只在类型正确时访问数组下标，避免 `jsonb_array_length` 和整数转换异常。

- [ ] **Step 4: 运行 SQL 契约和 Node 模拟测试**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs mcp-server/test/task-review-sync.test.mjs`

Expected: PASS；测试确认新迁移删除无界数组扩展、保留 `mcp_save_review_record` 的字段保护，并保持复盘同步返回的 `reviewKey/krIndex`。

- [ ] **Step 5: Commit only the new migration and tests**

```powershell
git add -- sql/2026-08-27_mcp_review_slot_hardening.sql mcp-server/test/phase2-sql-contract.test.mjs mcp-server/test/task-review-sync.test.mjs
git commit --only sql/2026-08-27_mcp_review_slot_hardening.sql mcp-server/test/phase2-sql-contract.test.mjs mcp-server/test/task-review-sync.test.mjs -m "fix: harden review slot RPC validation"
```

### Task 4: 实现三栏工作台分页和人员分批补全

**Files:**
- Create: `sql/2026-08-27_mcp_task_pagination.sql`
- Modify: `mcp-server/src/repository.mjs`
- Modify: `mcp-server/src/tools.mjs`
- Modify: `data.ts`
- Modify: `mcp-server/test/repository.test.mjs`
- Modify: `mcp-server/test/tools.test.mjs`

- [ ] **Step 1: 先写 0/50/51/150 条失败测试**

在 `repository.test.mjs` 增加 fake RPC 断言：151 个候选任务必须触发 4 次、每次不超过 50 个 ID 的 `mcp_get_task_people` 调用；同一任务同时属于三个栏目时，返回数组仍分别包含该任务。

- [ ] **Step 2: 增加工作台分页 RPC**

新函数 `mcp_get_personal_workbench_page(p_limit, p_today_cursor_updated_at, p_today_cursor_id, p_this_week_cursor_updated_at, p_this_week_cursor_id, p_next_week_cursor_updated_at, p_next_week_cursor_id)`：每个栏目独立过滤、排序并取 `limit + 1`，以 `updated_at DESC, id DESC` 生成 `nextCursor`；不接受用户 ID 参数，用户从 `auth.uid()`/当前认证上下文解析。

- [ ] **Step 3: 实现 Node 分批补全和重复回填**

把 `enrichTaskPeople` 改为按 50 个任务 ID 切片，逐批调用 RPC；工作台分别取得三栏结果，使用所有栏目的 ID 集合完成补全，再按原始三栏数组回填。兼容字段 `tasks` 使用三栏顺序拼接后按 ID 去重，三栏本身不去重。

- [ ] **Step 4: 更新工具输出契约**

在 `tools.mjs` 的 `compactWorkbench` 和 output schema 中增加：

```js
pageInfo: z.object({
  today: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
  thisWeek: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
  nextWeek: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable(), truncated: z.boolean() }),
})
```

`limit` 仍限制为 1 到 50；没有下一页时 `nextCursor=null`。

- [ ] **Step 5: 让网页工作台使用同一分页结果**

`data.ts:getWorkbenchTasks` 循环读取分页 RPC，直到三栏游标耗尽或达到 10,000 条总上限，返回完整任务集合给现有 `WorkbenchView`；页面继续按三栏日期/周次过滤，因此不会改变页面视觉结构。

- [ ] **Step 6: 运行专项测试**

Run: `node --test mcp-server/test/repository.test.mjs mcp-server/test/tools.test.mjs`

Expected: PASS；51 和 150 条任务不再整体失败，三个栏目允许重复，人员 RPC 每次最多 50 条。

- [ ] **Step 7: Commit the workbench changes**

```powershell
git add -- sql/2026-08-27_mcp_task_pagination.sql mcp-server/src/repository.mjs mcp-server/src/tools.mjs data.ts mcp-server/test/repository.test.mjs mcp-server/test/tools.test.mjs
git commit --only sql/2026-08-27_mcp_task_pagination.sql mcp-server/src/repository.mjs mcp-server/src/tools.mjs data.ts mcp-server/test/repository.test.mjs mcp-server/test/tools.test.mjs -m "fix: paginate personal workbench by column"
```

### Task 5: 实现所有可见任务的数据库游标分页

**Files:**
- Modify: `sql/2026-08-27_mcp_task_pagination.sql`
- Modify: `mcp-server/src/repository.mjs`
- Modify: `mcp-server/test/repository.test.mjs`
- Modify: `mcp-server/test/tools.test.mjs`

- [ ] **Step 1: 写 5,000 条分页行为测试**

使用内存 fake page provider 生成 5,000 个按 `updated_at DESC,id DESC` 排序的任务，调用 Node 自动读取器，断言结果 ID 集合大小为 5,000、没有重复或遗漏；生成 10,001 条时断言 `truncated=true`。

- [ ] **Step 2: 实现 `mcp_get_visible_tasks_page`**

RPC 接受 `department_id`、`status`、`week_id`、`query`、`limit`、`cursor_updated_at` 和 `cursor_id`，在 SQL 内先过滤权限和条件，再按稳定排序取 `limit + 1`，返回 `items`、`hasMore`、`nextCursor`。

- [ ] **Step 3: 替换无上限读取路径**

`repository.mjs` 的 `getVisibleTasks` 不再调用无参数 `get_visible_tasks_full` 作为主要路径；新增循环按游标读取，每次最多 50 条，累计超过 10,000 条立即停止并在调用方结果中保留 `truncated=true`。旧 RPC 仅作为缺少新函数时的兼容回退，并且回退结果最多接受 50 条。

- [ ] **Step 4: 运行分页测试**

Run: `node --test mcp-server/test/repository.test.mjs mcp-server/test/tools.test.mjs`

Expected: PASS；5,000 条任务可完整读取，结果不依赖 PostgREST 1,000 行上限。

- [ ] **Step 5: Commit the visible-task pagination changes**

```powershell
git add -- mcp-server/src/repository.mjs mcp-server/test/repository.test.mjs mcp-server/test/tools.test.mjs
git commit --only mcp-server/src/repository.mjs mcp-server/test/repository.test.mjs mcp-server/test/tools.test.mjs -m "fix: read visible tasks with keyset pagination"
```

### Task 6: 增加索引、就绪检查和迁移文件契约

**Files:**
- Create: `sql/2026-08-27_mcp_task_indexes.sql`
- Create: `sql/2026-08-27_mcp_readiness.sql`
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs`

- [ ] **Step 1: 用测试数据确定索引候选**

在隔离测试库准备 5,000 条任务后，对工作台、周次、部门和可见任务查询执行 `EXPLAIN ANALYZE`。只把实际改善过滤/排序的索引写入迁移，人员 JSON 数组只在执行计划证明需要时增加 GIN 索引。

- [ ] **Step 2: 写索引迁移**

`sql/2026-08-27_mcp_task_indexes.sql` 只包含非唯一索引，并标记为不可在事务块内执行；迁移执行器使用 `CREATE INDEX CONCURRENTLY`，失败时保留明确错误状态。

- [ ] **Step 3: 写最小就绪 RPC**

`sql/2026-08-27_mcp_readiness.sql` 创建只返回迁移版本和必需 RPC 是否存在的函数，不返回业务数据，不要求共享高权限账号，并只授予就绪检查所需的最低执行权限。

- [ ] **Step 4: 添加静态契约测试**

断言索引迁移包含 `updated_at`/`id` 稳定排序所需索引定义，分页迁移包含 `hasMore`、`nextCursor`，就绪迁移不包含密码、JWT、Authorization 或业务表全量查询。

- [ ] **Step 5: Commit the additive SQL files**

```powershell
git add -- sql/2026-08-27_mcp_task_indexes.sql sql/2026-08-27_mcp_readiness.sql mcp-server/test/phase2-sql-contract.test.mjs
git commit --only sql/2026-08-27_mcp_task_indexes.sql sql/2026-08-27_mcp_readiness.sql mcp-server/test/phase2-sql-contract.test.mjs -m "feat: add MCP paging indexes and readiness contract"
```

### Task 7: 实现受控迁移执行器（本地验证，不连接正式库）

**Files:**
- Create: `mcp-server/scripts/migrate.mjs`
- Create: `mcp-server/test/migration-runner.test.mjs`
- Modify: `mcp-server/package.json`
- Modify: `mcp-server/package-lock.json`

- [ ] **Step 1: 写迁移执行器失败测试**

测试 fake client 的行为：相同版本和校验和返回 `skipped`；校验和不同抛出错误；清单顺序错误抛出错误；迁移 SQL 失败后不执行后续版本；同一批只获取一次 advisory lock。

- [ ] **Step 2: 增加独立 PostgreSQL 客户端依赖**

在 `mcp-server/package.json` 增加 `pg`，使用 `npm install --package-lock-only` 更新锁文件。迁移连接只读取独立 `DATABASE_URL`，不读取 MCP publishable key。

- [ ] **Step 3: 实现版本清单和校验和**

执行器固定清单顺序：基线 `aab58c6`、2026-08-21 两份、2026-08-25 三份、2026-08-26 两份、四份 2026-08-27 新迁移。每个文件用 `crypto.createHash('sha256')` 计算校验和，日志只输出版本、状态和耗时。

- [ ] **Step 4: 实现锁、历史表和执行逻辑**

执行器先只读检查基线，再在同一数据库连接上获取整批 advisory lock；预检查通过后创建 `mcp_internal.schema_migrations`，记录版本、文件名、校验和、状态、耗时和错误码。相同版本同校验和跳过，校验和变化和顺序错误直接中止；普通迁移在事务中执行，索引迁移单独执行。

- [ ] **Step 5: 运行迁移执行器单元测试**

Run: `node --test mcp-server/test/migration-runner.test.mjs`

Expected: PASS；测试只使用 fake client，不需要任何数据库连接。

- [ ] **Step 6: Commit the runner**

```powershell
git add -- mcp-server/scripts/migrate.mjs mcp-server/test/migration-runner.test.mjs mcp-server/package.json mcp-server/package-lock.json
git commit --only mcp-server/scripts/migrate.mjs mcp-server/test/migration-runner.test.mjs mcp-server/package.json mcp-server/package-lock.json -m "feat: add controlled MCP migration runner"
```

### Task 8: 加固正式运行时的限流、就绪和优雅停止

**Files:**
- Modify: `mcp-server/src/config.mjs`
- Modify: `mcp-server/src/app.mjs`
- Modify: `mcp-server/src/index.mjs`
- Modify: `mcp-server/test/app.test.mjs`
- Modify: `mcp-server/test/config.test.mjs`
- Modify: `mcp-server/test/session-resilience.test.mjs`

- [ ] **Step 1: 写运行时失败测试**

增加测试：已建立 Session 的工具调用也会被限流并返回 429/`Retry-After`；`/ready` 在 draining 时返回非就绪；停止流程先停止接受新请求，再等待当前请求。

- [ ] **Step 2: 增加分层限流配置**

在 `config.mjs` 增加初始化、读、写三个独立窗口和上限，保留现有环境变量的默认兼容值。限流键只使用 IP、用户 ID、Session ID 和工具分类，不使用 token 内容。

- [ ] **Step 3: 在已有 Session 的请求路径消费限流额度**

在 `app.mjs` 的 `existingSession` 调用 transport 前，从请求体提取工具名和读写分类，分别消费限流器；拒绝时设置 `Retry-After` 并返回 429，不记录请求体。

- [ ] **Step 4: 增加 `/ready` 和 draining 状态**

`/health` 保持纯存活检查；`/ready` 检查 draining、Supabase 连通性和只读就绪 RPC。停止时先把状态置为 draining，再关闭新连接、等待进行中的请求、关闭 Session，超时后强制结束。

- [ ] **Step 5: 运行运行时测试**

Run: `node --test mcp-server/test/app.test.mjs mcp-server/test/config.test.mjs mcp-server/test/session-resilience.test.mjs`

Expected: PASS；不输出 Authorization、JWT、密码或确认令牌。

- [ ] **Step 6: Commit runtime hardening**

```powershell
git add -- mcp-server/src/config.mjs mcp-server/src/app.mjs mcp-server/src/index.mjs mcp-server/test/app.test.mjs mcp-server/test/config.test.mjs mcp-server/test/session-resilience.test.mjs
git commit --only mcp-server/src/config.mjs mcp-server/src/app.mjs mcp-server/src/index.mjs mcp-server/test/app.test.mjs mcp-server/test/config.test.mjs mcp-server/test/session-resilience.test.mjs -m "fix: harden MCP runtime limits and readiness"
```

### Task 9: 更新部署文档并完成全量本地验收

**Files:**
- Modify: `docs/mcp-phase2-deployment.md`
- Modify: `docs/mcp-phase2-acceptance.md`
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs`

- [ ] **Step 1: 固化正式迁移顺序**

文档明确 `aab58c6` 为基线，列出 2026-08-21、2026-08-25、2026-08-26 和 2026-08-27 的顺序，注明当前没有正式库时只做测试库/隔离库演练，不允许直接执行正式迁移。

- [ ] **Step 2: 固化三栏和异常数据验收**

文档写明三个栏目允许重复、每栏独立游标、`hasMore` 与 `truncated` 的区别，以及坏复盘数据返回 `invalid` 而不影响其他部门。

- [ ] **Step 3: 运行完整验证**

Run: `npm run mcp:test`

Run: `npm run build`

Run: `Get-ChildItem mcp-server/src -Filter *.mjs | ForEach-Object { node --check $_.FullName }`

Run: `git diff --check`

Expected: 所有 MCP 测试通过、构建通过、Node 语法检查通过、无空白错误；前端无关 lint 不纳入本次门禁。

- [ ] **Step 4: 检查工作区和提交内容**

Run: `git status --short; git log --oneline --decorate -12`

确认发布包只包含已提交的修复和设计文档；工作区原有第二阶段暂存内容不得被误删或混入不相关提交。

- [ ] **Step 5: Commit documentation and final contract updates**

```powershell
git add -- docs/mcp-phase2-deployment.md docs/mcp-phase2-acceptance.md mcp-server/test/phase2-sql-contract.test.mjs
git commit --only docs/mcp-phase2-deployment.md docs/mcp-phase2-acceptance.md mcp-server/test/phase2-sql-contract.test.mjs -m "docs: document MCP production hardening rollout"
```

## 本地迁移演练边界

完成上述代码和测试后，只允许在隔离测试数据库或本地临时 PostgreSQL 上演练：

1. 从 `aab58c6` 重建基线；
2. 按固定顺序执行迁移；
3. 重复执行同一批，确认显示 skipped；
4. 修改文件校验和，确认执行器中止；
5. 故意打乱顺序，确认执行器中止；
6. 验证 P1 字段保护、KR 下标保护、分页和就绪 RPC。

没有正式数据库时，不执行正式迁移、不配置正式域名、不启动正式 MCP 服务。正式服以后仍从 `aab58c6` 开始按清单执行，不能把测试库当前状态直接复制过去。
