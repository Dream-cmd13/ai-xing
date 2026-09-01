# 正式服上线阻断项完整修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复提交 `bbba13e` 审查发现的代码、SQL、依赖、运行时和部署资产阻断项，使项目达到进入正式环境只读预检的条件。

**Architecture:** 使用前向 SQL 迁移固化数据库验证和发布契约，MCP 在依赖不就绪或新版 RPC 缺失时失败关闭，前端以规范任务集合加页面作用域 ID 保持状态一致。发布侧使用 loopback MCP、Nginx、systemd 自动恢复和 allowlist 制品脚本；正式库和正式服务器仍由单独授权的现场步骤完成。

**Tech Stack:** React 19、TypeScript、Vite、Supabase/PostgreSQL、Node.js ESM、Express、MCP SDK、Node test runner、systemd、Nginx。

---

## 文件结构

- Modify: `package.json`, `package-lock.json`, `index.html`, `vite.config.ts` — 删除未使用依赖和浏览器密钥注入，升级 Router。
- Create: `scripts/scan-build-secrets.mjs`, `scripts/package-production.mjs` — 构建扫描和 allowlist 发布包。
- Modify: `utils/taskSyncState.js`, `components/ExecutionView.tsx`, `components/ReviewView.tsx`, `data.ts` — 合并作用域任务并统一 50 条人员批次。
- Modify: `components/ProcessView.tsx`, `components/StrategyView.tsx`, `components/WeeklyView.tsx` — 清除已报告 TypeScript 错误。
- Create: `sql/2026-09-01_mcp_task_validation_and_people_security.sql` — 统一任务校验并加固人员函数权限。
- Create: `sql/2026-09-01_mcp_release_contract.sql` — 完整发布 readiness 契约。
- Modify: `mcp-server/scripts/migrate.mjs` — 严格事务外壳和发布 digest。
- Create: `mcp-server/src/readiness-gate.mjs` — 共享 readiness 缓存和并发合并。
- Modify: `mcp-server/src/config.mjs`, `mcp-server/src/app.mjs`, `mcp-server/src/errors.mjs` — 生产 loopback、可信代理和 `/mcp` 门禁。
- Create: `mcp-server/src/repositories/*.mjs` — 按组织、任务、人员、OKR、复盘和流程拆分只读仓储。
- Modify: `mcp-server/src/repository.mjs` — 保留薄组合工厂并删除语义不等价回退。
- Modify: `deploy/systemd/ai-xing-mcp.service.example` — `Restart=always` 和 CentOS 7 限速策略。
- Modify: `docs/mcp-production-deployment-preparation.md` — 更新候选提交、制品和现场门禁。
- Modify/Create tests under `mcp-server/test/` and root `test/` only where an existing runner exists; ad-hoc integration files stay in `local-test-files/`.

### Task 1: 固化基线和失败门禁

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-production-release-blocker-remediation.md`
- Read-only: Git state and current test output

- [ ] **Step 1: 记录权威基线**

Run: `git status --short; git rev-parse --short HEAD; git log -3 --oneline`

Expected: 仅本计划文件未提交，设计提交为 `69703ca`，不出现未知用户修改。

- [ ] **Step 2: 保存现有失败证据**

Run: `npm run lint:app`

Expected: 仅 `ProcessView.tsx`、`StrategyView.tsx`、`WeeklyView.tsx` 的 18 个已知错误。

- [ ] **Step 3: 确认安全审计失败**

Run: `npm audit --omit=dev --registry=https://registry.npmjs.org`

Expected: 根项目存在 critical/high 漏洞；`npm --prefix mcp-server audit --omit=dev --registry=https://registry.npmjs.org` 为零。

### Task 2: 清理前端供应链和密钥注入

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `index.html`
- Modify: `vite.config.ts`
- Create: `scripts/scan-build-secrets.mjs`

- [ ] **Step 1: 写构建扫描脚本**

实现只输出规则名和相对文件名的扫描器：

```js
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['authorization', /Authorization\s*:\s*Bearer\s+/i],
  ['jwt', /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/],
  ['gemini-key-name', /GEMINI_API_KEY|process\.env\.API_KEY/],
];
```

脚本递归读取 `dist/` 文本资产，命中时设置非零退出码，不打印命中内容。

- [ ] **Step 2: 删除浏览器密钥定义和未使用 import map**

`vite.config.ts` 只保留 React 插件、路径别名和现有非敏感构建配置，不再调用 `loadEnv` 注入模型密钥。`index.html` 删除 `@google/genai` 映射。

- [ ] **Step 3: 更新依赖锁**

Run: `npm uninstall @google/genai lodash @types/lodash`

Run: `npm install --save-exact react-router-dom@7.18.2`

如果官方审计仍报告 Router 漏洞，安装当日最新兼容安全补丁并把确切版本写入 `package.json` 和锁文件。

- [ ] **Step 4: 增加脚本门禁**

在 `package.json` 增加：

```json
"scan:dist": "node scripts/scan-build-secrets.mjs",
"build:secure": "npm run build && npm run scan:dist"
```

- [ ] **Step 5: 验证供应链**

Run: `npm run build:secure`

Run: `npm audit --omit=dev --registry=https://registry.npmjs.org`

Expected: 构建和扫描通过，生产依赖漏洞为零。

### Task 3: 修复任务状态、人员批次和 TypeScript

**Files:**
- Modify: `utils/taskSyncState.js`
- Modify: `components/ExecutionView.tsx`
- Modify: `components/ReviewView.tsx`
- Modify: `data.ts`
- Modify: `components/ProcessView.tsx`
- Modify: `components/StrategyView.tsx`
- Modify: `components/WeeklyView.tsx`
- Modify: `mcp-server/test/repository.test.mjs` or create focused root tests using the existing test mechanism

- [ ] **Step 1: 增加作用域合并辅助函数测试**

测试规范：

```js
assert.deepEqual(
  mergeScopedTasks([{ id: 'outside', title: 'keep' }, { id: 'inside', title: 'old' }], [{ id: 'inside', title: 'new' }]),
  [{ id: 'outside', title: 'keep' }, { id: 'inside', title: 'new' }],
);
```

基线集合执行同一合并，不删除未加载任务。

- [ ] **Step 2: 页面保存作用域 ID 并合并任务**

页面加载成功后执行等价逻辑：

```ts
const loadedIds = new Set(loadedTasks.map((task) => task.id));
setScopedTaskIds(loadedIds);
setState((current) => ({ ...current, tasks: upsertTasksById(current.tasks, loadedTasks) }));
setLastSavedTasks((current) => upsertTasksById(current, loadedTasks));
```

渲染使用 `tasks.filter(task => scopedTaskIds.has(task.id))`。加载空结果时页面为空，但全局集合不被清空。

- [ ] **Step 3: 人员补全改为 50 条**

`data.ts` 使用常量：

```ts
const TASK_PEOPLE_BATCH_SIZE = 50;
for (let index = 0; index < uniqueTaskIds.length; index += TASK_PEOPLE_BATCH_SIZE) {
  batches.push(uniqueTaskIds.slice(index, index + TASK_PEOPLE_BATCH_SIZE));
}
```

测试断言 51 条拆成 50+1，150 条拆成三批。

- [ ] **Step 4: 修复 18 个类型错误**

`ProcessView` 将字符串真值判断显式转换为 Boolean；`StrategyView` 统一 AI 建议状态类型中的 `id/text/score/suggestions` 并把模式值统一为 `annual | quarterly`；`WeeklyView` 为 modal 状态补全 `mode`，使 `index` 类型允许 `null`，删除被字面量 `user` 永久收窄后的不可达 `dept` 比较或改用真实状态来源。

- [ ] **Step 5: 验证**

Run: `npm run lint:app; npm run build:secure`

Expected: TypeScript 零错误，构建和扫描通过。

### Task 4: 新增统一 SQL 校验和人员权限迁移

**Files:**
- Create: `sql/2026-09-01_mcp_task_validation_and_people_security.sql`
- Modify: `mcp-server/scripts/migrate.mjs`
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs`
- Modify: `mcp-server/test/migration-runner.test.mjs`

- [ ] **Step 1: 先写 SQL 静态契约测试**

断言新迁移包含：

```js
assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mcp_validate_task_changes\(JSONB, BOOLEAN\)/i);
assert.match(sql, /SET search_path = public/i);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_current_user_task_users_for_tasks\(TEXT\[\]\)/i);
assert.match(sql, /GRANT EXECUTE .* TO authenticated/i);
```

并检查三个更新 RPC 均调用 `mcp_validate_task_changes`。

- [ ] **Step 2: 实现规范校验辅助函数**

函数签名：

```sql
public.mcp_validate_task_changes(p_changes JSONB, p_allow_submitted BOOLEAN DEFAULT FALSE)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
```

函数对白名单字段逐一检查 JSON 类型、枚举、长度、ISO 周、日期顺序、数组数量和 KR 下标；失败统一抛出 `MCP_VALIDATION:` 前缀。

- [ ] **Step 3: 前向替换三个 RPC**

复制当前已入账函数的完整定义，在写入前调用：

```sql
PERFORM public.mcp_validate_task_changes(p_changes, FALSE);
```

复盘同步入口传入其实际允许的提交状态，保留权限、行锁、row_version、审计和幂等逻辑。

- [ ] **Step 4: 加固人员函数**

在同一迁移中按当前函数体重新创建并添加固定搜索路径，然后执行：

```sql
REVOKE ALL ON FUNCTION public.get_current_user_task_users_for_tasks(TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_current_user_task_users_for_tasks(TEXT[]) TO authenticated;
```

- [ ] **Step 5: 加入 manifest 并验证**

Run: `node --test mcp-server/test/phase2-sql-contract.test.mjs mcp-server/test/migration-runner.test.mjs`

Expected: manifest 数量增加一，SQL 文件与清单一致，静态契约通过。

### Task 5: 完整发布契约和严格事务外壳

**Files:**
- Create: `sql/2026-09-01_mcp_release_contract.sql`
- Modify: `mcp-server/scripts/migrate.mjs`
- Modify: `mcp-server/test/migration-runner.test.mjs`
- Modify: `mcp-server/test/phase2-sql-contract.test.mjs`

- [ ] **Step 1: 写事务外壳失败测试**

覆盖前导注释、块注释、字符串中的 `BEGIN/COMMIT`、重复外壳、缺失终止和外壳外可执行语句。正常 SQL 发送给 fake client 后不得匹配：

```js
assert.doesNotMatch(executedSql, /^\s*BEGIN\b|\bCOMMIT\s*;\s*$/i);
```

- [ ] **Step 2: 实现词法级外壳解析**

解析器逐字符识别单引号、双引号、美元引号、行注释和块注释，只记录顶层语句。事务型文件必须第一条为 `BEGIN`、最后一条为 `COMMIT` 且各出现一次，否则抛出 `MIGRATION_ENVELOPE_INVALID`。

- [ ] **Step 3: 写发布契约迁移**

新增 `mcp_internal.release_contracts`，并让 `public.mcp_get_readiness()` 检查固定 release ID、manifest digest、必需版本成功状态、关键 RPC 签名和权限。结果保留现有 `companyOkrsRpc` 等兼容布尔字段，并新增：

```json
{"releaseId":"2026-09-01","manifestDigest":"...","requiredMigrations":true,"functionPrivileges":true,"deferredIndexes":"ready|pending|failed"}
```

- [ ] **Step 4: 迁移器记录契约**

执行完全部事务迁移后，在同一受控连接写入 release ID 和由有序 `version:checksum` 计算的 SHA-256。deferred 索引不影响事务发布 digest，但独立记录状态。

- [ ] **Step 5: 验证**

Run: `node --test mcp-server/test/migration-runner.test.mjs mcp-server/test/phase2-sql-contract.test.mjs`

Expected: 所有外壳、digest、顺序、回滚 fake 测试通过。

### Task 6: MCP readiness、代理和生产绑定失败关闭

**Files:**
- Create: `mcp-server/src/readiness-gate.mjs`
- Modify: `mcp-server/src/app.mjs`
- Modify: `mcp-server/src/config.mjs`
- Modify: `mcp-server/src/errors.mjs`
- Modify: `mcp-server/test/app.test.mjs`
- Modify: `mcp-server/test/config.test.mjs`
- Modify: `mcp-server/test/session-resilience.test.mjs`

- [ ] **Step 1: 写 readiness gate 单元/集成测试**

测试 degraded、超时、并发去重、TTL 后恢复、新 initialize、已有 Session、GET 和 DELETE。失败响应统一为 HTTP 503：

```json
{"error":{"code":"SERVICE_NOT_READY","message":"服务依赖尚未就绪，请稍后重试。"}}
```

- [ ] **Step 2: 实现共享门禁**

`createReadinessGate({ check, ttlMs, timeoutMs, now })` 缓存最近结果并保存单个 in-flight Promise；异常和超时映射为 degraded，不泄漏底层错误。

- [ ] **Step 3: 应用到全部 `/mcp` 方法**

在 POST/GET/DELETE `/mcp` 路由的第一段调用 `await readinessGate.requireReady()`；`/ready` 使用 `readinessGate.status()`，`/health` 保持不变。

- [ ] **Step 4: 强制生产 loopback 和可信代理**

`config.mjs` 在 `NODE_ENV=production` 时拒绝非 `127.0.0.1`/`::1` 主机。`isHttpsRequest` 只有在 `req.socket.remoteAddress` 属于配置的 loopback 可信代理时读取 `X-Forwarded-Proto`，否则只使用直接 TLS 状态。

- [ ] **Step 5: 验证**

Run: `node --test mcp-server/test/app.test.mjs mcp-server/test/config.test.mjs mcp-server/test/session-resilience.test.mjs`

Expected: readiness 和伪造转发头测试通过。

### Task 7: 删除语义降级并拆分只读仓储

**Files:**
- Create: `mcp-server/src/repositories/internal/repository-helpers.mjs`
- Create: `mcp-server/src/repositories/organization-repository.mjs`
- Create: `mcp-server/src/repositories/task-read-repository.mjs`
- Create: `mcp-server/src/repositories/task-people-repository.mjs`
- Create: `mcp-server/src/repositories/okr-repository.mjs`
- Create: `mcp-server/src/repositories/review-gap-repository.mjs`
- Create: `mcp-server/src/repositories/process-repository.mjs`
- Modify: `mcp-server/src/repository.mjs`
- Modify: `data.ts`
- Modify: `mcp-server/test/repository.test.mjs`

- [ ] **Step 1: 先锁定公共 API**

测试 `createRepository()` 返回的现有方法名集合、输入和输出不变。为缺少 v2 RPC 增加断言：`auto/subtree`、周复盘和部门 OKR 抛出公开码 `RPC_NOT_CONFIGURED`，不调用旧 RPC。

- [ ] **Step 2: 提取共享基础设施**

`repository-helpers.mjs` 只导出 timeout、错误映射、游标和缺失函数识别；每个领域 factory 接收 `execute/client/context`，不互相读内部状态。

- [ ] **Step 3: 机械迁移领域方法**

按组织、任务、人员、OKR、复盘、流程依次移动现有实现。`repository.mjs` 最终只构建共享依赖并返回：

```js
return {
  ...createOrganizationRepository(deps),
  ...createTaskReadRepository(deps),
  ...createTaskPeopleRepository(deps),
  ...createOkrRepository(deps),
  ...createReviewGapRepository(deps),
  ...createProcessRepository(deps),
};
```

- [ ] **Step 4: 前端作用域查询失败关闭**

`data.ts` 对 `scope=auto|subtree` 缺少 `web_get_visible_tasks_scope_v2` 时抛出可识别配置错误；`scope=exact` 只有静态契约证明旧 RPC 等价时才允许兼容调用。删除全量任务再按 departmentId 过滤的兜底。

- [ ] **Step 5: 验证**

Run: `node --test mcp-server/test/repository.test.mjs mcp-server/test/tools.test.mjs mcp-server/test/protocol.integration.test.mjs`

Expected: 公共工具契约不变，缺少必需 RPC 时稳定失败关闭，`repository.mjs` 为薄组合文件。

### Task 8: systemd、发布包和 CentOS 7 文档

**Files:**
- Modify: `deploy/systemd/ai-xing-mcp.service.example`
- Create: `scripts/package-production.mjs`
- Modify: `package.json`
- Modify: `docs/mcp-production-deployment-preparation.md`
- Create: `local-test-files/package-production.test.mjs` if no reusable root test runner exists

- [ ] **Step 1: 更新 systemd 模板**

使用：

```ini
Restart=always
RestartSec=5s
StartLimitInterval=60
StartLimitBurst=10
LimitNOFILE=65536
```

文档说明 `systemctl enable`、告警和人工停止语义，不执行任何服务命令。

- [ ] **Step 2: 实现 allowlist 打包**

脚本从显式数组复制根前端运行文件、`dist/`、MCP `src/`、运行依赖锁、部署模板和 manifest 中 SQL。输出目录必须由命令行显式给出且位于工作区内的 `release-output/`；已存在目录时拒绝覆盖。

- [ ] **Step 3: 添加制品验证**

脚本拒绝 `.env`、`local-test-files`、诊断/回填/live-smoke、日志和未知 SQL；生成 `SHA256SUMS.json`，内容为相对路径和摘要，不含本机绝对路径。

- [ ] **Step 4: 更新独立部署文档**

将旧 `HEAD=113f868` 替换为“构建时从 Git 读取候选提交”，记录 CentOS 7 两条运行时路径、正式库只读预检、45 条异常数据处置、备份恢复、权限验收和最终标签条件。

- [ ] **Step 5: 验证打包但不生成正式制品**

在临时目录运行脚本测试，断言禁止文件不存在、摘要覆盖全部文件；测试后删除临时目录。

### Task 9: 全量门禁与完成度审计

**Files:**
- Modify: `docs/mcp-production-deployment-preparation.md` only for final local evidence

- [ ] **Step 1: 全量自动化**

Run: `npm run lint:app`

Run: `npm run build:secure`

Run: `npm run mcp:test`

Run: `Get-ChildItem mcp-server -Recurse -Filter *.mjs | ForEach-Object { node --check $_.FullName }`

Run: `git diff --check`

- [ ] **Step 2: 双依赖审计**

Run: `npm audit --omit=dev --registry=https://registry.npmjs.org`

Run: `npm --prefix mcp-server audit --omit=dev --registry=https://registry.npmjs.org`

Expected: 两者生产漏洞均为零。

- [ ] **Step 3: 清单和敏感信息审计**

验证迁移 manifest 与 SQL 文件一一对应；扫描源代码、构建产物和临时制品时只输出规则与文件，不输出任何命中内容。

- [ ] **Step 4: 逐项核对设计**

对设计文档第 4 到第 9 节逐项关联测试或文件证据。任何未验证项保持为阻断，不用局部绿色测试替代整体完成声明。

- [ ] **Step 5: 记录仍需现场授权项**

正式库、45 条历史数据、备份恢复、正式迁移、CentOS 7 真机、Nginx/HTTPS、防火墙和角色验收保持未完成，直到用户另行授权并取得真实证据。

