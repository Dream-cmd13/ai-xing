# Flask 与 Edge Function 职责边界

## 当前结论

正式方案已经拆分为两条独立链路：

- AI 对话：继续由 Flask 提供，受 `VITE_BACKEND_TARGET` 和
  `VITE_BACKEND_API_BASE_URL` 控制。
- 创建用户、重置密码：固定由 Supabase `admin-user-manager` Edge Function
  提供，不读取 Flask 地址，也不需要管理员专用前端环境变量。

因此，正式服曾出现的“缺少 `VITE_BACKEND_API_BASE_URL`”管理员报错已从代码
路径上消除。该变量缺失时仍可能影响 AI，但不会再影响用户创建和密码重置。

## 密钥边界

前端允许持有：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` 或 `VITE_SUPABASE_ANON_KEY`
- AI 使用的 `VITE_BACKEND_TARGET`、`VITE_BACKEND_API_BASE_URL`

Flask 私有环境仅保留 AI 提供商密钥。Supabase Edge Function 托管环境自动提供
`SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`；自定义 secret
仅需 `ADMIN_ALLOWED_ORIGINS`。

任何 Service Role Key、数据库连接串、Access Token 或 Secret Key 都不得进入
前端 `.env`、MCP 环境文件或构建产物。

## 管理员安全模型

Edge Function 同时执行四层约束：

1. Supabase 网关 `verify_jwt = true`。
2. 函数内部使用 JWT 调用 `auth.getUser()`，确认会话有效。
3. 使用同一 JWT 调用 `public.is_admin()`，确认业务管理员权限。
4. 浏览器来源必须匹配 `ADMIN_ALLOWED_ORIGINS`。

通过检查后，函数才使用 Service Role 完成 Auth Admin 和 `public.users` 操作。
创建业务资料失败时会补偿删除刚创建的 Auth 用户；重置密码只允许操作已绑定
业务用户，且禁止管理员在该入口重置自己。

## Flask 回退期

`flask/routes/admin_users.py` 和对应服务暂时不删除，作为首发观察期的代码回退
依据，但新前端不会调用这些端点。回退必须通过部署上一批准版本完成，不能通过
临时修改前端环境把管理员操作切回 Flask。

正式验收和观察期结束后执行第二阶段清理：

1. 删除 Flask 管理员路由与服务。
2. 删除 Flask 中仅为管理员路由使用的 Supabase Service Role 配置。
3. 保留 Flask AI 路由和模型密钥。
4. 再次运行 TypeScript、Python、构建和密钥扫描。

## 发布判定

- Edge Function 必须先于新前端部署。
- 无 JWT 请求必须返回 401。
- 普通登录用户调用必须返回 403。
- 正式管理员创建批准的验收用户成功，`auth.users` 与 `public.users.auth_id` 一致。
- 正式管理员重置批准的目标用户成功，新密码为 `888888`。
- 浏览器网络请求中不得出现 `/api/admin/users`。
- AI 请求仍按正式 Flask 地址工作。
