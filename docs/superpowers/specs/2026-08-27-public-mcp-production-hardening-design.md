# MCP 正式服上线加固设计

## 1. 背景与目标

本设计对应已确认的方案 B，用于在 AI Xing 当前第二阶段 MCP 功能基础上完成正式服上线前加固。

正式数据库的唯一结构基线是提交 `aab58c6`：该提交之前的结构和数据与当前测试库一致，正式迁移只处理该提交之后的增量。当前测试库的第二阶段数据不能直接当作正式库数据使用，因此正式迁移前仍必须在正式库执行只读体检。

本设计的目标是：

- 阻止非法 KR 下标造成 JSONB 数组无限增长；
- 让工作台稳定返回“今日、本周、下周”三个栏目，并允许同一任务重复出现；
- 让任务查询不受 PostgREST 1,000 行限制；
- 让异常历史复盘数据按任务隔离，不拖垮整批查询；
- 让迁移具备版本、顺序、锁和校验和控制；
- 在正式服以单 MCP 实例安全运行，并具备 HTTPS、限流、就绪检查和优雅停止；
- 保留第二阶段已有的认证、两步确认、幂等、并发控制、事务和审计语义。

Redis、多实例、复盘独立表和其他第三、第四阶段内容不在本次范围内。

## 2. 不可变发布基线

发布前先冻结代码和 SQL，不从未提交或脏工作区部署。当前分支 `mcpkf` 的 `HEAD` 为 `763da68`，第二阶段存在一批工作区改动，必须先形成一个可复现提交，再生成发布包和 SQL 清单。

发布清单至少包含：

- `mcp-server/src/` 中的 MCP 应用、认证、Session、读写仓储和工具文件；
- `mcp-server/test/` 中的第二阶段测试；
- `sql/2026-08-21_*`、`sql/2026-08-25_*` 和 `sql/2026-08-26_mcp_p1_hardening.sql`；
- 第二阶段验收和部署文档；
- 本设计后续产生的 KR 校验、分页、索引、就绪检查迁移。

已经应用过的迁移文件一旦冻结，不再原地修改；后续修复全部通过新的前向迁移完成。

## 3. 正式库只读预检查

迁移工具在任何业务结构或业务数据写入前执行预检查，并在失败时停止。迁移历史表属于受控的迁移元数据，只有预检查通过后才允许创建或更新：

1. 确认目标库表、字段、函数和权限与 `aab58c6` 基线相符；
2. 确认正式库没有被误应用的第二阶段对象，或将已有对象纳入明确的 adoption 清单；
3. 统计 `tasks.aligned_kr_id` 的格式异常、KR 不存在和下标越界数量；
4. 统计 `departments.reviews`、周期记录、`okrDetails` 和 `krReviews` 的类型异常数量；
5. 统计任务目标周次缺失、重复或不符合 ISO 周格式的数量；
6. 输出异常任务和部门的 ID 清单，不输出认证信息，不自动删除或修复业务数据。

合法但尚未初始化的复盘槽位不算异常；历史上已经删除的 KR、无法解析的对齐 ID 和错误 JSON 类型进入人工处理清单。

## 4. KR 对齐和复盘数据契约

### 4.1 统一槽位解析

新增共享的槽位解析规则，覆盖 Node、数据库 RPC、周复盘缺口查询和网页端 `utils/reviewTaskState.js`：

- 未对齐任务（空值）使用 `__task__:<taskId>` 和下标 `0`；
- 已对齐任务必须匹配“目标 ID + `-kr-` + 非负十进制整数”的格式；
- 分隔符按最后一个 `-kr-` 解析，避免 Node 和 PostgreSQL 取不同分隔符；
- 先校验数字长度和范围，再转换为 JavaScript/ PostgreSQL 整数；
- 下标必须是安全整数，技术安全上限为每个目标 100 个 KR；
- 非法格式、负数、小数、科学计数法、乱码和超大数字均返回参数错误；
- 已对齐任务不会因为解析失败而静默降级到 `__task__` 槽位。

### 4.2 权威 KR 数量

真实 KR 数量来自当前周期的权威 OKR：

- 公司 OKR：`strategy.company_okrs`；
- 部门 OKR：`departments.okrs`；
- 周次到季度的映射与 `utils/taskOkrOptions.ts` 保持一致。

数据库校验目标 ID 和 KR 下标是否存在，不能使用 `krReviews.length` 反推 KR 数量。目标不存在、目标重复导致无法确定来源、或下标超出真实 `keyResults` 数量，都返回 `MCP_VALIDATION`。

合法 KR 但 `krReviews` 尚未初始化时，可以在真实 KR 数量范围内有限初始化；已存在但类型错误的 `krReviews` 不自动修复。

同一校验不仅用于复盘同步，还用于 MCP 创建和普通更新任务，防止通过任务写入接口保存新的坏对齐 ID。

### 4.3 异常复盘查询

`mcp_get_weekly_review_gaps` 和 Node 读取逻辑采用逐任务分类：

- 周期不存在或为空：`missing`；
- 周期存在但不是数组：`invalid / PERIOD_REVIEWS_NOT_ARRAY`；
- 最新记录不是对象：`invalid / REVIEW_ENTRY_NOT_OBJECT`；
- `okrDetails` 或 `krReviews` 已存在但类型错误：`invalid`；
- 对齐目标或 KR 下标不存在：`invalid / KR_SLOT_NOT_FOUND`；
- 合法但任务评价为空：`blank`。

异常任务返回原因码，其他部门和其他正常任务继续返回，不能因为一条坏 JSON 让整个 RPC 抛错。

## 5. 工作台和任务分页

### 5.1 三栏语义

工作台正式返回三个独立栏目：

- `todayTasks`：当前时间处于 `start_date` 和 `due_date` 之间；
- `thisWeekTasks`：`target_weeks` 包含当前 ISO 周；
- `nextWeekTasks`：`target_weeks` 包含下一 ISO 周；
- 同一任务可以同时出现在三个栏目；
- 三栏不去重，三栏是唯一权威结果。

下一周必须按日期计算 ISO 周，不能使用 `currentWeek + 1` 拼接，避免第 52/53 周跨年产生非法周次。

### 5.2 工作台 RPC

新增 `mcp_get_personal_workbench_page`，由数据库分别查询三个栏目，每栏使用独立游标和 `limit + 1` 判断是否有下一页。游标基于稳定排序：

```text
updated_at DESC, id DESC
```

返回结构：

```text
todayTasks
thisWeekTasks
nextWeekTasks
pageInfo:
  today:      { hasMore, nextCursor, truncated }
  thisWeek:   { hasMore, nextCursor, truncated }
  nextWeek:   { hasMore, nextCursor, truncated }
```

每栏单次最多 50 条。人员补全按任务 ID 每批最多 50 条调用 `mcp_get_task_people`，三个栏目的候选任务可以去重后批量补全，但输出回填时必须保留三栏重复。

兼容字段 `tasks` 暂时保留为三个栏目按“今日、本周、下周”顺序拼接后的去重集合，保持现有调用方行为；它不能取代三个栏目，也不能用于判断栏目内是否允许重复。

### 5.3 可见任务分页

新增 `mcp_get_visible_tasks_page`，在数据库内部先完成权限过滤、关键词、部门、状态和周次过滤，再按稳定排序分页。Node 不再先调用无上限的 `get_visible_tasks_full` 再在内存中筛选。

自动读取设置总上限 10,000 条：

- 5,000 条任务必须可以完整分批读取；
- 超过总上限返回 `truncated=true`；
- `hasMore` 表示数据库仍有下一页，`truncated` 表示应用主动停止继续读取；
- 不依赖 PostgREST 默认 1,000 行限制。

根据 `EXPLAIN ANALYZE` 结果补充 `updated_at/id`、部门、目标周次和人员数组相关索引。大表索引迁移单独执行 `CREATE INDEX CONCURRENTLY`，不与普通事务型迁移混在一起。

## 6. 复盘同步和六个写入工具

六个写入工具继续使用当前两步确认模型：

1. `prepare_create_pad_task`；
2. `commit_create_pad_task`；
3. `prepare_update_pad_task`；
4. `commit_update_pad_task`；
5. `submit_pad_task`；
6. `save_review_record`。

确认令牌绑定用户、Session、工具、参数指纹和首次 `requestId`。数据库幂等键按用户隔离，重试必须复用首次 `requestId`；更换 requestId 不得重新消费令牌。

任务复盘提交继续使用 `mcp_update_pad_task_with_review_sync`：

```text
读取预览
  → 生成确认令牌
  → 提交时检查 requestId 和参数指纹
  → 锁定 tasks
  → 锁定 departments
  → 校验两侧 row_version
  → 校验周期、对齐目标和 KR 下标
  → 同一事务更新任务复盘字段和 departments.reviews
  → 写 mcp_write_log
  → 写 mcp_audit_log
  → 提交
```

任何校验、权限或并发失败都回滚整笔事务。`save_review_record` 继续拒绝直接写入 `taskEvaluations` 和 `taskScores`，任务复盘统一走同步 RPC。

## 7. 迁移控制设计

生产迁移使用受控迁移执行器，不允许在 SQL Editor 中随意重复执行单个文件。执行器使用独立数据库连接配置，不复用 MCP 的 publishable key，也不在日志中记录连接凭据。

迁移历史放在 MCP 内部 schema，例如 `mcp_internal.schema_migrations`，至少包含：

- 唯一版本号；
- 文件名；
- SHA-256 校验和；
- 执行状态；
- 执行时间和耗时；
- 错误码；
- 发布版本。

执行器启动时：

1. 建立单个数据库连接；
2. 获取整批迁移 advisory lock；
3. 校验目标基线为 `aab58c6`；
4. 创建或检查迁移历史表；
5. 按清单顺序逐个迁移；
6. 同版本同校验和显示“已执行”并跳过；
7. 同版本校验和变化立即中止；
8. 已执行版本缺失、顺序错误或依赖不满足时中止；
9. 成功后记录版本，失败则记录失败状态并停止后续版本。

当前测试库如果已经执行过第二阶段但没有迁移历史，必须先做只读对象校验，再通过一次明确的 adoption 操作补登记，不能把当前测试库状态盲目复制到正式库。

### 生产迁移顺序

正式库从 `aab58c6` 开始，顺序固定为：

1. 基线登记：`aab58c6`，不执行基线之前的 SQL；
2. `sql/2026-08-21_mcp_write_infra_tables.sql`；
3. `sql/2026-08-21_mcp_write_rpc.sql`；
4. `sql/2026-08-25_mcp_name_identity_queries.sql`；
5. `sql/2026-08-25_mcp_task_defaults_people_submit.sql`；
6. `sql/2026-08-25_mcp_task_review_sync_rpc.sql`；
7. `sql/2026-08-26_fix_task_users_timeout.sql`；
8. `sql/2026-08-26_mcp_p1_hardening.sql`；
9. 新增 KR/复盘校验迁移；
10. 新增可见任务和工作台分页迁移；
11. 新增索引迁移；
12. 新增只读就绪检查迁移。

由于本次会新增数据库函数、索引、迁移历史表并替换 MCP RPC，因此正式实施时必然需要执行数据库迁移；在 SQL 和代码最终冻结前不提前迁移。

## 8. 正式运行拓扑和安全配置

```text
客户端 → HTTPS/Nginx → 127.0.0.1:8787 MCP → Supabase
```

正式服要求：

- PM2 使用 `fork`，`instances=1`，不使用 cluster；
- MCP 只监听 `127.0.0.1`；
- `MCP_REQUIRE_HTTPS=true`；
- 正式域名加入 `MCP_ALLOWED_HOSTS`；
- 防火墙禁止公网直连 8787；
- Nginx 传递原始 `Host` 和 `X-Forwarded-Proto`；
- Nginx 做 IP 级限流和连接数限制；
- MCP 对初始化、读操作和写操作分别限流；
- 超限返回 429 和 `Retry-After`；
- 日志只记录 requestId、工具名、状态码、耗时和错误码；
- `/health` 只做存活检查；
- `/ready` 检查本地 draining 状态、Supabase 连通性和必需 RPC 是否存在，不使用共享高权限账号。

停止服务时先进入 draining，停止接受新请求，等待正在执行的请求结束，再关闭 Session 和 transport；达到超时时间后才强制关闭。

本次接受单实例重启后 Session 失效，客户端重新 initialize。Redis 共享 Session 和确认令牌留到后续高可用阶段。

## 9. 测试与上线验收

### 自动化测试

- KR 下标：0、负数、小数、超大整数、科学计数法、乱码、越界；
- 合法 KR 与未初始化复盘数组；
- 非法 `reviews`、`okrDetails`、`krReviews` 类型；
- 一条异常记录不影响其他部门；
- 工作台 0、50、51、150 条任务；
- 同一任务同时出现在三栏；
- 三栏独立游标和 `nextCursor`；
- 人员补全按 50 条分批；
- 5,000 条任务完整分页，验证无重复和遗漏；
- 超过总上限返回 `truncated`；
- 迁移重复执行、顺序错误和校验和变化；
- P1 字段保护、requestId 幂等、row_version 冲突和审计；
- `/health`、`/ready`、429、优雅停止和 Session 重建。

### 发布门禁

以下全部通过后才允许正式迁移：

- `npm run mcp:test`；
- `npm run build`；
- MCP Node 文件 `node --check`；
- `git diff --check`；
- 测试库迁移演练；
- 基于 `aab58c6` 的干净数据库迁移演练；
- 三类权限角色的只读、预览和确认写入冒烟；
- 正式环境配置审查和 Nginx 反向代理检查。

## 10. 发布、回滚和人工确认边界

发布顺序：

1. 备份正式数据库；
2. 执行正式库只读预检查；
3. 停止或隔离 MCP 流量；
4. 使用受控执行器按清单迁移；
5. 检查函数、权限、索引和迁移历史；
6. 部署 MCP 应用并检查 `/health`、`/ready`；
7. 使用测试账号执行登录、读取、预览、确认和失败重试冒烟；
8. 开放 Nginx 流量并观察 401、403、429、5xx、超时和确认失败指标。

应用回滚优先回退 MCP 构建并保留新增审计数据和迁移记录。数据库变更以向前修复为主，不自动删除日志表、函数或权限对象；任何数据库回滚都需要单独人工确认和备份校验。

正式迁移仍由用户在正式环境执行。本设计阶段不连接正式库、不读取凭据、不执行任何迁移。
