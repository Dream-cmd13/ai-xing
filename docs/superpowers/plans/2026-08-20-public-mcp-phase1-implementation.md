# Public MCP Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有服务器增加一个只监听内网的远程 MCP 服务，通过现有域名 `/mcp` 为 TRAE 提供账号密码认证和五个受 Supabase RLS 约束的只读工具。

**Architecture:** `mcp-server/` 是独立 Node.js 进程，使用官方 MCP TypeScript SDK v1 的 stateful Streamable HTTP transport，以兼容 TRAE 当前的远程 MCP 客户端。初始化请求用 Basic Auth 登录 Supabase，后续请求使用内存 MCP Session 中的用户 JWT；所有业务查询都使用 Publishable/Anon Key 加用户 JWT，不读取或使用 Service Role Key。

**Tech Stack:** Node.js 20+、ES Modules、`@modelcontextprotocol/sdk@1.30.0`、Express 5、Zod 4、`@supabase/supabase-js@2.105.4`、Node Test Runner、Nginx。

---

## 文件结构

- `mcp-server/package.json`：独立服务依赖和脚本。
- `mcp-server/.env.example`：无秘密的环境变量模板。
- `mcp-server/src/config.mjs`：读取和校验运行配置。
- `mcp-server/src/errors.mjs`：稳定错误码和脱敏转换。
- `mcp-server/src/basic-auth.mjs`：Basic Header 解析和用户名映射。
- `mcp-server/src/auth-provider.mjs`：Supabase 密码登录、业务用户绑定和 Token 刷新。
- `mcp-server/src/session-registry.mjs`：MCP transport、用户上下文和固定 TTL 内存会话。
- `mcp-server/src/rate-limiter.mjs`：IP/账号固定窗口限流。
- `mcp-server/src/repository.mjs`：只使用用户 JWT 的 Supabase 只读查询。
- `mcp-server/src/tools.mjs`：五个只读工具定义、参数上限和稳定结果。
- `mcp-server/src/mcp-server.mjs`：为单个认证会话注册 MCP 工具。
- `mcp-server/src/app.mjs`：`/health`、`POST/GET/DELETE /mcp` 和 HTTPS 检查。
- `mcp-server/src/index.mjs`：启动和优雅关闭。
- `mcp-server/test/*.test.mjs`：第一阶段独立自动化测试。
- `mcp-server/test/protocol.integration.test.mjs`：使用官方 MCP Client 的协议测试。
- `mcp-server/scripts/live-smoke.mjs`：使用显式测试账号执行真实 Supabase 验收，不内置账号密码。
- `.trae/mcp.json.example`：无真实密码的个人配置示例。
- `deploy/nginx/mcp-location.conf.example`：现有域名 `/mcp` 反向代理示例。
- `deploy/systemd/ai-xing-mcp.service.example`：服务器进程示例。
- `docs/mcp-phase1-deployment.md`：安装、部署和回滚说明。
- `docs/mcp-phase1-acceptance.md`：用户人工验收清单和未满足项记录。
- `package.json`：增加 MCP 启动和测试入口，不改变现有前端脚本。

## Task 1：建立独立服务和配置边界

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/.env.example`
- Create: `mcp-server/test/config.test.mjs`
- Create: `mcp-server/src/config.mjs`
- Modify: `package.json`

- [ ] **Step 1：声明固定依赖和脚本**

`mcp-server/package.json` 固定使用 SDK `1.30.0`，提供 `start`、`test`、`test:live`：

```json
{
  "name": "ai-xing-public-mcp",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.mjs",
    "test": "node --test --test-concurrency=1",
    "test:live": "node scripts/live-smoke.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@supabase/supabase-js": "2.105.4",
    "dotenv": "17.4.2",
    "express": "5.2.1",
    "zod": "4.4.3"
  }
}
```

- [ ] **Step 2：写配置失败测试**

测试必须覆盖：缺少 URL、缺少 Publishable/Anon Key、默认只绑定 `127.0.0.1`、非法端口/TTL/限流值被拒绝、兼容现有 `VITE_SUPABASE_*` 变量。

- [ ] **Step 3：运行测试并确认因 `config.mjs` 不存在而失败**

Run: `npm --prefix mcp-server test -- test/config.test.mjs`

Expected: FAIL，错误指向 `src/config.mjs` 缺失。

- [ ] **Step 4：实现最小配置模块**

配置字段固定为：

```js
{
  supabaseUrl,
  supabasePublishableKey,
  host: '127.0.0.1',
  port: 8787,
  sessionTtlMs: 28800000,
  refreshWindowMs: 60000,
  requestTimeoutMs: 15000,
  rateLimitWindowMs: 60000,
  rateLimitMax: 30,
  requireHttps: false,
  allowedHosts: ['127.0.0.1', 'localhost']
}
```

- [ ] **Step 5：运行测试并确认通过**

Run: `npm --prefix mcp-server test -- test/config.test.mjs`

Expected: PASS。

## Task 2：Basic Auth、稳定错误和限流

**Files:**
- Create: `mcp-server/test/basic-auth.test.mjs`
- Create: `mcp-server/test/rate-limiter.test.mjs`
- Create: `mcp-server/src/errors.mjs`
- Create: `mcp-server/src/basic-auth.mjs`
- Create: `mcp-server/src/rate-limiter.mjs`

- [ ] **Step 1：写 Basic Auth 失败测试**

覆盖：缺失 Header、非 Basic、非法 Base64、空账号、空密码、密码包含冒号、用户名小写化、`zhangsan → zhangsan@app.local`、任何返回对象不含密码。

- [ ] **Step 2：运行 Basic Auth 测试并确认失败**

Run: `npm --prefix mcp-server test -- test/basic-auth.test.mjs`

Expected: FAIL，缺少 `basic-auth.mjs`。

- [ ] **Step 3：实现解析与错误码**

只向客户端暴露：

```text
AUTHENTICATION_REQUIRED
AUTHENTICATION_FAILED
RATE_LIMITED
SESSION_EXPIRED
INVALID_ARGUMENT
DATA_ACCESS_FAILED
INTERNAL_ERROR
```

- [ ] **Step 4：运行 Basic Auth 测试并确认通过**

Run: `npm --prefix mcp-server test -- test/basic-auth.test.mjs`

Expected: PASS。

- [ ] **Step 5：写并验证限流失败测试**

覆盖同一个 key 在窗口内第31次被拒绝、窗口结束后恢复、不同 key 独立统计、清理过期桶。

- [ ] **Step 6：实现固定窗口限流并确认通过**

Run: `npm --prefix mcp-server test -- test/rate-limiter.test.mjs`

Expected: PASS。

## Task 3：Supabase 登录、业务用户绑定和 Token 刷新

**Files:**
- Create: `mcp-server/test/auth-provider.test.mjs`
- Create: `mcp-server/src/auth-provider.mjs`

- [ ] **Step 1：写认证提供器失败测试**

用依赖注入的假 Supabase 客户端覆盖：密码登录成功、错误密码统一脱敏、`users.auth_id` 无匹配时拒绝、返回业务 `userId/role/departmentId`、刷新成功替换 Token、刷新失败返回 `SESSION_EXPIRED`。

- [ ] **Step 2：运行测试并确认失败**

Run: `npm --prefix mcp-server test -- test/auth-provider.test.mjs`

Expected: FAIL，缺少 `auth-provider.mjs`。

- [ ] **Step 3：实现 Supabase Auth Provider**

登录必须调用：

```js
supabase.auth.signInWithPassword({ email, password })
```

业务用户必须按登录结果中的 Auth UUID 查询：

```js
supabase.from('users')
  .select('id,auth_id,username,name,role,department_id')
  .eq('auth_id', authUserId)
  .maybeSingle()
```

不得读取、引用或接受 Service Role Key。

- [ ] **Step 4：运行测试并确认通过**

Run: `npm --prefix mcp-server test -- test/auth-provider.test.mjs`

Expected: PASS。

## Task 4：内存 MCP Session 生命周期

**Files:**
- Create: `mcp-server/test/session-registry.test.mjs`
- Create: `mcp-server/src/session-registry.mjs`

- [ ] **Step 1：写会话失败测试**

覆盖：创建高熵 Session、按 ID 读取、固定 TTL 到期、刷新窗口内刷新 Token、刷新失败删除会话、DELETE 删除、transport close 自动清理、清理全部会话时调用 `close()`。

- [ ] **Step 2：运行测试并确认失败**

Run: `npm --prefix mcp-server test -- test/session-registry.test.mjs`

Expected: FAIL，缺少 `session-registry.mjs`。

- [ ] **Step 3：实现会话注册表**

会话只保存：transport/server、业务用户 ID、角色、部门、Access Token、Refresh Token、Token 过期时间和 MCP Session 过期时间，不保存账号密码或 Basic Header。

- [ ] **Step 4：运行测试并确认通过**

Run: `npm --prefix mcp-server test -- test/session-registry.test.mjs`

Expected: PASS。

## Task 5：只读 Supabase Repository

**Files:**
- Create: `mcp-server/test/repository.test.mjs`
- Create: `mcp-server/src/repository.mjs`

- [ ] **Step 1：写 Repository 失败测试**

覆盖：所有客户端都携带当前用户 JWT；组织信息只返回允许字段；周 PAD 按 `department_id` 和 `target_weeks` 过滤；搜索参数安全传给 Supabase Query Builder；个人工作台身份固定为会话用户；流程最多20条；所有 limit 最大50；Supabase 原始错误被转换为 `DATA_ACCESS_FAILED`。

- [ ] **Step 2：运行测试并确认失败**

Run: `npm --prefix mcp-server test -- test/repository.test.mjs`

Expected: FAIL，缺少 `repository.mjs`。

- [ ] **Step 3：实现五组只读查询**

Repository 对外接口固定为：

```js
getOrganizationInfo()
getDepartmentWeeklyPad({ departmentId, weekId, limit })
searchPadTasks({ query, departmentId, status, limit, offset })
getPersonalWorkbench({ userId, limit })
getProcessSipoc({ processId, departmentId, limit })
```

不得暴露 insert、update、delete、upsert 或 Service Role 客户端。

- [ ] **Step 4：运行测试并确认通过**

Run: `npm --prefix mcp-server test -- test/repository.test.mjs`

Expected: PASS。

## Task 6：注册五个只读 MCP 工具

**Files:**
- Create: `mcp-server/test/tools.test.mjs`
- Create: `mcp-server/src/tools.mjs`
- Create: `mcp-server/src/mcp-server.mjs`

- [ ] **Step 1：写工具失败测试**

覆盖五个准确名称、输入 Schema、输出 Structured Content、`readOnlyHint: true`、最大分页限制、个人工作台忽略外部 `userId`、错误响应不包含内部堆栈或 Supabase 信息。

- [ ] **Step 2：运行测试并确认失败**

Run: `npm --prefix mcp-server test -- test/tools.test.mjs`

Expected: FAIL，工具模块不存在。

- [ ] **Step 3：实现工具注册**

注册名称固定为：

```text
get_organization_info
get_department_weekly_pad
search_pad_tasks
get_personal_workbench
get_process_sipoc
```

每个成功结果同时返回简体中文 Text Content 和 Structured Content；失败只返回稳定错误码。

- [ ] **Step 4：运行测试并确认通过**

Run: `npm --prefix mcp-server test -- test/tools.test.mjs`

Expected: PASS。

## Task 7：Streamable HTTP 应用和协议集成测试

**Files:**
- Create: `mcp-server/test/app.test.mjs`
- Create: `mcp-server/test/protocol.integration.test.mjs`
- Create: `mcp-server/src/app.mjs`
- Create: `mcp-server/src/index.mjs`

- [ ] **Step 1：写 HTTP 失败测试**

覆盖 `/health`、初始化缺少 Basic 返回401、错误密码返回401、无效 MCP Session 返回400、HTTP 代理头在 `requireHttps=true` 时返回426、GET/DELETE 使用正确 transport、响应和日志不含秘密。

- [ ] **Step 2：运行测试并确认失败**

Run: `npm --prefix mcp-server test -- test/app.test.mjs`

Expected: FAIL，缺少 `app.mjs`。

- [ ] **Step 3：实现 Express 路由**

只绑定配置中的内网 host，初始化时执行 Basic Auth；通过 `Mcp-Session-Id` 路由现有 transport；GET 建立 SSE；DELETE 终止会话；错误响应禁止包含原始异常。

- [ ] **Step 4：运行 HTTP 测试并确认通过**

Run: `npm --prefix mcp-server test -- test/app.test.mjs`

Expected: PASS。

- [ ] **Step 5：写官方 Client 协议测试并确认先失败**

使用 `Client` 和 `StreamableHTTPClientTransport` 连接临时端口，验证初始化、`listTools()` 返回5个工具、`callTool()` 能调用 `get_personal_workbench`、关闭 Session 后不能继续调用。

- [ ] **Step 6：补齐协议实现并确认集成测试通过**

Run: `npm --prefix mcp-server test -- test/protocol.integration.test.mjs`

Expected: PASS。

## Task 8：部署、TRAE 配置和真实环境验收脚本

**Files:**
- Create: `mcp-server/scripts/live-smoke.mjs`
- Create: `.trae/mcp.json.example`
- Create: `deploy/nginx/mcp-location.conf.example`
- Create: `deploy/systemd/ai-xing-mcp.service.example`
- Create: `docs/mcp-phase1-deployment.md`
- Create: `docs/mcp-phase1-acceptance.md`

- [ ] **Step 1：增加无密码的 TRAE 示例**

示例只包含占位内容：

```json
{
  "mcpServers": {
    "ai_xing_okr": {
      "url": "https://your-existing-domain.example/mcp",
      "headers": {
        "Authorization": "Basic <仅填写在个人配置中，禁止提交真实值>"
      }
    }
  }
}
```

- [ ] **Step 2：增加 Nginx 和 systemd 示例**

Nginx 必须保留 `Mcp-Session-Id`、关闭响应缓冲、传递 `X-Forwarded-Proto`，并把 `/mcp` 转发到 `127.0.0.1:8787`。

- [ ] **Step 3：增加显式凭据的 live smoke test**

脚本只读取 `MCP_TEST_USERNAME`、`MCP_TEST_PASSWORD` 和 `MCP_TEST_URL`；缺失时明确退出，不内置默认账号或密码。测试初始化、工具列表、个人工作台和会话关闭。

- [ ] **Step 4：编写部署、回滚和人工验收文档**

文档列出 Admin/Manager/Employee 权限矩阵，并把无法在本地伪造证明的真实 TRAE、真实域名、真实 RLS 测试标记为“等待用户验收”，不得伪报通过。

## Task 9：全量验证与阶段交付

**Files:**
- Modify: `docs/mcp-phase1-acceptance.md`

- [ ] **Step 1：运行 MCP 全量测试**

Run: `npm --prefix mcp-server test`

Expected: 全部 PASS，且无 warning/error 输出。

- [ ] **Step 2：运行现有前端回归**

Run: `npm run build`

Expected: Vite build 成功。

Run: `npm run lint`

Expected: TypeScript noEmit 成功。

- [ ] **Step 3：检查只读和秘密边界**

搜索 MCP 生产代码，确认没有 `service_role`、`SUPABASE_SECRET_KEY`、`.insert(`、`.update(`、`.delete(`、`.upsert(`；检查响应和测试快照没有密码、Basic Header、JWT 或 Refresh Token。

- [ ] **Step 4：记录可证明结果和外部验收项**

把测试命令、结果、版本、已知限制、部署步骤、回滚步骤和等待用户在真实服务器执行的项目写入验收文档。

- [ ] **Step 5：停止在第一阶段验收闸门**

交付验收材料后停止开发，不创建第二阶段写入工具。只有用户明确回复“第一阶段验收通过，同意开始第二阶段”才能继续。
