# Flask 替代 Edge Functions 安全网关与接口规划

## Summary

- 目标：在当前 `Vite + React + Supabase` 项目中新增独立 `flask/` 服务，替代现有 Supabase Edge Functions，用于安全代理大模型调用、隔离 `SUPABASE_SERVICE_ROLE_KEY`、并安全完成管理员创建用户/重置密码。
- 部署前提：按 `ECS/容器` 形态设计。
- 鉴权前提：前端继续复用 Supabase 登录态，调用 Flask 时透传当前用户 JWT。
- 模型范围：后端同时兼容 `Gemini` 与 `DeepSeek`，以服务端环境变量控制默认 provider，并允许请求级显式指定 provider。
- 迁移约束：本轮方案必须保持与未来 Supabase Edge Functions 兼容，后续若阿里云/部署条件变化，应能以最小改动从 Flask 切换回 Edge Functions。
- 产出方向：本轮实施会新增 Flask 服务目录、RESTful 接口、前端调用适配、环境变量示例与配套说明文档。

## Current State Analysis

### 现有前端与认证形态

- 当前仓库是纯前端应用，未包含独立后端服务；`package.json` 仅包含前端开发/构建脚本。
- Supabase 客户端初始化位于 `supabase.ts`，前端仅使用 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_ANON_KEY`。
- 登录流程位于 `components/LoginView.tsx` 与 `App.tsx`：前端通过 `supabase.auth.signInWithPassword` 获取 JWT，并在启动时恢复 session。

### 现有 Edge Function 调用点

- AI 能力由 `services/gemini.ts` 调用 `supabase.functions.invoke('ai-chat')`。
- 用户创建/重置密码由 `components/UserView.tsx` 调用 `supabase.functions.invoke('admin-user-manager')`。
- 仓库仅实际存在 `supabase/functions/ai-chat/index.ts`；`admin-user-manager` 只有设计文档 `docs/admin-user-manager-edge-function-spec.md`，没有源码。

### 现有安全边界

- `supabase/functions/ai-chat/index.ts` 通过 Bearer JWT 调 `supabase.auth.getUser()` 验证登录态，然后读取服务端密钥 `geminikey` 调用 Gemini。
- `sql/00_one_click_schema.sql` 已提供 `public.is_admin()`，当前管理员判断同时支持 `users.role='Admin'` 与 `system_roles` 中 admin 角色。
- `docs/admin-user-manager-edge-function-spec.md` 已明确管理员接口必须双重校验：用户已登录 + 业务身份为管理员。

### 当前缺口

- 阿里云当前场景下不再适合依赖 Supabase Edge Functions。
- 前端没有通用 REST API 调用层，仍直接耦合 `supabase.functions.invoke`。
- 还没有统一的服务端目录、容器入口、Python 依赖清单、请求鉴权中间件与多模型 provider 抽象。

## Proposed Changes

### 1. 新增独立 Flask 服务目录

计划新增目录 `flask/`，采用按职责拆分的结构：

- `flask/app.py`
  - 创建 Flask 应用、注册蓝图、统一异常处理、CORS 与健康检查入口。
- `flask/config.py`
  - 读取并校验环境变量。
  - 区分前端可见配置与后端私密配置。
- `flask/requirements.txt`
  - 锁定 Flask、Supabase Python SDK、HTTP 客户端、JWT 校验等依赖。
- `flask/routes/ai.py`
  - 提供 AI 代理 REST 接口。
- `flask/routes/admin_users.py`
  - 提供管理员用户管理 REST 接口。
- `flask/services/supabase_clients.py`
  - 封装两类 Supabase Client：
    - 用户态 client：`anon key + Bearer JWT`
    - 管理态 client：`service role key`
- `flask/services/auth_guard.py`
  - 解析 Bearer JWT。
  - 使用“用户态 client”调用 `auth.get_user()` 验证 token 有效性。
  - 对管理员接口再调用 `rpc('is_admin')` 做业务管理员校验。
- `flask/services/llm_service.py`
  - 统一 provider 入口，根据 `provider` 字段分发到 Gemini 或 DeepSeek。
- `flask/services/providers/gemini_provider.py`
  - 服务端持有 `GEMINI_API_KEY`，调用 Gemini REST。
- `flask/services/providers/deepseek_provider.py`
  - 服务端持有 `DEEPSEEK_API_KEY`，按 OpenAI-compatible Chat Completions 接口调用 DeepSeek。
- `flask/services/admin_user_service.py`
  - 负责创建 Auth 用户、写入 `public.users`、失败补偿删除 Auth 用户、重置密码等事务语义。
- `flask/.env.example`
  - 提供后端运行所需变量模板。
- `flask/README.md`
  - 说明本地启动、环境变量、接口契约与部署方式。

### 2. 定义 RESTful 接口契约

#### 2.1 AI 代理接口

- `POST /api/ai/chat`
- 调用方：任意已登录用户。
- 请求头：
  - `Authorization: Bearer <supabase_access_token>`
- 请求体：
  - `prompt: string`
  - `provider?: "gemini" | "deepseek"`
  - `model?: string`
- 响应体：
  - `reply: string`
  - `provider: string`
  - `model: string`
- 设计决策：
  - 默认 provider 由服务端环境变量 `LLM_PROVIDER_DEFAULT` 控制。
  - 前端允许不传 `provider`，由后端兜底。
  - 不把任何模型 API key 暴露给前端。

#### 2.2 管理员创建用户接口

- `POST /api/admin/users`
- 调用方：仅管理员。
- 请求头：
  - `Authorization: Bearer <supabase_access_token>`
- 请求体：
  - `username: string`
  - `name: string`
  - `role: string`
  - `departmentId?: string`
- 响应体：
  - `success: true`
  - `data.userId`
  - `data.authId`
  - `data.email`
  - `data.temporaryPassword`
- 事务语义：
  - 先校验调用者管理员身份。
  - 再校验用户名唯一、角色合法、部门存在性。
  - 调 `auth.admin.createUser` 创建 Auth 账号。
  - 再写 `public.users`。
  - 若业务表写入失败，立即执行 `auth.admin.deleteUser` 补偿回滚。

#### 2.3 管理员重置密码接口

- `POST /api/admin/users/reset-password`
- 调用方：仅管理员。
- 请求体：
  - `authId: string`
- 响应体：
  - `success: true`
  - `data.authId`
  - `data.temporaryPassword`
- 设计决策：
  - 默认重置为固定临时密码（与现有文档一致），后续可再扩展首次登录强制改密。

#### 2.4 健康检查接口

- `GET /health`
- 用途：容器探针、部署联调与 API 网关回源检查。

### 3. 前端调用改造

实施时改造以下现有文件：

- `services/gemini.ts`
  - 从 `supabase.functions.invoke('ai-chat')` 改为 `fetch('${VITE_FLASK_API_BASE_URL}/api/ai/chat')`。
  - 发起请求前读取当前 Supabase session access token，并放入 `Authorization` 头。
- `components/UserView.tsx`
  - 将创建用户与重置密码从 `supabase.functions.invoke('admin-user-manager')` 改为调用 Flask 管理员 REST 接口。
  - 保持当前前端交互文案与本地状态更新逻辑基本不变，避免 UI 额外波动。
- 可新增 `services/apiClient.ts`
  - 统一封装 `fetch + Supabase access token + 错误处理`，避免在多个文件重复拼接请求逻辑。
- `.env.example`
  - 保留现有 Supabase 前端变量。
  - 增加前端 API 基址变量，例如 `VITE_FLASK_API_BASE_URL`。

### 4. 密钥与权限边界设计

#### 前端可持有

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` 或 `VITE_SUPABASE_ANON_KEY`
- `VITE_FLASK_API_BASE_URL`

#### 仅 Flask 服务端持有

- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `DEEPSEEK_API_KEY`
- 其他后端私密配置

#### 核心安全策略

- 前端永不直接接触 `SUPABASE_SERVICE_ROLE_KEY`。
- 前端永不直接调用第三方大模型 API。
- Flask 普通 AI 接口只验证“已登录”。
- Flask 管理员接口验证“已登录 + `is_admin()` 返回 true”。
- 管理态 Supabase Client 只在管理员接口内部使用，且不向下游前端返回任何密钥。

### 5. 创建用户的一致性与安全实现

- 沿用 `docs/admin-user-manager-edge-function-spec.md` 既有语义，避免改动业务预期。
- 使用用户名推导 email：`${username}@app.local`，与当前登录页约定保持一致。
- 创建成功后只回传业务所需字段，不暴露多余 Supabase Auth 元数据。
- 对重复用户名返回明确业务错误码，如 `USER_ALREADY_EXISTS`。
- 对角色/部门/入参缺失返回 400。
- 对非管理员返回 403。
- 对上游模型或 Supabase 管理接口失败返回结构化 4xx/5xx 错误，便于前端统一提示。

### 6. 面向未来 Edge Function 回切的兼容设计

#### 6.1 前端保持“后端能力抽象”而非绑定 Flask

- 前端不直接把 Flask 视为唯一后端实现，而是通过统一的 `services/apiClient.ts` 或 `services/backendGateway.ts` 调用抽象后的业务接口。
- 前端业务代码只感知下列逻辑能力，不感知其底层由 Flask 还是 Edge Function 提供：
  - `chatWithAI(payload)`
  - `createAdminUser(payload)`
  - `resetAdminUserPassword(payload)`
- `services/gemini.ts` 与 `components/UserView.tsx` 均只依赖抽象层，避免再次把实现细节散落回页面组件。

#### 6.2 接口契约优先对齐 Edge Function 风格

- REST 路径保持简洁、无 Flask 私有语义，确保未来可一比一映射到：
  - Flask: `POST /api/ai/chat`
  - Edge Function: `POST /functions/v1/ai-chat`
- 请求头统一采用 `Authorization: Bearer <token>`。
- 请求体与响应体保持纯 JSON，字段名与错误结构不绑定 Flask 异常页、Werkzeug 错误格式或特定 Python 序列化习惯。
- 错误响应建议统一为：
  - `success: false`
  - `error.code`
  - `error.message`
  - `error.details?`
- 成功响应建议统一为：
  - `success: true`
  - `data`

#### 6.3 业务逻辑与运行时入口解耦

- Flask 目录内部按“控制器层/服务层/provider 层”拆分。
- 与运行时强相关的代码仅放在最外层路由入口中。
- 未来迁移到 Edge Function 时，仅需把以下能力迁入 Deno/TypeScript 入口层，业务语义保持不变：
  - JWT 解析与认证校验
  - `is_admin()` 调用
  - AI provider 分发
  - 用户创建补偿事务
- 文档中同步给出“接口契约”和“业务规则”，而不是只写 Flask 实现步骤，保证后续可按同一契约重写运行时外壳。

#### 6.4 配置命名采用中性语义

- 前端环境变量优先使用中性名称，例如 `VITE_BACKEND_API_BASE_URL`，避免未来从 Flask 切换到 Edge Function 时还要批量重命名配置。
- 若考虑平滑过渡，可在实施阶段兼容：
  - `VITE_BACKEND_API_BASE_URL`
  - `VITE_FLASK_API_BASE_URL`
- 解析顺序以中性变量优先，Flask 变量仅作为过渡兼容别名。

#### 6.5 迁移回 Edge Function 的预留策略

- 保持单接口单职责，不在 Flask 中引入会话、任务队列、文件系统落盘等 Edge Function 难以迁移的运行时依赖。
- 避免把核心逻辑绑定到 Flask 专属中间件、全局上下文对象或复杂装饰器体系。
- 所有第三方 API 调用均通过 provider 层封装，未来迁移时只需迁移 provider 调用适配。
- 管理员接口仍沿用当前 `admin-user-manager` 文档语义，便于后续直接恢复为同名 Edge Function 或相同业务动作。

## Assumptions & Decisions

- 当前阶段不依赖 Supabase Edge Functions 落地生产能力，但接口与业务抽象必须保持未来可切回 Edge Functions。
- Flask 服务与前端属于同一项目仓库，但部署为独立进程/容器。
- AI 接口第一阶段仅覆盖当前已存在的“单轮文本问答”能力，不扩展会话历史、流式输出和文件上传。
- 管理员接口第一阶段覆盖当前前端已实际使用的两项能力：创建用户、重置密码。
- 删除用户接口暂不纳入本轮，原因是当前前端 `performDeleteUser` 仍是本地状态删除，不存在既有后端契约，需后续单独补齐产品语义与数据库一致性方案。
- 管理员校验优先复用数据库内既有 `public.is_admin()` 语义，避免在 Flask 内重复发明另一套角色判断规则。

## Verification Steps

### 文档与结构验证

- 确认 `flask/` 目录具备可运行入口、依赖文件、README 与环境变量示例。
- 确认前端 `.env.example` 与 Flask `.env.example` 的公私变量边界清晰。
- 确认前端存在统一后端调用抽象，不直接把页面逻辑绑定到 Flask URL 细节。
- 确认接口文档中的请求/响应结构可一比一映射到未来 Edge Function。

### 鉴权与权限验证

- 已登录普通用户调用 `POST /api/ai/chat` 成功。
- 未登录调用 `POST /api/ai/chat` 返回 401。
- 非管理员调用 `POST /api/admin/users` 与 `POST /api/admin/users/reset-password` 返回 403。
- 管理员调用上述接口时，JWT 校验与 `is_admin()` 校验都能通过。

### 用户事务验证

- 管理员创建用户成功后，Supabase Auth 与 `public.users.auth_id` 正确对应。
- 业务表写入失败时，已创建的 Auth 用户会被补偿删除。
- 重复用户名创建时，返回预期冲突错误，不产生脏数据。
- 重置密码后，目标账号可使用临时密码登录。

### AI 代理验证

- `provider=gemini` 时成功返回模型文本。
- `provider=deepseek` 时成功返回模型文本。
- 缺失对应 provider API key 时返回明确 500 配置错误。
- 非法 provider 参数返回 400。

### 前端联调验证

- `services/gemini.ts` 改造后，原有 AI 入口仍可正常使用。
- `components/UserView.tsx` 改造后，新增用户与重置密码流程可正常提示成功/失败。
- 前端不会再直接依赖 `supabase.functions.invoke('ai-chat')` 或 `supabase.functions.invoke('admin-user-manager')`。
- 若未来把 `VITE_BACKEND_API_BASE_URL` 指向 Edge Function 网关地址，前端业务层无需再改页面逻辑。
