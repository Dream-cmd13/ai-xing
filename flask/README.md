# Flask Backend

## 目标

- 为前端提供安全的 AI 代理接口。
- 在服务端隔离 `SUPABASE_SERVICE_ROLE_KEY` 与大模型 API Key。
- 保持接口契约可迁移回 Supabase Edge Functions。

## 本地启动

```bash
cd flask
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

## 环境变量

- 复制 `flask/.env.example` 到本地私有环境文件后再填写。
- 必填：
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`，或等价使用 `SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
- 按需填写：
  - `GEMINI_API_KEY`
  - `DEEPSEEK_API_KEY`

## 接口

- `GET /health`
- `POST /api/ai/chat`
- `POST /api/admin/users`
- `POST /api/admin/users/reset-password`

## 安全原则

- 前端只传 Supabase JWT，不传任何服务端密钥。
- 管理员接口在服务端校验 `public.is_admin()`。
- 大模型 API Key 只存在服务端环境变量中。
