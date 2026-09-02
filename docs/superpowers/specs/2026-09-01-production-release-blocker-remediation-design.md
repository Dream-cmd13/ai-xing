# 正式服上线阻断项完整修复设计

## 1. 目标

本设计处理提交 `bbba13e` 上已经确认的上线阻断项，使代码、SQL 迁移、MCP 运行时、前端状态、依赖供应链和 CentOS 7 部署资产达到可进入正式环境只读预检的状态。

完成本地实现不等于正式服已经可发布。正式库身份确认、备份恢复、正式迁移、历史数据修复、正式服务器安装和发布标签仍需要独立授权与现场证据。

## 2. 约束与范围

- 正式数据库基线保持为 `aab58c6`。
- 已进入迁移账本的 SQL 文件不得修改；数据库修复全部使用新的前向迁移。
- 不连接正式环境，不执行正式库迁移，不写正式库。
- 不启动、停止或重启 MCP、Nginx、systemd 或其他服务。
- 不自动修复测试库中已发现的 45 条 `REVIEW_PERIOD_KEY_INVALID`。
- 不引入第三、第四阶段功能，不增加 Redis、多实例 Session 或新的业务模块。
- 最新指令“修复所有问题”覆盖本次检查中报告的 18 个 TypeScript 错误，但只修已报告位置，不扩展到无关前端重构。
- 临时诊断和集成测试辅助文件只能放在 `local-test-files/`。

## 3. 总体方案

修复分为五个可以独立验证的工作流：

1. 前端供应链、密钥边界和任务状态一致性；
2. 数据库 RPC 校验、迁移原子性和发布 readiness 契约；
3. MCP 运行时失败关闭、网络边界和仓储拆分；
4. CentOS 7 常驻服务、发布包和部署文档；
5. TypeScript、自动化测试和发布门禁。

所有兼容性判断遵循同一原则：可能扩大权限或缩小部门查询范围时必须失败关闭，不允许静默回退到语义不等价的旧接口。

## 4. 前端设计

### 4.1 依赖和密钥边界

前端删除未使用的 `@google/genai`、`lodash` 和 `@types/lodash`，删除 import map 中对应条目。`react-router-dom` 与传递依赖 `react-router` 升级到官方安全审计通过的兼容版本，并锁定到 `package-lock.json`。

Vite 不再定义 `process.env.API_KEY` 或 `process.env.GEMINI_API_KEY`。模型密钥只能由 Flask 服务端环境读取。新增构建产物扫描脚本，检查已知密钥变量名、JWT、Authorization 和私钥头等禁止模式；脚本只报告文件和规则名称，不输出命中的敏感内容。

### 4.2 作用域任务状态

`ExecutionView` 和 `ReviewView` 加载部门/周期任务后，不再替换全局 `tasks` 与 `lastSavedTasks`。新增或复用 `utils/taskSyncState.js` 中的按 ID 合并方法：

- 远端作用域结果按任务 ID 合并到规范任务集合；
- 当前页面单独保存本次查询返回的任务 ID；
- 基线集合只更新本次加载到的任务，不删除其他页面缓存；
- 保存失败只回滚被修改的任务，不覆盖其他作用域任务。

页面展示使用作用域 ID 过滤规范集合，切换部门、周期或路由时不会丢失其他任务。

### 4.3 人员补全

网页端与 MCP 共用每批最多 50 个任务 ID 的契约。前端保持受控并发，但每个 RPC 参数数组不得超过 50。测试覆盖 0、50、51 和 150 个任务。

### 4.4 TypeScript 基线

只修复当前 `npm run lint:app` 报告的 `ProcessView.tsx`、`StrategyView.tsx` 和 `WeeklyView.tsx` 错误。修复以类型收窄、正确接口和既有组件契约为主，不改变页面业务行为或视觉结构。完成标准为 `npm run lint:app` 零错误。

## 5. 数据库与迁移设计

### 5.1 统一任务变更校验

新增前向迁移，定义一个规范 SQL 校验辅助函数，供普通任务更新、作用域更新和作用域复盘同步 RPC 共用。校验至少包含：

- 标题非空和长度；
- 状态枚举及提交状态限制；
- 优先级枚举；
- 周次格式、数量和重复项；
- 日期格式及起止顺序；
- 标签类型、数量和单项长度；
- 参与人、审批人类型和数量；
- 计划、行动、交付物等文本长度；
- KR 下标 0 到 100 及现有 KR 槽位规则。

三个入口对同一输入必须得到相同接受或拒绝结果。认证用户直接调用 RPC 也不能绕过约束。

### 5.2 `SECURITY DEFINER` 权限

新增前向迁移重新创建 `get_current_user_task_users_for_tasks(text[])`：

- 固定 `SET search_path = public`；
- 从 `PUBLIC`、`anon`、`authenticated` 和 `service_role` 收回默认执行权限；
- 只向 `authenticated` 授予执行权限；
- 保留现有可见性过滤和返回结构。

SQL 契约测试检查函数定义，正式库预检使用 `has_function_privilege` 验证实际授权。

### 5.3 完整发布 readiness

新增 readiness 前向迁移，不修改现有版本。迁移执行器在所有必需事务型迁移成功后记录：

- release ID；
- 有序迁移版本集合；
- manifest SHA-256 digest；
- 必需 RPC 签名和权限契约版本。

readiness 必须验证完整必需版本集合、成功状态、顺序、预期 digest、关键函数签名和 `authenticated` 权限。deferred 并发索引状态单独返回，不伪装成事务迁移完成状态。

### 5.4 事务外壳

迁移器使用注释和字符串感知的顶层事务外壳解析器。事务型 SQL 必须恰好存在一个合法外层 `BEGIN/COMMIT`，发送给 PostgreSQL 前移除这两个语句；缺失、重复、错序或外层之外存在可执行文本时中止。

单元测试断言发送 SQL 不含外壳。可用本地临时 PostgreSQL 时运行回滚集成测试：在迁移中途故意失败，确认业务对象和成功账本记录都不存在。测试不得连接测试库或正式库。

## 6. MCP 运行时设计

### 6.1 统一 readiness 门禁

创建共享 readiness gate，包含短 TTL 缓存、并发请求合并和稳定错误映射。POST、GET、DELETE `/mcp` 在认证或 Session 处理前调用门禁：

- degraded 或超时返回 503 和稳定的 `SERVICE_NOT_READY`；
- 新 initialize 与已有 Session 请求采用相同规则；
- readiness 恢复后，TTL 到期或显式失效即可恢复请求；
- `/health` 仍只表示进程存活，`/ready` 返回相同门禁状态。

### 6.2 旧 RPC 兼容策略

部门子树、自动作用域、OKR 和复盘缺口查询缺少新版 RPC 时返回稳定的 `RPC_NOT_CONFIGURED`，不得回退为精确部门过滤或旧版不同语义结果。只有经过测试证明完全等价的 `scope=exact` 查询可以临时使用旧 RPC。

### 6.3 网络和代理信任

生产配置强制 `MCP_HOST` 为 loopback。非生产环境如需非 loopback，必须使用显式的危险覆盖开关，且生产模式拒绝该开关。

HTTPS 判断只信任来自配置中可信 loopback 代理的 `X-Forwarded-Proto`；公网客户端直接伪造该请求头不能绕过 HTTPS 要求。MCP 保持仅由 Nginx 反向代理暴露。

### 6.4 仓储拆分

将当前大型 `repository.mjs` 拆分为以下聚焦模块，并保留薄组合工厂以维持调用方 API：

- `repositories/organization-repository.mjs`；
- `repositories/task-read-repository.mjs`；
- `repositories/task-people-repository.mjs`；
- `repositories/okr-repository.mjs`；
- `repositories/review-gap-repository.mjs`；
- `repositories/process-repository.mjs`；
- `repositories/internal/repository-helpers.mjs`。

拆分先用现有测试锁定行为，再做机械迁移；不在拆分过程中改变权限或输出契约。失败关闭和批次 50 的行为在对应领域模块中单独测试。

## 7. 部署与发布设计

### 7.1 CentOS 7 常驻服务

systemd 模板使用 `Restart=always`，配置兼容 CentOS 7 的启动限速、合理重启间隔、开机启用说明、资源限制和日志策略。人工 `systemctl stop` 仍然有效，企业目标定义为“自动恢复并告警”，不承诺不可停止。

Node 要求保持 20 或以上。CentOS 7 的 glibc 兼容性通过两种支持路径说明：优先升级到受支持的 Rocky/Alma/RHEL；CentOS 7 强制场景使用固定镜像容器或经验证的兼容 Node 构建。真正部署前必须在目标主机完成架构、glibc、Node、npm、TLS 和 systemd 演练。

### 7.2 可重复发布包

新增 allowlist 驱动的发布脚本，只收集运行必需文件，明确排除：

- 根目录和 MCP 目录下的 `.env`；
- 诊断、回填和现场冒烟脚本；
- `local-test-files/`、日志、测试输出和缓存；
- 未列入清单的 SQL 或文档。

脚本生成文件清单和 SHA-256 摘要，并在打包完成后扫描禁止路径和敏感模式。测试使用临时目录，不产生或提交真实发布包。

### 7.3 部署文档

独立正式服准备文档更新到实际候选提交，记录每个门禁的命令、期望结果、回滚步骤和证据位置。发布标签和最终制品摘要只能在所有代码门禁、正式库预检和服务器验收通过后生成。

## 8. 错误处理与可观测性

新增稳定公开错误码：

- `SERVICE_NOT_READY`：readiness 未满足；
- `RPC_NOT_CONFIGURED`：必需数据库接口缺失；
- `MCP_VALIDATION`：数据库任务数据校验失败；
- `MIGRATION_ENVELOPE_INVALID`：迁移事务外壳非法；
- `RELEASE_CONTRACT_MISMATCH`：发布 manifest 与数据库状态不一致。

日志只能记录错误码、请求 ID、RPC/工具名、耗时和布尔状态，不能记录密码、Authorization、JWT、Refresh Token、数据库连接串或完整业务载荷。

## 9. 测试和验收

本地必须通过：

- 前端生产依赖官方 `npm audit --omit=dev` 为零；
- MCP 生产依赖官方审计为零；
- `npm run lint:app`；
- `npm run build`；
- `npm run mcp:test`；
- 所有 MCP `.mjs` 文件 `node --check`；
- `git diff --check`；
- 构建产物和发布包敏感信息扫描；
- 迁移文件与 manifest 一一对应；
- 临时 PostgreSQL 事务回滚测试在运行环境可用时通过。

关键行为测试覆盖 readiness 降级/超时/恢复、已有 Session、旧 RPC 缺失、三个任务更新入口校验一致性、任务状态跨页面保存、人员批次边界、代理头伪造和非 loopback 生产配置。

## 10. 仍需现场授权的上线门禁

代码完成后以下事项仍然阻断正式发布，不能由本地实现自动关闭：

1. 正式数据库身份、版本、时区、基线结构、RLS 和触发器只读核验；
2. 迁移账本顺序、状态、校验和和函数权限核验；
3. 45 条历史异常复盘数据的逐条修复或书面接受；
4. 正式库备份与恢复演练；
5. 正式迁移授权、执行和迁移后验证；
6. CentOS 7 真实主机的运行时、systemd、Nginx、HTTPS 和防火墙验收；
7. 管理员、部门负责人、普通成员和跨顶级部门账号的读写隔离验收；
8. 所有门禁通过后的发布标签和制品摘要冻结。

