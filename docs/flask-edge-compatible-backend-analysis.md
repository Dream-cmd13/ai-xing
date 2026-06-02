# Flask 安全后端与 Edge Function 可回切分析

## 背景

当前项目已接入 Supabase Auth，并依赖 JWT + `public.is_admin()` 完成登录态和管理员权限校验。原规划中存在 `ai-chat` 与 `admin-user-manager` 两类边缘函数能力，但它们目前未上线、未验证，且当前落地环境暂不适合直接使用 Edge Functions。

为保证当前可交付与未来可迁移，本次实现采用“前端能力抽象 + Flask 落地 + 接口契约中性化”的设计：

- 当前生产可先部署 Flask 到阿里云 ECS/容器。
- 前端不直接耦合 Flask，而是统一经过 `services/backendGateway.ts`。
- 未来若条件允许，可将同一业务契约迁移回 Supabase Edge Functions，而无需改动页面层。

## 已实现内容

## 1. Flask 服务目录

新增 `flask/` 目录，包含：

- `app.py`
  - 应用入口、CORS、健康检查、统一错误响应。
- `config.py`
  - 环境变量加载与必填项校验。
- `routes/ai.py`
  - `POST /api/ai/chat`
- `routes/admin_users.py`
  - `POST /api/admin/users`
  - `POST /api/admin/users/reset-password`
- `services/auth_guard.py`
  - Bearer JWT 校验
  - 管理员接口 `is_admin()` 校验
- `services/admin_user_service.py`
  - Auth 用户创建
  - `public.users` 写入
  - 写入失败补偿删除 Auth 用户
  - 密码重置
- `services/llm_service.py`
  - Gemini / DeepSeek provider 分发
- `services/providers/*.py`
  - 分别封装 Gemini 与 DeepSeek 调用

## 2. 前端后端网关抽象

新增 `services/backendGateway.ts`，统一管理以下能力：

- `chatWithAI`
- `createAdminUser`
- `resetAdminUserPassword`

该网关支持两种目标：

- `VITE_BACKEND_TARGET=flask`
  - 走 Flask REST 接口
- `VITE_BACKEND_TARGET=edge`
  - 保留走 `supabase.functions.invoke(...)` 的能力

这意味着后续切换后端实现时，页面层和业务组件不需要重写。

## 3. 前端调用已切换

- `services/gemini.ts`
  - 不再直接调用 `supabase.functions.invoke('ai-chat')`
  - 改为通过统一后端网关调用
  - 根据系统设置中的选中模型决定 `provider/model`
- `components/UserView.tsx`
  - 不再直接调用 `admin-user-manager`
  - 改为通过统一后端网关发起创建用户与重置密码

## 4. AI 配置安全收口

本次同时修复了一个重要安全隐患：

- 旧实现允许在前端系统设置中录入并持久化 `apiKey`
- 这会导致模型密钥进入业务配置甚至数据库

本次已调整为：

- `SystemConfigView` 仅保留模型选择与 `modelName`
- `apiKey` 不再要求前端填写
- `data.ts` 在读取/保存 `AISettings` 时会清洗配置，去除敏感字段
- 真实模型密钥仅允许存在于 Flask 服务端环境变量中

## 密钥边界

### 前端允许持有

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_ANON_KEY`
- `VITE_BACKEND_TARGET`
- `VITE_BACKEND_API_BASE_URL`

### 仅服务端允许持有

- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `DEEPSEEK_API_KEY`

## 管理员接口安全模型

管理员接口采取双重校验：

1. 前端透传当前 Supabase Access Token
2. Flask 使用匿名 key + Bearer JWT 调用 Supabase `/auth/v1/user` 校验登录态
3. Flask 调用 `POST /rest/v1/rpc/is_admin` 校验业务管理员权限
4. 只有通过后才允许使用 `SUPABASE_SERVICE_ROLE_KEY` 调用管理能力

这样可以保证：

- `service role key` 永不暴露到前端
- 普通用户即使知道接口地址也无法执行管理员动作
- 权限语义与数据库现有 `is_admin()` 保持一致

## 创建用户事务语义

创建用户使用如下顺序：

1. 校验用户名、姓名、角色
2. 校验用户名唯一
3. 校验部门存在
4. 在 Supabase Auth 创建用户
5. 在 `public.users` 写入业务记录并回填 `auth_id`
6. 若业务写入失败，则补偿删除刚创建的 Auth 用户

该流程避免出现“Auth 用户存在但业务表无记录”的半成功状态。

## 为什么该方案可回切到 Edge Function

本次实现不是“把业务写死在 Flask”，而是把“运行时入口”和“业务能力”分离：

- 页面层依赖的是抽象能力，而不是 Flask URL
- 接口字段使用中性 JSON 结构
- 认证方式始终是 `Authorization: Bearer <JWT>`
- 管理员语义始终复用 `is_admin()`
- AI provider 语义始终是 `provider + model + prompt`

因此未来切换回 Edge Functions 时：

- 前端只需把 `VITE_BACKEND_TARGET` 改为 `edge`
- 或将网关中的实现改指向新的 Edge Function 地址
- 页面与交互逻辑不需要再改

## 当前限制

- Flask 后端当前实现支持 `Gemini` 与 `DeepSeek`
- 未实现流式输出
- 未实现删除用户后端能力
- 未加入部署脚本、Dockerfile 与自动化测试
- Python 侧当前主要完成语义实现与接口落地，后续上线前建议再补集成测试和部署清单

## 上线前建议

- 在阿里云部署前，为 Flask 单独配置环境变量，不要复用前端 `.env`
- Flask 已兼容读取 `SUPABASE_ANON_KEY`、`SUPABASE_PUBLISHABLE_KEY` 与 `VITE_SUPABASE_PUBLISHABLE_KEY`，便于与现有项目变量命名平滑衔接
- 对管理员接口增加访问日志与失败审计
- 如需公网暴露，建议在网关层限制来源域名与速率
- 建议后续补充：
  - Flask 集成测试
  - Dockerfile / Gunicorn 启动脚本
  - Nginx 或 API 网关反向代理配置
  - 回切 Edge Function 的对照清单
