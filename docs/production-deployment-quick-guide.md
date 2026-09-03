# AI Xing 正式服简版部署手册

适用状态：正式数据库迁移、任务周期回填和 readiness 已完成，26 条历史复盘引用
已书面接受。本次不重复数据库预检、备份、迁移或回填。

正式分支：`main`；项目目录：`/www/wwwroot/ai-xing`；正式域名：
`remix.btitib.com`。

## 一、先在本地发布 Edge Function

新前端发布前，先把管理员函数部署到正式 Supabase 项目：

```powershell
npx supabase login
$projectRef = "<正式 Supabase 项目 REF>"
npx supabase secrets set ADMIN_ALLOWED_ORIGINS=https://remix.btitib.com --project-ref $projectRef
npx supabase functions deploy admin-user-manager --project-ref $projectRef
```

`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` 由托管函数自动
提供，不需要手工创建。不要把这些高权限值写进前端 `.env`。

只读入口验证（预期 HTTP 401）：

```powershell
curl.exe -sS -o NUL -w "%{http_code}`n" `
  "https://$projectRef.supabase.co/functions/v1/admin-user-manager"
```

返回 401 表示函数已上线且拒绝未登录请求。返回 2xx 或 5xx 时停止前端发布。

## 二、正式服务器拉取 main

在正式服务器 SSH 或宝塔终端执行：

```bash
cd /www/wwwroot/ai-xing
git status --short
git fetch origin
git checkout main
git pull --ff-only origin main
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
```

分支必须是 `main`，两个提交号必须一致。`git status --short` 有输出或拉取失败时
停止，不要使用 `git reset --hard`，也不要在正式服务器直接合并 `dev`。

## 三、创建前端 `.env`

```bash
sudoedit /www/wwwroot/ai-xing/.env
```

```dotenv
VITE_SUPABASE_URL=https://<正式Supabase项目>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<正式Publishable或Anon Key>

# 以下两项只控制 AI；管理员创建用户和重置密码不读取它们
VITE_BACKEND_TARGET=flask
VITE_BACKEND_API_BASE_URL=https://<正式Flask公开地址>
```

没有新增管理员专用的前端变量。正式 Flask 地址按现场真实地址填写，不要照抄
本地的 `http://127.0.0.1:5000`。如果暂不验收 AI，可稍后补齐 AI 两项，但这不
影响用户创建和密码重置。

禁止加入 `DATABASE_URL`、`MCP_MIGRATION_DATABASE_URL`、Service Role Key、
Secret Key 或 Access Token。

```bash
sudo chmod 600 /www/wwwroot/ai-xing/.env
```

## 四、安装依赖并构建

```bash
cd /www/wwwroot/ai-xing
npm ci
npm run build:secure
npm --prefix mcp-server ci --omit=dev
```

`--omit=dev` 中的 `dev` 指开发依赖，不是 Git 的 `dev` 分支。宝塔网站运行目录
指向 `/www/wwwroot/ai-xing/dist`。

## 五、创建 MCP 环境文件

```bash
sudo mkdir -p /etc/ai-xing
sudoedit /etc/ai-xing/mcp.env
```

```dotenv
SUPABASE_URL=https://<正式Supabase项目>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<正式Publishable或Anon Key>
NODE_ENV=production
MCP_ALLOW_NON_LOOPBACK=false
MCP_HOST=127.0.0.1
MCP_PORT=8787
MCP_ALLOWED_HOSTS=remix.btitib.com,127.0.0.1,localhost
MCP_TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1,::ffff:127.0.0.1
MCP_REQUIRE_HTTPS=true
```

```bash
sudo chown root:root /etc/ai-xing/mcp.env
sudo chmod 600 /etc/ai-xing/mcp.env
```

MCP 环境文件不需要数据库连接串或 Service Role Key。

## 六、启动 MCP 并设置开机自启

下面三段在正式服务器依次复制粘贴。

第一段，创建服务账号：

```bash
getent group ai-xing >/dev/null || sudo groupadd --system ai-xing
id ai-xing >/dev/null 2>&1 || sudo useradd --system --gid ai-xing --no-create-home --shell "$(command -v nologin)" ai-xing
```

第二段，安装服务配置：

```bash
sudo cp /www/wwwroot/ai-xing/deploy/systemd/ai-xing-mcp.service.example /etc/systemd/system/ai-xing-mcp.service
NODE_BIN="$(readlink -f "$(command -v node)")"
sudo sed -i 's|/opt/ai-xing|/www/wwwroot/ai-xing|g' /etc/systemd/system/ai-xing-mcp.service
sudo sed -i "s|/usr/bin/node|$NODE_BIN|g" /etc/systemd/system/ai-xing-mcp.service
```

如果 `NODE_BIN` 位于 `/root/.nvm/`，停止并改用所有服务账号都能访问的 Node.js
20 或更高版本。

第三段，启动并设置自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-xing-mcp
sudo systemctl status ai-xing-mcp --no-pager
```

必须显示 `active (running)`。

## 七、Nginx 与验证

保留现有网站配置，在 HTTPS `server {}` 中确认 `/mcp` 反向代理到
`http://127.0.0.1:8787`。不要在防火墙或安全组开放 8787。

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl is-enabled ai-xing-mcp
sudo systemctl is-active ai-xing-mcp
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready
ss -ltn | grep ':8787'
```

systemd 必须为 `enabled`、`active`，health/ready 正常，8787 只监听
`127.0.0.1`。

## 八、浏览器验收

用批准的正式管理员账号执行：

1. 创建一个批准的验收用户，确认可使用初始密码 `888888` 登录。
2. 重置一个批准的非当前管理员账号，确认新密码为 `888888`。
3. 浏览器 Network 中两个操作都必须请求
   `/functions/v1/admin-user-manager`，不得请求 `/api/admin/users`。
4. 单独验证 AI；AI 请求仍应发往正式 Flask 地址。

任一步失败就停止。Edge Function 首发观察期暂时保留旧 Flask 管理员代码；正式
验收稳定后，再删除 Flask 管理员端点及其 Service Role 配置。
