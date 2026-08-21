# 第一阶段公网 MCP 部署与使用说明

## 部署结果

第一阶段在现有服务器增加一个内部 Node.js 进程，对外仍然使用现有网站域名：

```text
TRAE → https://现有域名/mcp → Nginx → 127.0.0.1:8787
```

不增加新网站、新域名、新公网 IP，也不要求用户运行本地 MCP Bridge。

## 环境要求

- Node.js 20 或更高版本；
- 现有域名已经启用 HTTPS；
- Nginx 或等价反向代理；
- Supabase URL；
- Supabase Publishable Key 或 Anon Key；
- 业务用户已经通过 `users.auth_id` 绑定 Supabase Auth 用户；
- 不向 MCP 服务提供 Service Role Key、Secret Key 或数据库密码。

安全隔离说明：MCP 启动程序只读取 `mcp-server/.env`，不会读取项目根目录 `.env`。如果 MCP 进程环境中出现 Service Role Key、Supabase Secret Key、Supabase Access Token、数据库密码或 `DATABASE_URL`，服务会拒绝启动。

## 1. 安装 MCP 服务

在项目部署目录执行：

```bash
npm --prefix mcp-server ci --omit=dev
```

MCP 服务拥有独立的 `package-lock.json`，不会改变现有前端的依赖安装方式。

本地调试时，可以把 `mcp-server/.env.example` 复制为不提交 Git 的 `mcp-server/.env`。不要为了图方便让 MCP 读取项目根目录 `.env`。

## 2. 配置服务器环境变量

复制示例：

```bash
sudo install -d -m 750 /etc/ai-xing
sudo install -m 600 mcp-server/.env.example /etc/ai-xing/mcp.env
```

编辑 `/etc/ai-xing/mcp.env`：

```dotenv
SUPABASE_URL=https://你的项目.supabase.co
SUPABASE_PUBLISHABLE_KEY=你的Publishable或AnonKey
MCP_HOST=127.0.0.1
MCP_PORT=8787
MCP_ALLOWED_HOSTS=你的现有域名,127.0.0.1,localhost
MCP_SESSION_TTL_MS=28800000
MCP_REFRESH_WINDOW_MS=60000
MCP_REQUEST_TIMEOUT_MS=15000
MCP_RATE_LIMIT_WINDOW_MS=60000
MCP_RATE_LIMIT_MAX=30
MCP_REQUIRE_HTTPS=true
```

注意：

- `MCP_ALLOWED_HOSTS` 填域名，不包含 `https://` 和路径；
- 生产环境必须设置 `MCP_REQUIRE_HTTPS=true`；
- MCP 只监听 `127.0.0.1`，不要把8787端口开放到公网；
- 不要添加 `SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_SECRET_KEY` 或数据库密码。

## 3. 配置 systemd

根据服务器真实目录修改：

```text
deploy/systemd/ai-xing-mcp.service.example
```

然后安装并启动：

```bash
sudo cp deploy/systemd/ai-xing-mcp.service.example /etc/systemd/system/ai-xing-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-xing-mcp
sudo systemctl status ai-xing-mcp
```

本机健康检查：

```bash
curl http://127.0.0.1:8787/health
```

预期：

```json
{"status":"ok","service":"ai-xing-okr-mcp","version":"0.1.0"}
```

## 4. 配置现有域名 `/mcp`

把下面的示例内容放入现有 HTTPS 域名的 `server {}` 中：

```text
deploy/nginx/mcp-location.conf.example
```

检查并重新加载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

公网健康检查仍使用 `/health` 的内部端口；`/mcp` 是协议端点，不用于浏览器打开测试。

## 5. 为个人 TRAE 配置 Basic Header

第一阶段的 Basic Header 是账号密码的可逆编码，不是加密。必须满足：

- 只通过 HTTPS 发送；
- 只写入个人 TRAE 配置；
- 不写入项目共享的 `.trae/mcp.json`；
- 不提交 Git；
- 不把 Header 发给其他人。

Windows PowerShell 可以在不把密码写入命令历史的情况下生成编码：

```powershell
$mcpUser = Read-Host "系统账号"
$mcpSecurePassword = Read-Host "系统密码" -AsSecureString
$mcpPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($mcpSecurePassword)
try {
  $mcpPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($mcpPasswordPointer)
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${mcpUser}:${mcpPassword}"))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($mcpPasswordPointer)
  Remove-Variable mcpPassword -ErrorAction SilentlyContinue
}
```

复制输出结果，在 TRAE 的“设置 → MCP → 手动添加”中使用：

```json
{
  "mcpServers": {
    "ai_xing_okr": {
      "url": "https://你的现有域名/mcp",
      "headers": {
        "Authorization": "Basic 这里填写编码结果"
      }
    }
  }
}
```

项目中的 `.trae/mcp.json.example` 只有占位符，不能放入真实账号密码后提交。

## 6. 自动化测试

本地独立测试：

```bash
npm run mcp:test
```

真实域名和真实账号 smoke test：

```bash
MCP_TEST_URL=https://你的现有域名/mcp \
MCP_TEST_USERNAME=测试账号 \
MCP_TEST_PASSWORD=测试密码 \
npm run mcp:test:live
```

该脚本只输出通过状态和工具数量，不输出密码、Basic Header、JWT 或业务数据。

Admin、Manager、Employee 三类账号必须分别执行，并把权限结果记录到验收文档。

## 7. 日志与故障检查

查看服务状态：

```bash
sudo systemctl status ai-xing-mcp
sudo journalctl -u ai-xing-mcp --since "30 minutes ago"
```

日志只应包含请求 ID、HTTP 方法、路径、状态码和耗时。发现 Authorization、密码、JWT 或 Refresh Token 时必须停止验收并修复。

## 8. 回滚

第一阶段没有数据库结构变更。回滚步骤：

```bash
sudo systemctl disable --now ai-xing-mcp
sudo rm /etc/systemd/system/ai-xing-mcp.service
sudo systemctl daemon-reload
```

从现有 Nginx `server {}` 中移除 `/mcp` location，检查并重新加载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

回滚不会修改 Supabase 数据，也不会影响现有网站和 Flask API。

## 9. 第一阶段限制

- 只提供五个只读工具；
- Session 保存在单实例内存中，服务重启后用户需要重新连接；
- Basic Header 等价于长期保存系统密码，仅作为第一阶段简化方案；
- 密码修改只保证新的 MCP 连接不能继续使用旧密码，已经建立的 Session 按 Token 和会话过期策略结束；
- 真正写入、审计和并发控制属于第二阶段；
- Redis、OAuth 和主动预警属于第四阶段。
