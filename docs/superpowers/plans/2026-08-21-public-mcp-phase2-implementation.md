# 公网 MCP 第二阶段实施计划（安全写入和基础团队协作）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **修订 v1.1（2026-08-21）：** 合入计划评审 8 项修正——①令牌失败重试状态机；②Manager 范围对齐现有触发器（不修改触发器）；③复盘目标部门权限校验；④创建任务必填字段与默认值闭合；⑤禁止经 MCP 移动任务部门；⑥RPC 信任边界声明；⑦统一会话销毁钩子；⑧回滚分级。
>
> **修订 v1.2（2026-08-21）：** 应用户确认「系统权限设计保持不变」，移除 processes 表 RLS 收紧（原 Task 1）——阶段二所有 SQL 迁移均为纯新增对象，不修改任何既有 RLS 策略、权限函数或触发器（见关键设计决策 12）。

**Goal:** 在已验收的第一阶段只读 MCP 服务上增加六个写入工具（创建/更新 PAD 任务、提交任务、保存复盘记录），实现两步确认、乐观锁、幂等和审计四层写入安全，使 TRAE 用户能用个人系统账号安全写入业务数据。不修改系统任何既有权限设计——RLS 策略、权限函数、触发器全部保持现状。

**前置条件（开工闸门）：** 用户已明确回复「第一阶段验收通过，同意开始第二阶段」。未收到该回复前不得修改任何生产代码（总体方案 4.5、第 8 节）。

**Architecture:** 所有写入固定走两步链路：`prepare / 首次调用（只读预览 + 签发确认令牌） → 用户在 TRAE 对话中明确确认 → commit / 携带令牌二次调用（Supabase RPC 单事务执行）`。确认令牌保存在 MCP 进程内存并绑定「用户 + MCP 会话 + 工具名 + 参数摘要 + 过期时间」，令牌状态机为 `issued → in_flight → 终态删除`（可重试失败回滚 issued，业务失败删除）。权限判定、乐观锁、幂等和审计全部下沉到数据库 RPC（SECURITY DEFINER + 显式权限校验），复用网站现有权限函数（`is_admin`、`is_manager`、`is_department_manager`、`current_user_can_manage_task`），复盘保存新增共享函数 `current_user_can_edit_department_reviews`（谓词与网站 `save_departments_atomic` 对齐）。**权限总原则：MCP 写入能力 ⊆ 网站现有能力**——MCP 与网站共用同一权限体系，任何一侧收紧对两侧同时生效。本阶段全部数据库变更为纯新增对象（两张日志表、一个权限谓词组合函数、五个写入 RPC），不修改任何既有 RLS 策略、权限函数或触发器。

**Tech Stack:** 与第一阶段一致（Node.js 20+、ES Modules、`@modelcontextprotocol/sdk@1.30.0`、Express 5、Zod 4、`@supabase/supabase-js@2.105.4`、Node Test Runner、Nginx），新增 `node:crypto`（令牌与参数摘要）和两个 Supabase SQL 迁移。

---

## 关键设计决策

以下决策把总体方案 5.2 的七个步骤映射到具体实现，实施时不得偏离：

1. **工具清单固定为总体方案建议的 6 个**：`prepare_create_pad_task`、`commit_create_pad_task`、`prepare_update_pad_task`、`commit_update_pad_task`、`submit_pad_task`、`save_review_record`。不开放删除、权限变更和系统配置类工具。
2. **`submit_pad_task` 与 `save_review_record` 采用「单工具两步」模式**：不携带 `confirmationToken` 的首次调用只返回预览并签发令牌（对应 v3 设计的 dry_run 草稿模式），携带令牌的二次调用才执行。这样既满足总体方案 5.2 步骤 3「写操作不能一次直接执行」，又保持 6 个工具名不变。
3. **确认令牌五要素绑定 + 三态状态机**（总体方案步骤 3）：userId、MCP sessionId、工具名、参数 SHA-256 摘要、过期时间（默认 10 分钟）。参数变化 → 摘要不匹配 → 必须重新 prepare。令牌三态 `issued → in_flight → 终态删除`：commit 开始置 in_flight（并发同令牌拒绝），**可重试失败**（网络/超时/`DATA_ACCESS_FAILED`/`INTERNAL_ERROR`）回滚 issued 供同 requestId 重试，**业务失败**（`VERSION_CONFLICT`/`PERMISSION_DENIED`/`VALIDATION`）删除令牌强制重新 prepare——参数未变时业务失败重试必然再失败，保留令牌只会诱导无效重试。
4. **乐观锁版本在 prepare 时捕获**：`prepare_update_pad_task` / `submit_pad_task` / `save_review_record` 预览时读取当前 `row_version` 并纳入参数摘要；commit 使用该版本执行条件更新。他人已修改 → `VERSION_CONFLICT` → 用户重新读取并重新确认（总体方案步骤 4）。
5. **幂等三层防护**（总体方案步骤 5）：(a) Node 层先按 `(userId, toolName, requestId)` 查询 `mcp_write_log`，命中成功记录直接返回首次结果（覆盖「RPC 实际成功但响应丢失」的重试场景，不触碰令牌）；(b) 令牌状态机 in_flight 态拒绝并发、可重试失败回滚 issued（防止换 requestId 或换令牌重复提交）；(c) RPC 内部 `INSERT ... ON CONFLICT DO NOTHING` 抢占（防止并发重复执行）。失败请求整个事务回滚、日志不留痕，天然可安全重试。
6. **审计两层写入**（总体方案步骤 6）：成功审计在写 RPC 事务内插入（与业务写入原子）；失败审计由 MCP 服务捕获错误后调用专用 RPC `mcp_record_failed_write` 单独插入。审计表对普通用户只读、只能插入自己的记录，禁止 UPDATE/DELETE；任何日志不记录密码、Basic Header、JWT。
7. **Manager 任务范围对齐现有触发器，不修改触发器**：`enforce_task_owner_scope`（00_one_click_schema.sql:1391）要求非 Admin 创建任务时 `department_id` **精确等于**本人部门、Manager 只能指定本部门成员为负责人。MCP 采用同一口径：创建任务=本部门，更新任务非 Admin 不得改 `owner_id`（RPC 内先行校验）。虽然 `is_department_manager` 语义是「负责部门+子树」，但放开子部门建任务需修改共用触发器、会同步扩张网站权限，超出阶段二范围——Manager 子部门建任务写入「已知限制」；若组织确需该能力，作为独立的网站功能变更另行立项。
8. **任务部门不可经 MCP 移动**：`department_id` 不进入 MCP 更新白名单，任何角色（含 Admin）都不能通过 MCP 修改任务部门——`current_user_can_manage_task` 只判负责人/参与人，不校验目标部门范围，开放部门移动即引入越权移动风险。组织级调整留给后续阶段评估。
9. **复盘保存使用目标部门范围校验**：`current_user_can_save_departments()`（00_one_click_schema.sql:734）只查菜单权限、不接收目标部门参数，单独使用会导致持有菜单权限的普通用户越权修改非授权部门复盘。新增共享函数 `current_user_can_edit_department_reviews(p_department_id)`，谓词与网站 `save_departments_atomic` 更新分支（00_one_click_schema.sql:1575-1585）逐字对齐（Admin / `current_user_can_manage_department_tree(目标部门)` / 目标部门=本部门 / 本部门 ∈ 目标部门子树），叠加菜单权限与 `row_version` 校验。`save_departments_atomic` 本阶段不动（避免网站回归），验收要求两条路径在三类测试账号上判定等价。
10. **RPC 信任边界**：MCP 接口层强制两步确认；数据库 RPC 层强制权限/事务/乐观锁/幂等/审计。持有用户 JWT 直接调用 `mcp_*` RPC 不属于 MCP 客户端流程——绕过的只是确认步骤，绕不过权限与审计（与网站 `save_*_atomic` 同一信任模型）。本阶段不引入 RPC 签名机制，该边界声明固定写入验收文档。
11. **回滚分级**：L1 应用回滚（默认）= 回退 mcp-server 至第一阶段构建并重启，SQL 对象全部保留，无数据损失；L2 数据库回滚 = DROP FUNCTION + DROP TABLE（均为本阶段新增对象，不涉及任何既有权限对象），仅当用户明确确认不再需要审计数据时执行，执行前必须先导出 `mcp_audit_log`，禁止作为自动回滚步骤。
12. **不修改系统既有权限设计**：应用户确认，系统权限设计保持不变，本阶段全部数据库变更为纯新增对象。原总体方案 5.2 步骤 2 的「收紧 processes 表 RLS」移出阶段二：processes 写策略维持 `USING (true)` 现状（阶段二无 processes 写工具，MCP 不新增该表暴露；如需收紧，作为独立的系统加固变更另行评估）。写入 RPC 的权限判定 = 在函数体内调用既有权限函数（与 tasks_insert / tasks_update RLS 策略、网站 `save_*_atomic` 使用的同一批函数）；`current_user_can_edit_department_reviews` 仅为网站现有内联检查的可复用提取，不改变任何现有判定。既有 RLS 策略、权限函数、`enforce_task_owner_scope` 触发器一律不动。维护提醒：将来修改权限函数本身时 RPC 自动跟随；若修改 tasks 表 RLS 策略的组合方式（增删 OR 分支），RPC 内镜像组合需同步更新。

## 文件结构

- `sql/2026-08-21_mcp_write_infra_tables.sql`：`mcp_write_log`、`mcp_audit_log` 表和 RLS。
- `sql/2026-08-21_mcp_write_rpc.sql`：共享权限函数 `current_user_can_edit_department_reviews` + 四个写入 RPC + 失败审计 RPC。
- `mcp-server/src/confirmation-store.mjs`：三态确认令牌的签发、状态流转和清理。
- `mcp-server/src/write-repository.mjs`：prepare 预览读取和 commit RPC 调用。
- `mcp-server/src/write-tools.mjs`：六个写入工具定义（`registerWriteTools`）。
- `mcp-server/src/errors.mjs`：新增写入相关错误码和 DB 错误前缀映射。
- `mcp-server/src/config.mjs`：新增 `MCP_CONFIRMATION_TTL_MS`。
- `mcp-server/src/mcp-server.mjs`：注册写入工具。
- `mcp-server/src/app.mjs` / `index.mjs`：装配确认存储、过期清理、会话销毁联动。
- `mcp-server/src/session-registry.mjs`：增加统一会话销毁钩子 `onSessionDestroyed`（四条销毁路径均触发）。
- `mcp-server/test/confirmation-store.test.mjs`、`write-repository.test.mjs`、`write-tools.test.mjs`：第二阶段测试。
- `mcp-server/scripts/live-smoke.mjs`：扩展写入冒烟流程。
- `docs/mcp-phase2-deployment.md`：SQL 应用顺序、回滚、部署说明。
- `docs/mcp-phase2-acceptance.md`：人工验收清单和测试矩阵。
- `mcp-server/src/tools.mjs` / `repository.mjs`：**不修改**（第一阶段只读工具保持原样）。

## Task 1：新增写入基础设施表（SQL 迁移）

**Files:**
- Create: `sql/2026-08-21_mcp_write_infra_tables.sql`

- [ ] **Step 1：编写建表和 RLS**

```sql
BEGIN;

-- 幂等日志：同一 (user, tool, request_id) 只允许一条成功记录
CREATE TABLE IF NOT EXISTS public.mcp_write_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | success
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT public.audit_now_ms(),
  CONSTRAINT mcp_write_log_request_id_len CHECK (length(request_id) BETWEEN 8 AND 128),
  CONSTRAINT mcp_write_log_unique UNIQUE (user_id, tool_name, request_id)
);

-- 审计日志：谁、何时、哪个工具、改了什么、结果、请求编号
CREATE TABLE IF NOT EXISTS public.mcp_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,                            -- create | update | submit | save_review
  object_type TEXT NOT NULL,                       -- task | department_review
  object_id TEXT NOT NULL,
  status TEXT NOT NULL,                            -- success | failed
  error_code TEXT,
  before_summary JSONB,
  after_summary JSONB,
  created_at BIGINT NOT NULL DEFAULT public.audit_now_ms()
);

CREATE INDEX IF NOT EXISTS mcp_audit_log_user_created_idx
  ON public.mcp_audit_log (user_id, created_at DESC);

ALTER TABLE public.mcp_write_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_audit_log ENABLE ROW LEVEL SECURITY;

-- 普通用户只能读自己的记录，Admin 可读全部；不建 INSERT/UPDATE/DELETE 策略，
-- 两张表只允许 RPC（SECURITY DEFINER，表 owner）写入，实现追加式审计（总体方案 5.3 审计测试）。
CREATE POLICY mcp_write_log_select ON public.mcp_write_log FOR SELECT TO authenticated
  USING (user_id = public.current_user_id() OR public.is_admin());
CREATE POLICY mcp_audit_log_select ON public.mcp_audit_log FOR SELECT TO authenticated
  USING (user_id = public.current_user_id() OR public.is_admin());

COMMIT;
```

- [ ] **Step 2：验证普通员工无法修改审计记录**

用 Employee 账号执行 `UPDATE public.mcp_audit_log ...` 必须被 RLS 拒绝（无 UPDATE 策略）。记录到验收文档。

## Task 2：实现写入 RPC（SQL 迁移）

**Files:**
- Create: `sql/2026-08-21_mcp_write_rpc.sql`

所有 RPC 遵循统一契约：

- `SECURITY DEFINER` + `SET search_path = public`，事务内完成「幂等抢占 → 权限校验 → 乐观锁写入 → 审计插入 → 日志落定」；
- 权限校验复用网站现有函数，失败 `RAISE EXCEPTION 'MCP_PERMISSION_DENIED: ...'`；
- 版本冲突 `RAISE EXCEPTION 'MCP_VERSION_CONFLICT: ...'`；并发重复请求 `RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: ...'`；参数非法 `RAISE EXCEPTION 'MCP_VALIDATION: ...'`（Node 层按前缀映射稳定错误码）；
- 幂等抢占模式（四个 RPC 相同）：

```sql
INSERT INTO public.mcp_write_log (user_id, tool_name, request_id, status, result_summary)
VALUES (v_user_id, v_tool, p_request_id, 'pending', '{}'::jsonb)
ON CONFLICT (user_id, tool_name, request_id) DO NOTHING
RETURNING id INTO v_log_id;

IF v_log_id IS NULL THEN
  SELECT status, result_summary INTO v_status, v_prior
  FROM public.mcp_write_log
  WHERE user_id = v_user_id AND tool_name = v_tool AND request_id = p_request_id;
  IF v_status = 'success' THEN
    RETURN jsonb_build_object('replayed', true, 'result', v_prior);
  END IF;
  RAISE EXCEPTION 'MCP_REQUEST_IN_FLIGHT: 同一请求正在执行中，请稍后重试';
END IF;
```

- [ ] **Step 1：`mcp_create_pad_task(p_task JSONB, p_request_id TEXT) RETURNS JSONB`**

  - 权限：镜像 tasks_insert 策略（`is_admin()` / `has_menu_permission('task-center'|'execution','create')` / Manager 本人部门 / `department_id = current_user_department_id()`）。Manager 范围与 `enforce_task_owner_scope` 触发器对齐：创建任务限本部门（子部门不开放，见关键设计决策 7），负责人可指定本部门成员。
  - 缺省值闭合（`owner_id` 为 NOT NULL，见 00_one_click_schema.sql:108）：`ownerId` 未传 = 当前用户（三角色统一，触发器本就要求员工=自己）；`departmentId` 未传 = 当前用户部门（含 Admin，避免产生无部门任务）；显式传其他部门时按权限与触发器规则校验并返回干净错误码（`MCP_PERMISSION_DENIED` / `MCP_VALIDATION`），不靠触发器兜底。
  - 校验：title 必填 ≤200 字符；priority ∈ {high,medium,low}；status 创建时仅允许 `draft`（提交必须走 `submit_pad_task`）；`owner_id`、`participant_ids`、`approver_ids` 每项必须存在于 `users` 表，否则 `MCP_VALIDATION`（参与人/审批人允许跨部门，与网站现状一致）；`due_date < start_date` 拒绝；`plan`/`action`/`deliverable` ≤2000 字符；`tags` ≤12 项且每项 ≤32 字符；`target_weeks` 每项匹配 `^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$`（W01-W53，排除 W00/W99）。
  - 服务端生成 `id := 'task-mcp-' || epoch_ms || '-' || random6`（不信任客户端 id）；`row_version := 0`；`created_by := current_user_id()`。
  - 白名单字段：department_id、title、status、priority、owner_id、aligned_kr_id、target_weeks、start_date、due_date、tags、participant_ids、approver_ids、plan、action、deliverable。
  - 成功后：写 mcp_audit_log（action=create，after_summary=任务摘要），更新 mcp_write_log 为 success + result_summary，返回 `{replayed:false, task, rowVersion}`。

- [ ] **Step 2：`mcp_update_pad_task(p_task_id TEXT, p_changes JSONB, p_expected_row_version BIGINT, p_request_id TEXT) RETURNS JSONB`**

  - 读取任务（`SELECT ... FOR UPDATE`），权限：镜像 tasks_update 策略（`is_admin()` 或 菜单权限 + `current_user_can_manage_task(...)`）。
  - 版本：`row_version <> p_expected_row_version` → `MCP_VERSION_CONFLICT`。
  - 禁止字段：`department_id` 不在白名单——任何角色（含 Admin）不得经 MCP 移动任务部门（关键设计决策 8）；`owner_id` 变更非 Admin 一律拒绝（镜像触发器「非管理员不能修改任务负责人」，RPC 内先行校验返回 `MCP_PERMISSION_DENIED`，不靠触发器兜底）。二者出现在 `p_changes` 中即拒绝整个请求。
  - 仅应用白名单字段（同创建，另含 task_review、task_review_score；不含 department_id / owner_id 变更）；`row_version + 1`。
  - 审计含 before_summary / after_summary；返回 `{replayed, task, rowVersion}`。

- [ ] **Step 3：`mcp_submit_pad_task(p_task_id TEXT, p_expected_row_version BIGINT, p_request_id TEXT) RETURNS JSONB`**

  - 状态机：当前 status ∈ {draft, in-progress, paused} 才允许提交为 `submitted`；`submitted/approved/completed/terminated` → `MCP_VALIDATION: 当前状态不允许提交`。实施时对照 `TaskModal`/`useTaskActions` 的网站提交逻辑核对状态集合。
  - 权限与版本同 Step 2；返回 `{replayed, task, rowVersion, approverIds}`。

- [ ] **Step 4：`mcp_save_review_record(p_department_id TEXT, p_period_key TEXT, p_entry JSONB, p_expected_row_version BIGINT, p_request_id TEXT) RETURNS JSONB`**

  - 权限：新增共享函数 `current_user_can_edit_department_reviews(p_department_id)`（本迁移内创建，谓词与网站 `save_departments_atomic` 更新分支 00_one_click_schema.sql:1575-1585 逐字对齐）：`current_user_can_save_departments()`（菜单权限）AND（`is_admin()` OR `current_user_can_manage_department_tree(目标部门节点)` OR 目标部门 = 本部门 OR 本部门 ∈ 目标部门子树）。**不得只查菜单权限函数**——它不接收目标部门参数，会导致持有菜单权限的普通用户越权修改非授权部门复盘（关键设计决策 9）。
  - `p_period_key` 校验：`^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$` 或 `^\d{4}-(0[1-9]|1[0-2])$` 或 `^\d{4}-Q[1-4]$`。
  - 服务端规范化 ReviewEntry（与 `types.ts` ReviewEntry 对齐）：`{id: 'rev-'||epoch_ms, date: epoch_ms, content, score, reviewer: (SELECT name FROM users WHERE id = current_user_id()), okrDetails}`。
  - 写入方式与网站一致：`reviews := jsonb_set(reviews, {periodKey}, to_jsonb(array[new_entry]))`（网站保存即为单元素数组覆盖，见 ReviewView.tsx `submitReview`）。
  - 部门行乐观锁：`departments.row_version` 条件更新 +1。
  - 审计 action=save_review、object_type=department_review；返回 `{replayed, departmentId, periodKey, reviewId, rowVersion}`。

- [ ] **Step 5：`mcp_record_failed_write(p_tool_name TEXT, p_request_id TEXT, p_action TEXT, p_object_type TEXT, p_object_id TEXT, p_error_code TEXT, p_before_summary JSONB DEFAULT NULL) RETURNS VOID`**

  - 仅供 MCP 服务在 RPC 失败后补记失败审计；内部强制 `user_id := current_user_id()`、`status := 'failed'`，用户无法伪造成功审计。

- [ ] **Step 6：语法与应用验证**

迁移整体包在 `BEGIN/COMMIT`。在 Supabase 应用后逐个 RPC 做冒烟：成功、重复 requestId 幂等返回、权限拒绝、版本冲突、失败回滚不留 pending 记录；创建缺省值（不传 ownerId/departmentId）、禁止字段（changes 含 department_id / owner_id 变更）、用户存在性校验、`target_weeks` W00/W99 拒绝；`current_user_can_edit_department_reviews` 与 `save_departments_atomic` 更新分支在 Admin/Manager/Employee 三类账号上的判定等价性核对。结果记入验收文档。

## Task 3：确认令牌存储 ConfirmationStore（TDD）

**Files:**
- Create: `mcp-server/test/confirmation-store.test.mjs`
- Create: `mcp-server/src/confirmation-store.mjs`

- [ ] **Step 1：写失败测试**

覆盖：签发返回 base64url 令牌与 expiresAt（状态 issued）；`begin` 校验五要素——正确全部匹配成功并置 in_flight 并返回 metadata；过期令牌拒绝（reason=EXPIRED）；未知令牌拒绝（UNKNOWN）；已终态删除的令牌再次 begin 拒绝（reason=CONSUMED）；in_flight 状态再次 begin 拒绝（reason=IN_FLIGHT，防并发同令牌）；A 用户令牌 B 用户拒绝（USER_MISMATCH）；sessionId 不同拒绝（SESSION_MISMATCH）；参数摘要不同拒绝（ARGS_MISMATCH）；`rollback` 把 in_flight 令牌恢复为 issued（失败可重试）且仅对 in_flight 态有效；`finalize` 删除 in_flight 令牌（终态）；`revokeSession(sessionId)` 清空该会话全部令牌（含 in_flight）；`cleanupExpired()` 清理过期项（含 in_flight）；`computeArgsDigest` 对键序不同但内容相同的对象产出相同摘要、内容不同产出不同摘要。

- [ ] **Step 2：运行测试确认失败**

Run: `npm --prefix mcp-server test -- test/confirmation-store.test.mjs`

Expected: FAIL，缺少 `src/confirmation-store.mjs`。

- [ ] **Step 3：实现**

```js
// src/confirmation-store.mjs 契约
import { randomBytes, createHash } from 'node:crypto';

export function computeArgsDigest(toolName, args) {
  // SHA-256(toolName + canonicalJSON(args))，canonicalJSON 按 key 排序、稳定序列化
}

export class ConfirmationStore {
  constructor({ ttlMs, now = Date.now }) {}
  issue({ userId, sessionId, toolName, argsDigest, metadata }) {}   // → { token, expiresAt } 状态 issued
  begin({ userId, sessionId, toolName, argsDigest, token }) {}      // issued→in_flight → { valid, reason?, metadata? }
  rollback({ token }) {}                                            // in_flight→issued（可重试失败后恢复）
  finalize({ token }) {}                                            // in_flight→删除（终态，RPC 成功后）
  revokeSession(sessionId) {}
  cleanupExpired() {}
  get size() {}
}
```

令牌 `randomBytes(32).toString('base64url')`；Map 键存储 `sha256(token)` 而非明文令牌；令牌三态 `issued → in_flight → 终态删除`：`begin` 置 in_flight（并发同令牌第二次 begin 拒绝），`rollback` 回 issued 供同 requestId 重试，`finalize` 删除；每张令牌同一时刻最多一个 in_flight；`begin` 五要素任一不匹配即拒绝且不改变令牌状态。

- [ ] **Step 4：运行测试确认通过**

Run: `npm --prefix mcp-server test -- test/confirmation-store.test.mjs`

Expected: PASS。

## Task 4：写入 Repository（TDD）

**Files:**
- Create: `mcp-server/test/write-repository.test.mjs`
- Create: `mcp-server/src/write-repository.mjs`

- [ ] **Step 1：写失败测试**

用注入的假 Supabase 客户端覆盖：

- 所有 RPC 调用都携带当前用户 JWT（延续第一阶段 `execute` 模式）；
- `prepareUpdatePadTask` / `prepareSubmitPadTask` 按 taskId 直查 tasks 表并返回当前值与 rowVersion（RLS 保证可见性）；不可见（返回空）→ `DATA_ACCESS_FAILED` 带稳定消息；
- `prepareSaveReviewRecord` 读取 departments 行的 reviews 与 rowVersion；
- commit 方法把参数原样传给对应 `mcp_*` RPC，`withTimeout` 生效；
- `lookupWriteResult({ toolName, requestId })` 查询 mcp_write_log 并返回 `{status, resultSummary}` 或 null；
- `recordFailedWrite` 调用 `mcp_record_failed_write`，异常被吞掉只记日志（失败审计是 best-effort）；
- DB 错误消息带 `MCP_VERSION_CONFLICT:` / `MCP_PERMISSION_DENIED:` / `MCP_REQUEST_IN_FLIGHT:` 前缀时映射为对应 `AppError`，无前缀映射 `DATA_ACCESS_FAILED`。

- [ ] **Step 2：运行测试确认失败**

Run: `npm --prefix mcp-server test -- test/write-repository.test.mjs`

Expected: FAIL，缺少 `src/write-repository.mjs`。

- [ ] **Step 3：实现**

```js
// src/write-repository.mjs 对外接口
createWriteRepository({ createUserClient, getContext, requestTimeoutMs, logger })
  prepareCreatePadTask({ payload })              // 参数校验 + 返回预览（无 DB 写）
  commitCreatePadTask({ payload, requestId })    // rpc('mcp_create_pad_task', ...)
  prepareUpdatePadTask({ taskId, changes })      // 读当前任务 + rowVersion
  commitUpdatePadTask({ taskId, changes, expectedRowVersion, requestId })
  prepareSubmitPadTask({ taskId })               // 读任务 + 校验可提交状态 + 预览
  commitSubmitPadTask({ taskId, expectedRowVersion, requestId })
  prepareSaveReviewRecord({ departmentId, periodKey, entry })
  commitSaveReviewRecord({ departmentId, periodKey, entry, expectedRowVersion, requestId })
  lookupWriteResult({ toolName, requestId })
  recordFailedWrite({ toolName, requestId, action, objectType, objectId, errorCode, beforeSummary })
```

- [ ] **Step 4：运行测试确认通过**

Run: `npm --prefix mcp-server test -- test/write-repository.test.mjs`

Expected: PASS。

## Task 5：注册六个写入 MCP 工具（TDD）

**Files:**
- Create: `mcp-server/test/write-tools.test.mjs`
- Create: `mcp-server/src/write-tools.mjs`
- Modify: `mcp-server/src/errors.mjs`

- [ ] **Step 1：扩展错误码**

`errors.mjs` 新增：`CONFIRMATION_REQUIRED`、`CONFIRMATION_INVALID`、`VERSION_CONFLICT`、`PERMISSION_DENIED`、`REQUEST_IN_FLIGHT`；保留第一阶段全部错误码。

- [ ] **Step 2：写失败测试**

覆盖（对照总体方案 5.3 测试矩阵）：

- `tools/list` 场景下六个工具名精确匹配、`readOnlyHint: false`、`destructiveHint: false`、`idempotentHint: true`；
- **确认机制**：`commit_create_pad_task` 无令牌 → `CONFIRMATION_INVALID`；过期令牌 → `CONFIRMATION_INVALID`；A 用户令牌（不同 userId/sessionId）→ 拒绝；prepare 后修改任一参数再 commit → ARGS_MISMATCH 拒绝；同一令牌并发两次 commit → 第二次 IN_FLIGHT 拒绝；
- **令牌失败重试**：RPC 抛可重试错误（网络/超时/`DATA_ACCESS_FAILED`/`INTERNAL_ERROR`）→ 令牌回滚 issued，同 requestId 重试成功；RPC 抛业务错误（`VERSION_CONFLICT`/`PERMISSION_DENIED`/`VALIDATION`）→ 令牌删除，重试收到 `CONFIRMATION_INVALID`，必须重新 prepare；
- **乐观锁**：commit_update 携带过期 expectedRowVersion（repository 抛 VERSION_CONFLICT）→ 工具返回该错误码且消息不包含内部堆栈；
- **禁止字段**：`prepare_update_pad_task` / `commit_update_pad_task` 的 changes 含 `departmentId` 或 `ownerId` 变更 → `INVALID_ARGUMENT` 拒绝，不调用 RPC；
- **幂等重放**：`lookupWriteResult` 命中 success → 不触碰令牌、不调 RPC、返回 `{replayed: true, result}`；
- **失败审计**：commit 抛错时调用 `recordFailedWrite` 且其异常不影响错误返回；
- **单工具两步**：`submit_pad_task`/`save_review_record` 无令牌调用只产出预览 + 令牌，绝不触发写 RPC；
- 成功结果同时返回简体中文 Text Content 与 structuredContent（延续第一阶段模式）；
- 工具描述明确要求：同一逻辑写入重试必须复用相同 `requestId`。

- [ ] **Step 3：运行测试确认失败**

Run: `npm --prefix mcp-server test -- test/write-tools.test.mjs`

Expected: FAIL，缺少 `src/write-tools.mjs`。

- [ ] **Step 4：实现 `registerWriteTools(server, writeRepository, confirmationStore)`**

工具 Schema 要点：

```text
prepare_create_pad_task  { payload: {title(必填≤200), departmentId?(缺省=本人部门), ownerId?(缺省=本人),
                          priority?, alignedKrId?, targetWeeks?(≤53,W01-W53), startDate?, dueDate?(≥startDate),
                          tags?(≤12,每项≤32字), participantIds?(≤50,须为真实用户), approverIds?(≤20,须为真实用户),
                          plan?, action?, deliverable?(≤2000)} }   // status 固定 draft，不接受入参
                          → { preview, confirmationToken, expiresAt, nextStep }

commit_create_pad_task   { ...payload, confirmationToken, requestId(8-128,重试复用) }
                          → { task, rowVersion, replayed }

prepare_update_pad_task  { taskId, changes(1-20个白名单字段；departmentId/ownerId 禁止) }
                          → { taskId, current, changes, expectedRowVersion, confirmationToken, expiresAt }

commit_update_pad_task   { taskId, changes(同上禁止字段), expectedRowVersion, confirmationToken, requestId }
                          → { task, rowVersion, replayed }

submit_pad_task          { taskId, confirmationToken?, requestId? }
                          首次 → { taskId, currentStatus, nextStatus:'submitted', approverIds,
                                   expectedRowVersion, confirmationToken, expiresAt, executed:false }
                          确认 → { task, rowVersion, approverIds, executed:true, replayed }

save_review_record       { departmentId, periodKey, content(必填), score?(0-100),
                          okrDetails?, confirmationToken?, requestId? }
                          首次 → { departmentId, periodKey, preview, expectedRowVersion,
                                   confirmationToken, expiresAt, executed:false }
                          确认 → { reviewId, rowVersion, executed:true, replayed }
```

commit 统一编排（顺序不可变）：

```text
1. lookupWriteResult 命中 success → 直接返回首次结果（不触碰令牌；覆盖「RPC 实际成功但响应丢失」场景）
2. confirmationStore.begin（五要素 + 摘要匹配，issued→in_flight）失败 → CONFIRMATION_INVALID（reason=IN_FLIGHT 时返回 REQUEST_IN_FLIGHT）
3. 调用 writeRepository.commit*
4. 成功 → finalize（令牌终态删除）→ 返回结果
5. 可重试失败（网络/超时/DATA_ACCESS_FAILED/INTERNAL_ERROR）→ rollback（令牌回 issued）→ recordFailedWrite(best-effort) → 返回稳定错误码，同 requestId 可重试
6. 业务失败（VERSION_CONFLICT/PERMISSION_DENIED/VALIDATION）→ 删除令牌 → recordFailedWrite(best-effort) → 返回稳定错误码，必须重新 prepare
```

prepare / 首次调用的摘要口径 = 对「该工具 commit 全部参数（去掉 confirmationToken/requestId）」计算；令牌 metadata 中保存 prepare 捕获的 expectedRowVersion 作为兜底校验。

- [ ] **Step 5：运行测试确认通过**

Run: `npm --prefix mcp-server test -- test/write-tools.test.mjs`

Expected: PASS。

## Task 6：集成到会话服务器与失败审计

**Files:**
- Modify: `mcp-server/src/config.mjs`
- Modify: `mcp-server/src/mcp-server.mjs`
- Modify: `mcp-server/src/app.mjs`
- Modify: `mcp-server/src/index.mjs`
- Modify: `mcp-server/src/session-registry.mjs`
- Modify: `mcp-server/test/config.test.mjs`、`app.test.mjs`、`session-registry.test.mjs`、`protocol.integration.test.mjs`

- [ ] **Step 1：config 增加 `MCP_CONFIRMATION_TTL_MS`**

默认 600000（10 分钟），最小 60000，非法值拒绝启动；补 config 测试。

- [ ] **Step 2：`mcp-server.mjs` 签名扩展**

`createSessionMcpServer(repository, writeRepository, confirmationStore)` 内追加 `registerWriteTools(server, writeRepository, confirmationStore)`；版本号升为 `0.2.0`。

- [ ] **Step 3：统一会话销毁钩子与装配**

`SessionRegistry` 构造器新增可选回调 `onSessionDestroyed(sessionId)`，`remove()`、`handleTransportClosed()`、`cleanupExpired()`、`closeAll()` 四条销毁路径统一触发（幂等，每会话只发一次）——当前 `handleTransportClosed()`（session-registry.mjs:78，app.mjs:135 transport close 路径）只删会话不触发撤销，仅在 `remove()` 外层补调用会漏掉 transport close 和 TTL 清理两条路径。`app.mjs` 把回调接到 `confirmationStore.revokeSession()`。进程级单例 `ConfirmationStore`；随现有清理周期调用 `cleanupExpired()`。补三条销毁路径测试：DELETE 端点、transport close、TTL 过期清理，均断言该会话令牌已作废。

- [ ] **Step 4：协议集成测试更新**

`protocol.integration.test.mjs`：`listTools()` 返回 11 个工具（5 读 + 6 写）；完整走通 `prepare_create_pad_task → commit_create_pad_task`（假 Supabase）；commit 后同 requestId 重放返回 `replayed: true`；DELETE 会话后确认令牌失效。

- [ ] **Step 5：运行集成测试确认通过**

Run: `npm --prefix mcp-server test -- test/app.test.mjs test/protocol.integration.test.mjs test/config.test.mjs`

Expected: PASS。

## Task 7：真实环境冒烟、部署与验收文档

**Files:**
- Modify: `mcp-server/scripts/live-smoke.mjs`
- Create: `docs/mcp-phase2-deployment.md`
- Create: `docs/mcp-phase2-acceptance.md`

- [ ] **Step 1：扩展 live-smoke 写入流程**

沿用显式环境变量（`MCP_TEST_URL`、`MCP_TEST_USERNAME`、`MCP_TEST_PASSWORD`），新增顺序用例：

1. `prepare_create_pad_task`（title 前缀 `MCP-SMOKE-`，不传 ownerId/departmentId 验证缺省值闭合）→ 拿到令牌；
2. `commit_create_pad_task` 同 requestId 连续 3 次 → 仅 1 条任务，后两次 `replayed: true`（总体方案 5.3 幂等测试）；
3. `prepare_update_pad_task` 修改标题 → commit 成功；
4. 用旧 expectedRowVersion 再 commit → `VERSION_CONFLICT`；
5. `prepare_update_pad_task` 的 changes 携带 `departmentId` → `INVALID_ARGUMENT` 拒绝（禁止字段）；
6. `submit_pad_task` 首次预览 → 确认提交 → 状态 `submitted`；
7. `commit_create_pad_task` 不带令牌 → `CONFIRMATION_INVALID`；
8. 冒烟任务最终置为 `terminated` 收尾，文档提供手工清理 SQL（MCP 无删除工具）。

- [ ] **Step 2：编写部署文档（含分级回滚）**

内容：SQL 应用顺序（两个迁移依次执行并验证，均为纯新增对象，不修改任何既有权限对象）；mcp-server 更新与 systemd 重启；Nginx 不变；**回滚分级**（关键设计决策 11）——L1 应用回滚（默认）：回退 mcp-server 至第一阶段构建并重启，全部 SQL 对象保留，无数据损失；L2 数据库回滚：`DROP FUNCTION`（五个 RPC 与 `current_user_can_edit_department_reviews`）+ `DROP TABLE mcp_write_log/mcp_audit_log`（均为阶段二新增对象，不涉及任何既有权限对象），仅当用户明确确认不再需要审计数据时执行，执行前必须先导出 `mcp_audit_log`，禁止作为自动回滚步骤；已知限制（内存确认存储重启即清、单实例、Basic Auth 保留至第四阶段、Manager 不能在子部门建任务、任务部门不可经 MCP 移动、processes 表写策略维持 `USING (true)` 现状——应用户确认不修改系统既有权限设计，见关键设计决策 12）。

- [ ] **Step 3：编写验收文档**

按总体方案 5.3 五类测试建矩阵（写入权限 / 确认机制 / 并发 / 幂等事务 / 审计），标注「本地自动化已证」与「等待真实环境 / 真实账号」；固定写入 RPC 信任边界声明（关键设计决策 10）：「MCP 接口层强制两步确认；数据库 RPC 层强制权限/事务/乐观锁/幂等/审计；持有用户 JWT 直接调用 `mcp_*` RPC 不属于 MCP 客户端流程」；附 Admin/Manager/Employee 三账号 TRAE 人工验收步骤（总体方案 §8 材料 6），其中包含 `current_user_can_edit_department_reviews` 与 `save_departments_atomic` 两条路径在三类账号上的判定等价性核对；本地无法证明的项目一律标「等待用户验收」，不得伪报通过。

## Task 8：全量验证与阶段交付

**Files:**
- Modify: `docs/mcp-phase2-acceptance.md`

- [ ] **Step 1：运行 MCP 全量测试**

Run: `npm --prefix mcp-server test`

Expected: 第一阶段 58 项 + 第二阶段新增全部 PASS，无 warning/error 输出。

- [ ] **Step 2：前端回归**

Run: `npm run build`

Expected: Vite build 成功（保留既有大 chunk 警告）。

Run: `npm run lint`

Expected: 与第一阶段基线一致（既有 `ProcessView.tsx` 等历史错误不新增）。

- [ ] **Step 3：更新只读边界扫描口径**

第一阶段验收文档第 6 节的扫描规则需更新：`write-repository.mjs` 允许出现 `client.rpc('mcp_*')` 调用，但生产代码仍禁止 `service_role`/Secret Key、禁止对业务表的 `.insert(/.update(/.upsert(/.delete(` 直写（写入只能经 RPC）。新扫描命令与结果写入验收文档。

- [ ] **Step 4：安全抽查**

确认：响应与日志无密码 / Authorization Header / JWT / Refresh Token；确认令牌不出现在审计或错误消息；`mcp_audit_log` 无 UPDATE/DELETE 策略；审计与幂等表 RLS 仅允许本人 SELECT；任务更新白名单确不含 `department_id`、非 Admin 的 `owner_id` 变更被拒；`mcp_save_review_record` 对仅有菜单权限、无目标部门范围的用户返回 `MCP_PERMISSION_DENIED`；验收文档已包含 RPC 信任边界声明。

- [ ] **Step 5：汇总验收材料并停止**

按总体方案 §8 提交九项材料（功能清单、系统修改清单、测试报告、权限报告、安全报告、TRAE 人工验收步骤、已知限制、部署与回滚说明、第一阶段回归结果），随后停止开发。

只有用户明确回复「第二阶段验收通过，同意开始第三阶段」才能开始第三阶段。
