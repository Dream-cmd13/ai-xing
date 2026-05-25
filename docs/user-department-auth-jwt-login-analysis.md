# 用户表、部门表、JWT 鉴权与登录模块实现分析

## 1. 项目当前认证与鉴权结论（先看这个）

- 认证（Authentication）使用 Supabase Auth：前端调用 `supabase.auth.signInWithPassword` 登录，底层是 JWT 会话。
- 业务身份（Business Identity）在 `public.users` 表：通过 `users.auth_id` 关联 Supabase Auth 用户 `auth.uid()`。
- 权限控制（Authorization）分两层：
  - 前端层：基于 `currentUser.role`、`systemRoleIds`、`customPermissions`、`padPermissions` 控制可见/可操作功能。
  - 数据库层：RLS Policy + `is_admin()` / `current_user_id()` 函数做最终兜底。

---

## 2. 关键表结构：`users` 与 `departments`

## `users` 表

当前定义已统一收敛到 [00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L12-L25)：

- 主键：`id TEXT`
- 认证绑定：`auth_id UUID UNIQUE`（新增）
- 账号字段：`username`、`name`、`role`
- 组织字段：`department_id`
- 权限扩展字段：`pad_permissions`、`system_role_ids`、`custom_permissions`
- 评审字段：`reviews`
- 密码字段：`password` 在安全脚本中被删除（不再在业务表存明文/业务密码）

对应 TS 模型见 [types.ts](/D:/okr-ai/types.ts:135)。

## `departments` 表

定义在 [00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L27-L40)：

- 主键：`id TEXT`
- 业务字段：`name`、`manager_name`、`responsibilities`、`attributes`
- 结构字段：`sub_departments JSONB`（树形）
- 职责/角色字段：`roles JSONB`、`role_members JSONB`
- 目标与评审：`okrs JSONB`、`reviews JSONB`

对应 TS 模型见 [types.ts](/D:/okr-ai/types.ts:116)。

---

## 3. 登录模块实现链路

## 3.1 登录入口

在 [components/LoginView.tsx](/D:/okr-ai/components/LoginView.tsx:65)：

1. 用户输入 `username` 和 `password`
2. 前端将用户名拼成邮箱：`{username}@app.local`
3. 调用 `supabase.auth.signInWithPassword({ email, password })`
4. 登录成功后跳转 `/workbench`

说明：这里实际上把“用户名登录”映射成 Supabase 的 email/password 登录。

## 3.2 Session 恢复与登录态初始化

在 [App.tsx](/D:/okr-ai/App.tsx:117) 与 [App.tsx](/D:/okr-ai/App.tsx:122)：

- 启动时先 `supabase.auth.getSession()`
- 再监听 `supabase.auth.onAuthStateChange`
- 一旦拿到 `session.user.id`（即 Supabase Auth UID）：
  - 加载工作区数据 `getWorkspace()`
  - 在 `workspace.users` 里查找 `u.auth_id === session.user.id`（[App.tsx](/D:/okr-ai/App.tsx:52)）
  - 命中后调用 `useAuthStore.login(user)`，并把各业务数据灌入全局状态

这一步是“认证身份 -> 业务用户”的关键映射。

## 3.3 客户端 Auth Store

在 [store/useAuthStore.ts](/D:/okr-ai/store/useAuthStore.ts:1)：

- `login(user)`：仅设置 `isAuthenticated/currentUser`
- `logout()`：清空本地状态 + `supabase.auth.signOut()`
- 额外删除了 `localStorage` 的 `stratflow_session`（历史兼容残留）

---

## 4. JWT 与 RLS 鉴权如何落地

## 4.1 JWT 生命周期（由 Supabase SDK 管理）

Supabase 客户端初始化在 [supabase.ts](/D:/okr-ai/supabase.ts:10)：

- `persistSession: true`：持久化会话（本地存储 token）
- `autoRefreshToken: true`：自动续期 access token

即：业务代码不手写 JWT 签发/刷新逻辑，依赖 Supabase Auth 托管。

## 4.2 RLS 使用 JWT Claim（`auth.uid()`）

关键安全函数在 [00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L210-L223)：

- `is_admin()`：当前 JWT 对应 UID 在 `users` 表里 role=Admin 则返回 true
- `current_user_id()`：把 `auth.uid()` 转成业务 `users.id`

策略示例：

- `users_update`：本人或管理员可改（[00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L255-L260)）
- `departments_update/delete`：仅管理员（[00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L262-L265)）
- `tasks_update`：任务 owner 或管理员（[00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L282-L287)）

结论：JWT 只负责“你是谁”；RLS 决定“你能做什么”。

---

## 5. 用户与部门数据读写实现

数据访问层在 [data.ts](/D:/okr-ai/data.ts:1)：

- `getWorkspace()` 并发拉取 `users/departments/...`（[data.ts](/D:/okr-ai/data.ts:77)）
- 将 DB snake_case 转为前端 camelCase（如 `department_id -> departmentId`，见 [data.ts](/D:/okr-ai/data.ts:127)）
- 原子写接口：
  - 用户：`addUser/updateUser/deleteUser`
  - 部门：`addDepartment/updateDepartment/deleteDepartment`

用户管理界面还调用了 Edge Function `admin-user-manager` 创建账号/重置密码（[components/UserView.tsx](/D:/okr-ai/components/UserView.tsx:131)）。

---

## 6. 现状中的关键风险与改进建议

## 风险 1：`users_select` 对所有 authenticated 全开放

现策略是 `USING (true)`（[00_one_click_schema.sql](file:///d:/aixing/okr-ai/sql/00_one_click_schema.sql#L255-L255)），意味着任何登录用户都可读全员信息。

建议：按租户/组织/可见域收敛查询范围，至少区分 Admin 与普通用户可见字段。

## 风险 2：前端权限控制可被绕过，必须以 RLS 为准

前端控制只影响 UI，真正安全边界仍是 RLS。当前项目已做 RLS，是正确方向；建议进一步覆盖所有敏感写操作并做最小权限策略审计。

## 风险 3：历史字段与会话清理不一致

`logout()` 删除 `stratflow_session`，但 Supabase 自身会话 key 与其不同（[store/useAuthStore.ts](/D:/okr-ai/store/useAuthStore.ts:19)）。

建议：保留 `supabase.auth.signOut()` 即可；若无历史依赖，可清理残留逻辑避免误导。

## 风险 4：用户名转 email 的映射耦合

`{username}@app.local` 方案简单，但会把账号体系耦合到固定域名约定（[components/LoginView.tsx](/D:/okr-ai/components/LoginView.tsx:64)）。

建议：在 `users` 表显式保存 `auth_email` 或统一由后台创建并回传，减少隐式约定。

---

## 7. 扩展知识（和当前实现强相关）

## 7.1 AuthN vs AuthZ

- AuthN（认证）：确认用户身份，项目中由 Supabase Auth + JWT 完成。
- AuthZ（授权）：控制资源访问，项目中由 PostgreSQL RLS Policy 完成。

最佳实践是“前端做体验，后端做强约束”。

## 7.2 为什么 `auth_id` 映射常见

很多业务都需要“认证用户”与“业务用户档案”分离：

- 认证域：邮箱、密码、MFA、token 生命周期
- 业务域：部门、角色、组织关系、扩展权限

`auth_id` 是跨域稳定主键，便于长期演进。

## 7.3 JWT 在 Supabase 场景下最容易踩坑的点

- 以为“前端隐藏按钮”就等于安全：错误，必须靠 RLS。
- 只测 Admin 路径，不测普通用户路径：会导致策略过宽。
- 忽略 token 过期和自动刷新：SDK 已托管，但要处理会话变更回调。

---

## 8. 一张时序图（文字版）

1. 用户在登录页提交用户名/密码  
2. 前端拼接 email，调用 Supabase `signInWithPassword`  
3. Supabase 返回 session（含 JWT）  
4. `onAuthStateChange` 触发  
5. 前端读取业务数据 `getWorkspace()`  
6. 用 `session.user.id` 匹配 `users.auth_id`  
7. 命中后设置 `currentUser`，进入业务页面  
8. 后续每次 DB 读写都带 JWT，RLS 基于 `auth.uid()` 判定权限  

---

## 9. 建议的下一步落地项

1. 补一份 `admin-user-manager` Edge Function 文档，明确“创建 auth 用户 + 回填 users.auth_id”的事务语义。  
2. 收紧 `users/departments` 的 SELECT 策略，至少提供“最小字段视图”或按角色分级。  
3. 增加一组鉴权回归用例：普通用户越权更新部门、越权改他人任务、管理员合法写入。  
