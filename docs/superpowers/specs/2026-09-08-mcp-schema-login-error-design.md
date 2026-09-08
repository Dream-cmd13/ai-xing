# MCP 输出契约与登录错误提示修复设计

## 1. 目标

本次只处理两个已批准问题：

1. 保留 MCP 当前 `structuredContent` 的全部字段、名称和业务含义，补齐并统一 `tools/list` 发布的输出 Schema，使标准 MCP SDK 能稳定消费真实返回。
2. 将登录失败反馈从短暂 Toast 升级为登录表单内持久、脱敏、可访问的错误状态，确保管理员输入错误凭据后得到明确反馈。

本次不清理、回填或修改任何 OKR 数据，不调整角色权限、数据可见范围、限流策略或其他测试观察项。

## 2. 已确认根因

### 2.1 MCP 输出契约漂移

`mcp-server/src/tools.mjs` 在工具注册时声明顶层 `outputSchema`，MCP SDK 会把该 Schema 发布到 `tools/list`，并对成功响应中的 `structuredContent` 执行严格校验。

真实仓储存在以下已确认差异：

- `get_department_okrs` 的 `mapDepartmentOkrResult()` 始终返回 `limit`，现有 Schema 未声明该字段。
- `search_pad_tasks` 的部门范围分支返回 `departmentId`、`departmentName`、`scope`，现有 Schema 未声明这些字段。
- `search_pad_tasks` 的姓名范围分支返回 `user`，现有 Schema 未声明该字段。

现有协议集成测试使用简化假仓储。部门 OKR 假响应没有 `limit`，并且没有通过官方 SDK 调用任务搜索的全部真实分支，因此 316 项 MCP 测试通过仍未覆盖生产契约。

### 2.2 登录错误只依赖短暂 Toast

`components/LoginView.tsx` 已经调用 `getUserFacingError()` 并尝试显示 `PageToast`，但错误状态只存在约三秒，没有与表单字段关联，也没有自动化测试验证 Supabase Auth 返回 HTTP 400 后的可见结果。测试中因此出现“请求已被拒绝、页面无可理解提示”的实际结果。

## 3. 方案选择

采用方案 B：契约集中化、真实分支协议测试、持久表单错误。

不采用只修改两个内联字段的快速补丁，因为它无法防止下一次仓储返回扩展时再次漂移；不新增 V2 工具或响应 Envelope，因为本次要求保持现有客户端字段兼容。

## 4. MCP 契约设计

### 4.1 单一契约来源

新增 `mcp-server/src/read-tool-output-schemas.mjs`，集中导出九个只读工具的输出 Schema。`tools.mjs` 只引用这些 Schema，不再在注册代码中重复维护顶层输出结构。

顶层对象保持严格：未登记字段仍应触发测试失败。嵌套业务记录暂时继续使用允许动态业务字段的 record Schema，避免借本次修复改变既有业务数据结构。

### 4.2 兼容规则

- 不删除、不重命名、不转换现有返回字段。
- 现有所有调用分支共同返回的字段维持必填。
- 仅部分分支返回的上下文字段声明为可选。
- 已允许 `null` 的字段不收紧为非空。
- 错误结果继续使用 `content + isError`，不伪造成功 `structuredContent`。

### 4.3 受影响契约

`get_department_okrs`：在现有字段基础上增加必填 `limit`，范围为 1 至 50。

`search_pad_tasks`：保留 `tasks`、`offset`、`limit`、`total`、`hasMore`、`nextCursor`、`truncated`，并增加可选的 `departmentId`、`departmentName`、`scope`、`user`。`user` 显式声明姓名、角色、部门 ID 和部门名称字段，字段空值规则与当前映射一致。

其余七个只读工具迁入集中契约时保持现有公开 Schema 不变。六个写工具只做协议回归，不调整写入行为。

## 5. 登录错误设计

### 5.1 状态与交互

登录页新增 `loginError` 状态和表单级错误区域：

- 每次提交前清除旧错误。
- Auth 失败或请求异常时设置脱敏后的错误文案。
- 错误持续显示，直到用户修改账号、修改密码或重新提交。
- 登录成功继续使用成功 Toast；失败不再只依赖 Toast。
- 密码错误后把焦点放回密码输入框，便于立即修正。

### 5.2 安全与可访问性

- 错误区域使用 `role="alert"` 和 `aria-live="assertive"`。
- 输入框通过 `aria-invalid`、`aria-describedby` 与错误区域关联。
- 对错误账号和错误密码统一显示“账号或密码错误，请重新输入”，不泄漏账号是否存在。
- 优先识别 Auth 错误码和 HTTP 状态；仅把已批准的中文文案交给用户，不展示原始英文异常。
- 页面、控制台和测试证据不得记录密码、Authorization、Token 或 Session。

### 5.3 错误分类

- 无效凭据、账号未确认、HTTP 400：账号或密码错误。
- HTTP 429 或 rate-limit 错误：登录尝试过于频繁。
- 网络错误：网络异常。
- 其他错误：通用登录失败，不显示内部详情。

## 6. 测试策略

### 6.1 MCP 自动化

在 `mcp-server/test/protocol.integration.test.mjs` 中让假仓储返回与真实仓储一致的字段，并通过官方 MCP Client 执行：

1. `listTools()`；
2. 部门 OKR 调用，包含 `limit`；
3. 任务搜索基础分支；
4. 任务搜索部门分支；
5. 任务搜索人员分支。

测试必须在修复前因 `-32602` 失败，修复后成功，并断言 `structuredContent` 字段没有被删除。

在 `mcp-server/test/tools.test.mjs` 增加集中 Schema 注册和公开字段断言，防止工具注册遗漏。

### 6.2 登录自动化

扩充 `local-test-files/e2e-tests/tests/login.spec.ts`：通过浏览器请求拦截模拟 Auth 400，不使用真实账号密码，断言错误区域出现、文案脱敏、输入变化后清除。保留一次测试环境人工管理员复测作为发布验收，凭据只从交互或安全环境变量输入。

### 6.3 回归命令

- `npm --prefix mcp-server test`
- `npm run lint`
- `npm run build`
- `npx playwright test tests/login.spec.ts`（在 `local-test-files/e2e-tests` 中）

## 7. 发布与回滚

本次没有数据库迁移和数据写入。MCP 与网页作为两个独立发布单元：

1. 测试环境发布 MCP，使用三个角色完成 `tools/list → callTool` 回归。
2. 测试环境发布网页，完成错误登录、正确登录和受保护路由回归。
3. 全部发布门禁通过后进入正式环境。
4. 若出现兼容问题，分别回滚 MCP 服务制品或网页静态制品；无需数据库回滚。

## 8. 验收标准

- 三个角色通过标准 MCP SDK 调用部门 OKR 和任务搜索时不再出现 `-32602`。
- 修复前后真实 `structuredContent` 字段和值保持兼容。
- 全部 15 个 MCP 工具通过协议回归，现有 316 项测试及新增测试全部通过。
- 管理员错误登录后一秒内出现持久、可理解、脱敏的表单错误。
- 修改账号或密码后旧错误清除，重新提交可再次显示新结果。
- TypeScript 检查和生产构建通过。
- 不产生任何 OKR 数据变更。
