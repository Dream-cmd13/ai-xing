# AI Xing 正式服部署前准备基准

> 文档状态：部署前准备草案，供代码/迁移审查和正式库只读检查使用。未完成全部门禁前不得上线。
>
> 目标平台：CentOS 7。本文不要求现在连接正式库，不执行正式库迁移，不启动或停止正式服务。

## 1. 使用边界

本文是独立的正式服部署前准备文档。现有阶段一部署说明、阶段性验收记录和历史实施计划保留为历史资料，不作为本次正式发布的唯一依据。

本次发布范围固定为：

- 正式库结构基线：提交 `aab58c6`，提交标题为“fix: 季度复盘从当前KR记录生成总结和综合评分”；
- 基线之后已提交的 MCP 第一阶段代码：当前 `HEAD` 为 `113f868`；
- 当前工作区中经过本次审查、冻结并形成发布提交的第二阶段代码和 SQL；
- 现有网站、Flask 服务、Supabase 认证和已有业务权限边界。

明确不纳入：

- 第三阶段 KR 进度模型、趋势诊断和结构化 KR 迁移；
- 第四阶段 OAuth、Redis、多实例、主动预警和高可用；
- 与 MCP 发布无关的前端 lint 清理、临时脚本和工作区用户修改；
- 任何未进入冻结发布提交的文件。

当前结论：工作区尚未形成可部署的冻结提交，正式库尚未接受只读检查，因此当前状态是“准备中”，不是“可上线”。

## 2. 不可违反的操作限制

- 不在本文、日志、命令输出或提交中记录密码、JWT、Authorization、Refresh Token、密钥、高权限配置或数据库连接串。
- MCP 运行进程只允许使用 Supabase 公共 URL 和 Publishable/Anon Key；禁止注入 Service Role Key、Secret Key、数据库密码、`DATABASE_URL` 或迁移专用连接变量。
- 正式库检查先只读，必须由负责人单独授权后才可以执行正式迁移或写入操作。
- 迁移只通过受控迁移器执行，不直接在正式库 SQL Editor 粘贴整批文件。
- 不使用 `git reset --hard`、`git checkout --` 或其他破坏性操作，不回滚无关用户修改。
- 临时诊断脚本只能放在 `local-test-files/`；正式源码、测试和文档不得放入该目录。
- 本文中的命令是操作员 runbook，不代表本次已经执行；当前环境仍不得连接正式库。

## 3. 发布对象与冻结规则

### 3.1 版本定义

正式发布必须从干净的发布提交或标签构建，不能直接从当前脏工作区复制。发布前建立一份只包含本次范围的变更清单：

```text
数据库基线：aab58c6
已提交应用基线：113f868
候选发布：审查通过后的独立提交/标签
```

当前 `HEAD` 只代表第一阶段 MCP 提交。第二阶段文件、数据库迁移、运行时加固和部分网页改动目前仍可能处于未提交状态，必须先完成审查、拆分无关文件、形成单独发布提交，再计算发布校验和。

### 3.2 发布清单

发布包至少包含：

- 根项目锁文件和构建配置；
- `mcp-server/package.json`、`mcp-server/package-lock.json`；
- `mcp-server/src/` 中的 MCP 运行时、认证、会话、查询、写入和输入校验模块；
- `mcp-server/scripts/migrate.mjs` 及其测试；
- 经过审查的 `sql/2026-08-*` 迁移文件；
- `deploy/systemd/ai-xing-mcp.service.example`；
- `deploy/nginx/mcp-location.conf.example`；
- 本文和与本版本对应的验收材料。

以下文件不属于迁移清单：

- `sql/2026-08-27_mcp_review_data_scan.sql` 是只读数据质量预检脚本，不得登记到迁移账本；
- `local-test-files/` 下的临时文件；
- `mcp-server/scripts/diagnose-session.mjs`、`mcp-server/scripts/backfill-task-period.mjs` 等诊断/数据处理脚本不得随正式应用包发布；前者只用于本地会话诊断，后者包含显式数据库更新入口；
- `mcp-server/scripts/live-smoke.mjs` 不属于正式服务启动路径。它会创建、更新和提交测试任务，必须只对隔离测试账号和测试库运行，且不能作为“正式库只读检查”命令；
- `flask/__pycache__/` 等生成物；
- 与本次发布无关的用户工作区修改。

发布前对所有纳入文件执行 SHA-256，并把校验和存入发布记录。不要把环境文件内容或任何密钥作为发布记录的一部分。

## 4. 目标运行拓扑

```text
客户端
  -> 现有 HTTPS 域名 /mcp
  -> Nginx 反向代理
  -> 127.0.0.1:8787 MCP Node 进程
  -> Supabase 公共 API（按当前用户 JWT 执行 RLS）
```

CentOS7 上的 MCP 进程由 `systemd` 托管，使用独立系统账号运行；Nginx 是公网入口，8787 只允许本机回环访问。MCP Session、确认令牌和限流计数仍为单实例内存状态，进程重启后客户端必须重新 initialize。

## 5. CentOS7 前置条件

在服务器上只做只读检查，确认以下条件后才进入部署窗口：

```bash
cat /etc/centos-release
node --version
npm --version
systemctl --version
nginx -v
uname -m
ldd --version
```

要求：

- Node.js 满足 `mcp-server/package.json` 的 `engines.node >= 20`；
- Node 二进制与 CentOS7 的架构和运行库兼容。若系统自带 Node 不满足要求，应使用经过验证的独立 Node 安装，不在部署窗口临时升级系统运行库；
- npm 可以使用锁文件完成离线/受控依赖安装；
- Nginx 已有可用 HTTPS server 块和证书；
- 服务器可以访问 Supabase 公共 API；
- systemd 支持 `EnvironmentFile`、重启策略和服务沙箱指令；
- 已准备独立的 `ai-xing` 系统用户、项目目录和只允许该用户读取的环境文件目录。

如果 Node 版本、运行库、Nginx 或 systemd 条件不满足，先停止发布，不在正式窗口临时修改基础设施。

## 6. 本地发布前门禁

以下命令只针对本地工作区或隔离测试环境执行，不连接正式库：

```bash
git status --short
git diff --check
npm ci
npm --prefix mcp-server ci --omit=dev
npm run build
npm run mcp:test
```

MCP 源码和脚本逐文件检查语法：

```bash
find mcp-server/src mcp-server/scripts -type f -name '*.mjs' -print0 \
  | xargs -0 -n1 node --check
```

门禁要求：

- MCP 全量 Node 测试全部通过；
- 前端构建通过；
- 所有 `.mjs` 语法检查通过；
- `git diff --check` 无错误；
- 发布清单中没有生成物、临时凭据或无关修改；
- 已知的非本阶段前端 lint 基线问题单独记录，不以无关 lint 修复扩大本次范围。

不要用 `npm install` 替代 `npm ci`，也不要在正式服务器上运行开发服务器或迁移测试。

### 6.1 当前本地进程证据

当前 Windows 本地 8787 进程链为 `VS Code -> PowerShell -> npm -> cmd -> node`，没有 Windows 服务托管。该进程会随承载它的终端或 IDE 生命周期结束，不能作为常驻运行证明；CentOS7 上必须以独立 `systemd` unit 托管后再做重启和异常退出验收。

### 6.2 本轮本地审查记录

以下结果是 2026-08-31 在当前工作区执行的本地证据，不代表正式库或 CentOS7 已通过部署门禁：

- `npm run mcp:test`：258/258 通过；
- `npm run build`：通过，仅保留既有大 chunk 警告；
- `mcp-server/src/` 与 `mcp-server/scripts/` 共 22 个 `.mjs` 文件：`node --check` 全部通过；
- `git diff --check`：通过；
- 迁移器实际 manifest 为 26 个文件，清单中的文件全部存在；
- 26 个迁移中，24 个事务文件在当前 `unwrapTransaction()` 处理后仍保留内部 `BEGIN`，迁移原子性阻断项仍未关闭；
- SQL 和发布文件扫描未发现疑似硬编码凭据；
- 根目录 `.env` 存在数据库/高权限配置变量名，未读取其值；发布包和 systemd 环境必须排除该文件，MCP 只允许使用 `mcp-server/.env` 或受控 `EnvironmentFile`；
- 本地 8787 当前只监听 `127.0.0.1`，`/health` 与 `/ready` 正常，但进程仍由 npm 链路托管；
- 本轮未连接正式库、未执行数据库写入或正式迁移、未启动/停止/重启服务。

因此本节证据只能证明本地构建和测试状态，不能替代第 8 节正式库只读检查或第 10、12 节 CentOS7 实机验收。

## 7. 应用代码审查门禁

代码审查必须以当前工作区相对于 `aab58c6` 的完整差异为对象，而不是只看最近一个提交。至少覆盖：

### 7.1 运行时和进程生命周期

- `mcp-server/src/index.mjs` 只读取 `mcp-server/.env` 或 systemd `EnvironmentFile`，不读取项目根目录 `.env`；
- `/health` 只表示进程存活，`/ready` 表示依赖和迁移契约已满足；
- 监听端口固定为 `127.0.0.1:8787`，不得遗留 `8878` 等历史端口；
- 启动失败、端口占用、停止信号和自然退出均可从结构化日志区分；
- 日志只保留请求 ID、路径/工具名、状态、耗时和安全错误码，不记录请求体、密码或令牌；
- 优雅停止先进入 draining，再等待短请求和 Session 关闭；
- systemd 负责进程重启，应用本身不得偷偷派生第二个 MCP 进程。

### 7.2 认证、权限和写入边界

- Basic Auth 只用于建立 Supabase 用户会话，认证失败对外返回稳定错误；
- 数据库查询使用当前用户 JWT 和既有 RLS，不接受调用方伪造的用户 ID、角色或部门权限；
- 写入工具必须经过预览、确认令牌、请求 ID 幂等和行版本校验；
- 任务复盘通过原子 RPC 同步 `tasks` 和 `departments.reviews`；
- `save_review_record` 不得直接写入任务卡片字段；
- 父、子、兄弟部门只读范围和跨顶级部门隔离必须与已确认规则一致；
- KR 下标、周期、任务人员和复盘 JSON 必须在 Node、网页和数据库边界分别校验。

### 7.3 当前审查阻断项

以下问题在正式部署前必须关闭，当前不能以本地测试通过替代：

- `mcp-server/scripts/migrate.mjs` 的 `unwrapTransaction()` 只匹配 SQL 文件开头的 `BEGIN;`。多数事务迁移先有注释，导致 SQL 内部 `BEGIN/COMMIT` 可能未被剥离，外层账本事务存在被提前提交的风险；
- readiness 目前主要检查少量 RPC、部分 OKR 版本和对象存在性，未证明完整 26 项 manifest、全部校验和、全部成功状态及 `authenticated` 执行权限一致；
- `/ready` 返回非 ready 时，`/mcp` 初始化路径仍可继续创建会话；正式入口必须在应用层和反向代理层都 fail-closed；
- 范围 RPC 缺失时，部分周任务、周复盘缺口和部门 OKR 路径仍会回退旧 RPC；正式库若迁移不完整，可能静默退化为旧部门范围；
- `mcp_update_pad_task_scoped()` 和 scoped review-sync 更新字段范围较宽，但没有完整复用普通更新 RPC 的状态、优先级、标题、周次、日期、tags、数组和文本校验；
- `components/ExecutionView.tsx`、`components/ReviewView.tsx` 的范围加载会直接替换全局任务集合和 `lastSavedTasks`，必须改为按任务 ID 合并，不能污染其他页面状态或回滚基线；
- `get_current_user_task_users_for_tasks()` 是 `SECURITY DEFINER`，但定义中未固定 `search_path`，需要在正式库权限检查前处置；
- systemd 模板使用 `Restart=on-failure`，只能自动恢复异常退出，不能保证人工停止后自动拉起；“不可停止”不是系统可验证保证；
- `MCP_REQUIRE_HTTPS` 开启时应用信任 `X-Forwarded-Proto`。只有在 8787 仅回环监听且 Nginx 是唯一入口时才成立，禁止把 MCP 直接绑定公网地址；
- CentOS7 的 Node 20 与系统运行库尚未完成实机兼容性验证；
- `mcp-server/src/repository.mjs` 当前约 1200 行，集中承载组织、任务、OKR、复盘、分页和降级逻辑，必须在发布前拆分为职责明确的模块；
- 网页人员补全目前按 100 个任务分批，而 MCP 路径按 50 个分批，必须统一边界并补充前端批次测试；
- `diagnose-session.mjs`、`backfill-task-period.mjs`、`live-smoke.mjs` 不得进入正式发布包；其中数据回填和 live smoke 含数据库写入入口。

### 7.4 查询容量和数据质量

- 工作台固定返回今日、本周、下周三栏，允许同一任务跨栏重复；
- 人员补全每批不超过 50 个任务；
- 可见任务使用 `(updated_at DESC, id DESC)` 游标，自动读取总上限为 10,000；
- 坏历史复盘返回明确原因码，不自动覆盖业务数据；
- `includeTasks=true` 的公司和部门 OKR 仍保留目标、KR 和任务槽位，不能因历史 JSON 形态退化为空；
- `/ready` 必须在完整 OKR 任务挂载修复登记前保持非 ready。

## 8. 数据库基线和只读预检查

正式数据库交由负责人提供后，先确认连接目标确实是正式库，并只执行只读查询。当前不得执行本节命令。

预检查至少包括：

1. 服务器版本、当前角色、当前数据库和时区；
2. `public.tasks`、`public.departments`、`public.users`、`public.strategy` 及其关键字段；
3. 基线相关函数、触发器、RLS 状态和角色权限；
4. `mcp_internal.schema_migrations` 是否存在、账本版本/状态/校验和；
5. 已存在的 MCP RPC 签名、函数体关键片段和 `authenticated` 执行权限；
6. `sql/2026-08-27_mcp_review_data_scan.sql` 的只读数据质量结果；
7. 任务时间字段、`aligned_kr_id`、`reviews`、`okrDetails`、`krReviews` 和周期结构是否存在历史异常；
8. 8787 端口、Nginx upstream 和现有网站路由是否有冲突。

预检查结果只记录对象名、版本、数量、状态和原因码，不复制业务复盘正文，不导出密钥或连接信息。正式库未提供前，只能审查查询脚本和预期结果，不能声称正式库满足基线。

## 9. 迁移清单与执行规则

受控迁移器 `mcp-server/scripts/migrate.mjs` 固定以 `aab58c6` 为基线，使用 advisory lock、SHA-256 校验和、顺序检查和账本记录。当前清单顺序如下：

1. `2026-08-21_mcp_write_infra_tables.sql`
2. `2026-08-21_mcp_write_rpc.sql`
3. `2026-08-25_mcp_name_identity_queries.sql`
4. `2026-08-25_mcp_task_defaults_people_submit.sql`
5. `2026-08-25_mcp_task_review_sync_rpc.sql`
6. `2026-08-26_fix_task_users_timeout.sql`
7. `2026-08-26_mcp_p1_hardening.sql`
8. `2026-08-27_mcp_migration_control.sql`
9. `2026-08-27_mcp_review_slot_hardening.sql`
10. `2026-08-27_mcp_task_pagination.sql`
11. `2026-08-27_mcp_readiness.sql`
12. `2026-08-27_mcp_task_indexes.sql`
13. `2026-08-28_web_task_load_p0_p1.sql`
14. `2026-08-28_mcp_okr_queries.sql`
15. `2026-08-29_nested_department_scope.sql`
16. `2026-08-29_nested_department_permission_alignment.sql`
17. `2026-08-29_department_tree_peer_read_visibility.sql`
18. `2026-08-29_department_tree_peer_read_performance.sql`
19. `2026-08-29_department_scope_task_read_performance.sql`
20. `2026-08-29_nested_department_task_write_trigger_alignment.sql`
21. `2026-08-30_mcp_department_okr_periods_fix.sql`
22. `2026-08-31_mcp_okr_contract_hardening.sql`
23. `2026-08-31_mcp_okr_task_attachment_fix.sql`
24. `2026-08-31_mcp_okr_task_attachment_json_fallback.sql`
25. `2026-08-31_mcp_okr_readiness_gate.sql`
26. `2026-08-31_web_task_center_scoped_pagination.sql`

执行要求：

- 先做数据库备份、只读预检查和迁移文件校验和确认；
- 先执行事务迁移；第 12 项索引迁移默认 deferred；
- 只有在目标数据量下完成 `EXPLAIN (ANALYZE, BUFFERS)` 和写入影响评估，并得到单独授权后，才使用 `--include-indexes`；
- 已有历史对象但没有账本时，只有在逐项对象、函数体和权限检查全部通过后，才可以明确授权使用 `--adopt-existing`；干净的正式库禁止使用接管模式；
- 同版本同校验和必须返回 `skipped`，校验和变化、顺序缺口和历史失败必须停止；
- 普通事务失败应回滚；非事务索引中途失败可能留下已创建索引，必须人工检查后处理，禁止盲目重跑；
- 迁移命令的连接变量只存在于一次性受控命令环境，不能被 MCP systemd 服务继承。

## 10. CentOS7 部署准备

### 10.1 目录和账号

建议目录：

```text
/opt/ai-xing/                 发布目录
/opt/ai-xing/mcp-server/     MCP 服务目录
/etc/ai-xing/mcp.env         运行环境文件，权限 600
/etc/systemd/system/ai-xing-mcp.service
```

使用独立系统账号 `ai-xing` 运行 Node 进程。该账号只需要读取发布目录和运行环境，不应拥有迁移连接凭据、系统管理员权限或其他应用密钥。

### 10.2 运行环境文件

生产环境必须使用独立文件，不把真实值提交到 Git。文件只允许包含 Supabase 公共配置和 MCP 运行参数，例如：

```dotenv
MCP_HOST=127.0.0.1
MCP_PORT=8787
MCP_REQUIRE_HTTPS=true
MCP_ALLOWED_HOSTS=<现有域名>
```

其余参数按 `.env.example` 和已审查的运行时默认值配置。不要在该文件加入迁移数据库变量、数据库密码、Service Role Key、Secret Key、Access Token 或其他高权限值。

### 10.3 systemd

以 `deploy/systemd/ai-xing-mcp.service.example` 为模板，安装前根据真实发布目录核对 `User`、`Group`、`WorkingDirectory`、`EnvironmentFile` 和 `ExecStart`。当前模板使用 `Restart=on-failure`，含义是异常退出自动拉起，人工 `systemctl stop` 仍然有效；“永久不可停止”不是可验证的系统保证，电源、内核、网络和人工停机仍需单独处理。

安装前只做语法验证：

```bash
sudo systemd-analyze verify /etc/systemd/system/ai-xing-mcp.service
```

确认 unit 与发布包、环境文件和端口一致后，才可在授权的正式窗口执行 `daemon-reload`、`enable`、`start` 或 `restart`。本准备阶段不执行这些命令。

### 10.4 Nginx

以 `deploy/nginx/mcp-location.conf.example` 为模板加入现有 HTTPS `server {}`：

- 保留 `Host`、`X-Forwarded-Proto`、`Mcp-Session-Id` 和必要的 Authorization 转发；
- 关闭代理缓冲，设置足够的读写超时；
- 8787 不开放公网；
- `nginx -t` 通过后才允许 reload；
- 不将内部 `/ready` 或任何凭据暴露到公网诊断页面。

## 11. 授权后的部署顺序

以下是未来正式窗口的顺序，不代表现在执行：

1. 冻结并标记发布提交，保存文件校验和；
2. 在 CentOS7 做 Node、运行库、磁盘、端口、systemd 和 Nginx 只读预检查；
3. 发布应用文件并使用 `npm ci` 安装锁定依赖；
4. 安装权限为 600 的 MCP 运行环境文件；
5. 对正式库做只读基线、账本、权限、索引和坏数据预检查；
6. 负责人明确授权后，使用迁移器按第 9 节执行事务迁移；
7. 单独评估并授权索引迁移；
8. 安装并验证 systemd unit，先在本机检查 `/health` 和 `/ready`；
9. 配置并验证 Nginx，确认 `/mcp` 只通过 HTTPS 访问；
10. 先在隔离测试库使用不记录凭据的 Admin、Manager、Employee 冒烟流程验证读、预览、确认写入和权限隔离；正式库只允许经单独授权的最小只读检查，禁止直接运行会创建/更新任务的 `live-smoke.mjs`；
11. 保存 `systemctl status`、结构化日志摘要、健康检查和迁移账本摘要；
12. 只有所有门禁通过后，才宣布恢复部署条件满足。

## 12. 上线验收

### 12.1 进程和网络

- 重启服务器后 systemd 能自动拉起 MCP；
- 模拟 Node 异常退出后能自动恢复，且日志能区分启动失败、端口占用和外部停止；
- `127.0.0.1:8787/health` 返回 `status=ok`；
- `/ready` 只有在迁移和必需 RPC 完整时返回 ready；
- 当 `/ready` 返回 503 时，新的 `/mcp` initialize 和已有会话请求都必须被拒绝，不能依赖调用方自行遵守健康检查；
- 公网只能通过 HTTPS `/mcp` 访问，8787 无公网暴露；
- Nginx 长连接、Session Header、超时和缓冲策略符合模板。

### 12.2 数据和权限

- 26 个迁移版本顺序、状态和校验和与发布记录一致；
- 第 12 项索引的执行计划和落地状态单独记录；
- 公司 2026 年 OKR、产品部 Q3 OKR 的 `includeTasks=false/true` 结果均完整；
- 同一顶级部门树的父、子、兄弟只读规则正确，跨顶级部门树隔离；
- 父部门负责人可以在管理子树创建/复盘任务，普通成员不能越权写入；
- scoped 普通任务更新和 scoped review-sync 对非法状态、优先级、标题、周次、日期、tags、人员数组和文本长度的拒绝结果与普通更新 RPC 一致；
- 执行页和复盘页切换部门/周期后只合并范围任务，不丢失其他范围任务，也不改变全局保存回滚基线；
- 坏历史数据返回原因码，不自动修复或覆盖；
- 六个写入工具的预览、确认、幂等、行版本冲突和审计均通过。

### 12.3 安全和日志

- 运行环境没有高权限数据库或 Supabase 密钥；
- 日志和验收材料没有密码、JWT、Authorization、Refresh Token、连接串或复盘正文；
- 迁移日志只记录版本、状态、耗时和安全错误码；
- 服务账号和环境文件权限符合最小权限；
- 发布包清单不含诊断、回填和会写入业务数据的 live smoke 脚本；
- 任何人工停止、重启或回滚都有操作时间、原因和负责人记录。

## 13. 失败处理和回滚

### 13.1 应用发布失败

优先切回上一个已验证的 MCP 应用包，保留数据库新增表、函数、迁移账本和审计记录；切回后重新检查 `/health`、`/ready` 和 Nginx，不自动删除数据库对象。

### 13.2 迁移失败

- 事务迁移失败：停止后续版本，保留失败账本记录，先分析错误码和数据库状态；
- 索引迁移失败：记录已成功创建的索引，确认索引状态和执行计划后再决定补做或人工清理；
- 不直接修改账本状态，不删除失败记录，不用 `--adopt-existing` 掩盖失败；
- 数据库对象回滚必须另行审批、先保存审计和账本证据，不能把应用回滚当作数据库回滚。

### 13.3 短开故障排查

```bash
sudo systemctl status ai-xing-mcp
sudo journalctl -u ai-xing-mcp --since '30 minutes ago' --no-pager
ss -ltnp | grep ':8787'
curl --fail --silent http://127.0.0.1:8787/health
```

按日志事件区分：

- `mcp_server_started`：进程已监听；
- `mcp_server_listen_failed` + `EADDRINUSE`：端口冲突；
- `mcp_server_start_failed`：配置、依赖或启动装配失败；
- `mcp_server_shutdown`：收到停止信号；
- `mcp_process_before_exit`：Node 事件循环自然结束；
- 无任何 MCP 事件但 unit 退出：优先检查 systemd、父进程、内核 OOM 和宿主机日志。

## 14. 当前恢复部署条件判断

在以下证据齐全前，结论必须保持“未满足”：

- 发布提交已从当前脏工作区冻结，且只含批准范围；
- 本地测试、构建、语法、差异和安全扫描通过；
- 代码审查没有未处理的高严重度问题，且仓储模块已完成必要拆分；
- 上述第 7.3 节阻断项已逐项有代码/配置/数据库证据关闭；
- 26 个迁移文件和迁移器审查通过，非事务索引风险有处置方案；
- 正式库只读基线、对象、权限、账本、索引和数据质量检查通过；
- 正式迁移获得单独授权并完成账本核对；
- CentOS7 systemd、Nginx、HTTPS、健康检查和三类角色冒烟通过。

本文件只定义准备和验收边界，不替代正式库授权，也不证明当前正式库已经具备部署条件。
