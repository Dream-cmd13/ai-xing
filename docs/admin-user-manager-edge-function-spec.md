# `admin-user-manager` Edge Function 设计与事务语义说明

## 1. 现状说明

- 前端已调用 `admin-user-manager`，见 [components/UserView.tsx](/D:/okr-ai/components/UserView.tsx:131)。
- 仓库当前未包含该函数源码（`supabase/functions` 下仅有 `ai-chat`）。
- 因此本文件是“实现规范 + 契约文档”，用于对齐后端实际实现。

---

## 2. 它解决的核心问题

该函数负责把两套身份数据打通：

- 认证身份：Supabase Auth（`auth.users.id`，UUID）
- 业务身份：`public.users.id`（TEXT）以及扩展信息（部门、角色、权限）

关键桥接字段：`public.users.auth_id`  
其含义是“这个业务用户对应哪个 Auth 用户”。

---

## 3. 权限逻辑（谁能调用）

函数必须只允许管理员调用，推荐双重校验：

1. 校验调用者已登录（Bearer JWT 可解析出 `auth.uid()`）
2. 校验 `public.users` 中调用者对应记录为 `role='Admin'`

可复用 SQL 函数：`public.is_admin()`（见 [00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L210-L223)）。

---

## 4. 接口契约

## 4.1 创建用户

请求体：

```json
{
  "action": "create_user",
  "username": "zhangsan",
  "name": "张三",
  "role": "User",
  "departmentId": "dept-001"
}
```

响应体（成功）：

```json
{
  "success": true,
  "data": {
    "userId": "user-uuid-or-text-id",
    "authId": "supabase-auth-uuid",
    "email": "zhangsan@app.local",
    "temporaryPassword": "888888"
  }
}
```

`authId` 会被前端写回本地状态，见 [components/UserView.tsx](/D:/okr-ai/components/UserView.tsx:147)。

## 4.2 重置密码

请求体：

```json
{
  "action": "reset_password",
  "auth_id": "supabase-auth-uuid"
}
```

响应体（成功）：

```json
{
  "success": true,
  "data": {
    "authId": "supabase-auth-uuid",
    "temporaryPassword": "888888"
  }
}
```

---

## 5. `create_user` 的事务语义（重点）

目标：确保“Auth 用户创建”与“`public.users.auth_id` 回填”一致，不出现孤儿数据。

## 推荐执行顺序

1. 预校验：`username` 唯一、角色值合法、部门存在（可选）
2. 构造 email：`${username}@app.local`（与当前登录页一致，见 [components/LoginView.tsx](/D:/okr-ai/components/LoginView.tsx:64)）
3. 用 service role 调 `auth.admin.createUser` 创建 Auth 账号
4. 在 `public.users` 执行 upsert/insert：
   - `id`（业务用户 ID）
   - `username/name/role/department_id`
   - `auth_id = authUser.id`
5. 任一步失败则补偿：
   - 若 Auth 已创建但业务表写入失败，调用 `auth.admin.deleteUser(authUser.id)` 回滚
6. 成功后返回 `userId + authId`

## 一致性语义定义

- 成功：Auth 与 `public.users` 同时存在且一一对应
- 失败：两边都不存在（通过补偿保证）
- 不允许“只创建 Auth 不落业务表”的半成功

---

## 6. 幂等与并发

## 幂等建议

- 以 `username` 或 `email` 作为幂等键。
- 若重复请求且用户已存在，返回同一用户标识而不是再创建一份。

## 并发建议

- 对 `username`/`auth_id` 建唯一约束（`auth_id` 已有 UNIQUE，见 [00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L12-L25)）。
- 对重复创建冲突返回明确错误码（例如 `USER_ALREADY_EXISTS`）。

---

## 7. `reset_password` 的语义

1. 校验调用者 Admin 权限
2. 校验目标 `auth_id` 存在且可管理
3. 调 `auth.admin.updateUserById(auth_id, { password: "888888" })`
4. 返回成功，不修改 `public.users` 业务字段

注意：若后续启用首次登录强制改密，可在 metadata 增加 `must_change_password=true`。

---

## 8. 与 RLS 的关系

- Edge Function 用 service role 调用时通常绕过 RLS，因此必须在函数内部显式做 Admin 校验。
- 应用侧普通读写仍由 JWT + RLS 控制（`auth.uid()` 映射到 `users.auth_id`）。

---

## 9. 伪代码（Deno / Supabase Edge）

```ts
if (!isAuthenticated(request)) return 401;
if (!callerIsAdmin(request.jwt.sub)) return 403;

if (action === "create_user") {
  validateInput();
  const email = `${username}@app.local`.toLowerCase();

  // step 1: create auth user
  const authUser = await auth.admin.createUser({ email, password: "888888", email_confirm: true });
  if (!authUser.ok) return error;

  // step 2: write business user
  const dbResult = await db.from("users").insert({
    id: bizId,
    username,
    name,
    role,
    department_id,
    auth_id: authUser.id
  });

  if (!dbResult.ok) {
    await auth.admin.deleteUser(authUser.id); // compensation
    return error;
  }

  return { success: true, data: { userId: bizId, authId: authUser.id } };
}
```

---

## 10. 测试清单（最小集）

1. Admin 创建用户成功，`users.auth_id` 正确回填  
2. 非 Admin 调用返回 403  
3. `public.users` 写入失败时，Auth 用户被补偿删除  
4. 重复创建同 `username` 返回幂等结果或冲突错误  
5. 密码重置后可用新密码登录  
