# 管理员用户能力切换至 Edge Function 设计

## 目标

将“创建用户”和“重置密码”固定切换到 Supabase `admin-user-manager` Edge Function。AI 对话继续使用现有 Flask 后端。管理员操作不再依赖 `VITE_BACKEND_API_BASE_URL`，也不再调用 Flask 的 `/api/admin/*` 接口。

## 范围

- 创建 `admin-user-manager` Edge Function。
- 创建用户和重置密码固定调用该函数。
- 保持账号邮箱为 `<username>@app.local`。
- 保持初始密码和重置密码为 `888888`。
- 角色只接受 `Admin`、`Manager`、`Employee`。
- AI 对话继续使用 Flask。
- 不改变删除用户行为。
- 不新增数据库迁移；复用 `public.users.auth_id`、`public.is_admin()` 和现有审计字段默认值。

## 架构

前端的 `services/backendGateway.ts` 按能力分流：

- `chatWithAI()` 保持现有 Flask/Edge 目标逻辑，本次正式配置继续使用 Flask。
- `createAdminUser()` 固定调用 `supabase.functions.invoke('admin-user-manager')`。
- `resetAdminUserPassword()` 固定调用同一函数。

Edge Function 使用调用者 JWT 创建用户作用域客户端，调用 `auth.getUser()` 验证登录态，并通过 `public.is_admin()` 验证业务管理员身份。只有通过两层校验后，函数才使用平台提供的 `SUPABASE_SERVICE_ROLE_KEY` 创建服务端管理员客户端，执行 Auth Admin API 和业务表写入。

正式前端继续只保存公开配置：`VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`。管理员能力不增加前端环境变量。`VITE_BACKEND_TARGET` 和 `VITE_BACKEND_API_BASE_URL` 只服务 AI 对话。

## 文件边界

- `supabase/functions/admin-user-manager/index.ts`：Deno 入口、读取平台环境、创建 Supabase 客户端和启动 HTTP 服务。
- `supabase/functions/admin-user-manager/handler.ts`：CORS、HTTP 方法、JWT/管理员校验、请求解析、动作分发和统一响应。
- `supabase/functions/admin-user-manager/service.ts`：创建用户、Auth 补偿删除和密码重置。
- `supabase/functions/admin-user-manager/contracts.ts`：请求、响应、依赖接口、错误码和输入验证。
- `supabase/functions/tests/admin-user-manager.test.ts`：使用依赖替身验证完整业务分支。
- `supabase/config.toml`：为函数显式设置 `verify_jwt = true`。
- `services/backendGateway.ts`：管理员操作固定走 Edge Function，AI 继续使用 Flask。
- `store/useAppStore.ts`、`hooks/useAppActions.ts`、`components/UserView.tsx`：把 Edge 已持久化的新用户同步到当前状态和保存基线，避免再次保存。

## 创建用户流程

请求体：

```json
{
  "action": "create_user",
  "username": "zhangsan",
  "name": "张三",
  "role": "Employee",
  "departmentId": "dept-001"
}
```

函数执行：

1. 验证用户 JWT 和 `public.is_admin()`。
2. 将用户名去除首尾空白并转换为小写。
3. 用户名限定为 1 至 64 个字母、数字、点、下划线或连字符，不允许 `@` 和空白。
4. 姓名限定为 1 至 100 个字符。
5. 角色必须是 `Admin`、`Manager` 或 `Employee`。
6. `departmentId` 非空时必须存在于 `public.departments`。
7. 拒绝 `public.users` 中已存在的同名用户。
8. 通过 Auth Admin API 创建邮箱 `<username>@app.local`、密码 `888888`、已确认邮箱的 Auth 用户。
9. 使用 `user-${crypto.randomUUID()}` 创建 `public.users` 记录，写入 `auth_id` 和空权限集合。
10. 返回 `userId`、`authId`、邮箱和临时密码。

Auth 创建成功而业务用户写入失败时，立即删除刚创建的 Auth 用户。补偿删除也失败时返回 `CREATE_COMPENSATION_FAILED` 和请求编号，日志仅记录请求编号、动作、调用者、目标和稳定错误码。

## 重置密码流程

请求体：

```json
{
  "action": "reset_password",
  "auth_id": "00000000-0000-4000-8000-000000000000"
}
```

函数执行：

1. 验证用户 JWT 和 `public.is_admin()`。
2. 校验 `auth_id` 为 UUID。
3. 确认目标 `auth_id` 绑定在 `public.users` 中。
4. 拒绝调用者重置自己的密码。
5. 通过 Auth Admin API 将密码更新为 `888888`。
6. 不修改业务用户的角色、部门、权限或其他字段。

## 前端状态一致性

Edge Function 已经写入业务表，前端不得把新用户当作待保存记录。新增“接受已持久化用户”的 store 动作，同时合并 `users` 和 `lastSavedUsers`，并保留创建前已经存在的用户域脏状态。重置密码不修改前端业务状态。

## 错误契约

错误响应统一为：

```json
{
  "success": false,
  "error": {
    "code": "USER_ALREADY_EXISTS",
    "message": "该账号已存在，请使用其他账号"
  },
  "requestId": "request-uuid"
}
```

稳定错误码包括：`INVALID_REQUEST`、`INVALID_ACTION`、`INVALID_ROLE`、`METHOD_NOT_ALLOWED`、`ORIGIN_NOT_ALLOWED`、`AUTH_REQUIRED`、`ADMIN_REQUIRED`、`DEPARTMENT_NOT_FOUND`、`USER_ALREADY_EXISTS`、`AUTH_CREATE_FAILED`、`BUSINESS_USER_CREATE_FAILED`、`CREATE_COMPENSATION_FAILED`、`TARGET_USER_NOT_FOUND`、`SELF_RESET_NOT_ALLOWED`、`PASSWORD_RESET_FAILED`、`CONFIGURATION_ERROR` 和 `INTERNAL_ERROR`。

响应不得包含 JWT、密钥、密码之外的 Auth 内部数据、数据库错误详情或堆栈。

## CORS 和 Secret

`verify_jwt` 保持开启。函数根据 `ADMIN_ALLOWED_ORIGINS` 返回允许的 Origin；正式值为 `https://remix.btitib.com`，本地测试可额外配置 `http://localhost:3000`。

Supabase 托管环境自动提供 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`。正式服务器和前端 `.env` 不保存 Service Role Key。

## 测试

单元测试覆盖未登录、非管理员、非法输入、部门不存在、重复用户、创建成功、业务写入失败补偿、补偿失败、重置成功、目标不存在、自助重置禁止和 Auth 更新失败。测试还验证响应不泄露内部错误。

前端静态和构建验证覆盖：管理员操作只出现 `admin-user-manager`，不再出现 `/api/admin/users`；AI Flask 路径仍存在；`npm run lint:app` 和 `npm run build:secure` 通过。

正式验收使用批准的账号人工执行，不运行自动写入型 smoke test。浏览器网络面板必须看到 `/functions/v1/admin-user-manager`，不得出现 `/api/admin/users`。

## 发布顺序

1. 在测试 Supabase 项目部署函数并完成全部测试。
2. 将函数先部署到正式 Supabase 项目，验证未认证请求被拒绝。
3. 将已验收代码合入 `main`。
4. 正式服务器拉取 `main`，保留现有公开 Supabase 配置和 AI Flask 配置，重新构建前端。
5. 使用批准的正式账号验收创建用户和重置密码。
6. 稳定后删除 Flask 管理员路由和 Flask 环境中的 Service Role Key。

## 回滚

函数先于前端部署，部署失败不会影响当前网站。前端切换后若出现问题，可恢复上一版前端构建；函数保留以便排查。每次函数发布对应 Git 提交，通过重新部署已验证提交完成函数回滚。Flask 管理员接口在 Edge 正式验收前保留但不再被前端调用，验收后再移除。

## 参考

- https://supabase.com/docs/guides/functions/auth-headers
- https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid
- https://supabase.com/docs/guides/functions/unit-test
- https://supabase.com/docs/guides/functions/quickstart
