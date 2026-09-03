# `admin-user-manager` Edge Function 运行规范

## 1. 当前状态

管理员创建用户和重置密码已固定调用 Supabase Edge Function：

- 前端入口：`services/backendGateway.ts`
- 函数入口：`supabase/functions/admin-user-manager/index.ts`
- HTTP 与鉴权：`supabase/functions/admin-user-manager/handler.ts`
- 业务与补偿：`supabase/functions/admin-user-manager/service.ts`
- JWT 配置：`supabase/config.toml`，`verify_jwt = true`

AI 对话仍由 Flask 提供。`VITE_BACKEND_TARGET` 和
`VITE_BACKEND_API_BASE_URL` 只控制 AI，不再控制管理员用户操作。

## 2. 配置边界

前端只保留公开配置：

```dotenv
VITE_SUPABASE_URL=https://<正式项目>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<正式 Publishable 或 Anon Key>
```

托管 Edge Function 自动获得以下 Supabase 内置环境变量，无需手工创建：

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

只需增加一个自定义 secret：

```text
ADMIN_ALLOWED_ORIGINS=https://remix.btitib.com
```

禁止把 Service Role Key、数据库连接串或任何 Secret Key 放进前端
`.env`、MCP 环境文件、Git 或构建产物。

## 3. 安全检查顺序

每次请求依次执行：

1. 浏览器 `Origin` 必须属于 `ADMIN_ALLOWED_ORIGINS`；无 `Origin` 的受控命令行检查允许继续。
2. Supabase 网关校验 JWT；函数内部再次调用 `auth.getUser(token)` 验证会话。
3. 使用调用者 JWT 执行 `public.is_admin()`；结果不是 `true` 时返回 403。
4. 只有通过以上检查，才使用 Service Role 执行 Auth Admin 和业务表操作。

日志只记录请求编号、动作、调用者 Auth ID、状态码和稳定错误码，不记录
JWT、密码、环境变量或底层提供商错误。

## 4. 接口契约

### 创建用户

```json
{
  "action": "create_user",
  "username": "zhang.san",
  "name": "张三",
  "role": "Employee",
  "departmentId": "dept-001"
}
```

允许角色仅为 `Admin`、`Manager`、`Employee`。用户名会转为小写，登录
email 为 `<username>@app.local`，初始密码为 `888888`。

成功响应：

```json
{
  "success": true,
  "data": {
    "userId": "user-...",
    "authId": "supabase-auth-uuid",
    "email": "zhang.san@app.local",
    "temporaryPassword": "888888"
  },
  "requestId": "..."
}
```

执行顺序为：校验用户名和部门，创建 Auth 用户，写入 `public.users`。如果
业务表写入失败，函数立即删除刚创建的 Auth 用户；补偿也失败时返回
`CREATE_COMPENSATION_FAILED`，必须人工核对。

### 重置密码

```json
{
  "action": "reset_password",
  "auth_id": "supabase-auth-uuid"
}
```

目标 `auth_id` 必须已绑定到 `public.users`，且不能是当前管理员自己的
Auth ID。成功后密码重置为 `888888`，不修改业务用户资料。

## 5. 稳定错误码

- 请求类：`INVALID_REQUEST`、`INVALID_ACTION`、`INVALID_ROLE`、`METHOD_NOT_ALLOWED`
- 安全类：`ORIGIN_NOT_ALLOWED`、`AUTH_REQUIRED`、`ADMIN_REQUIRED`
- 创建类：`DEPARTMENT_NOT_FOUND`、`USER_ALREADY_EXISTS`、`AUTH_CREATE_FAILED`、
  `BUSINESS_USER_CREATE_FAILED`、`CREATE_COMPENSATION_FAILED`
- 重置类：`TARGET_USER_NOT_FOUND`、`SELF_RESET_NOT_ALLOWED`、`PASSWORD_RESET_FAILED`
- 运行类：`CONFIGURATION_ERROR`、`INTERNAL_ERROR`

客户端显示稳定的中文消息；底层数据库和 Auth 错误不得直接返回。

## 6. 正式部署顺序

在发布包含新前端的 `main` 分支之前，先执行：

```powershell
npx supabase login
npx supabase secrets set ADMIN_ALLOWED_ORIGINS=https://remix.btitib.com --project-ref <正式项目REF>
npx supabase functions deploy admin-user-manager --project-ref <正式项目REF>
```

然后以无 JWT 请求函数，确认返回 401 而不是 2xx 或 5xx。最后才构建和发布
正式前端。上线后使用批准的管理员账号完成一次创建和重置验收。

## 7. 回退与清理

首个版本暂时保留 Flask 管理员端点作为代码级回退，但前端已不再调用。
若正式验收失败，回退前端到上一批准版本；不要把 Service Role Key 放回前端。
正式验收通过并完成观察期后，删除 Flask 管理员路由、服务和 Flask 私有环境中
仅为这些路由保留的 Service Role Key。
