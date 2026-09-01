# AI Xing 正式服简版部署手册

适用环境：

- 服务器：CentOS 7 + 宝塔
- Git 分支：mcpkf
- 项目目录：/www/wwwroot/ai-xing
- 正式域名：remix.btitib.com
- MCP 内部地址：http://127.0.0.1:8787
- MCP 外部地址：https://remix.btitib.com/mcp
- 正式数据库当前基线：提交 aab58c6

重要：正式数据库连接串、密码、JWT、Service Role Key 和其他高权限凭据不得写入 Git、项目 .env、MCP 环境文件、日志或聊天。

## 一、部署前确认

1. 本地代码已经提交并推送到 GitHub 的 mcpkf 分支。
2. 已在 Supabase 或数据库平台完成正式库备份。
3. 宝塔服务器已经安装 Git、Node.js 20 或更高版本、npm 和 Nginx。
4. 服务器上的项目目录没有未提交修改。

检查：

~~~bash
cd /www/wwwroot/ai-xing
git status --short
node --version
npm --version
~~~

git status --short 必须没有输出。Node.js 必须为 20 或更高版本。

## 二、从 GitHub 拉取并构建

~~~bash
cd /www/wwwroot/ai-xing

git fetch origin
git branch --show-current       # 必须显示 mcpkf
git pull --ff-only origin mcpkf

npm ci
npm run build:secure
npm --prefix mcp-server ci --omit=dev
~~~

如果 git pull --ff-only 失败，停止部署并检查服务器上的修改，不要使用 git reset --hard。

前端构建结果位于：

~~~text
/www/wwwroot/ai-xing/dist
~~~

宝塔网站的运行目录应指向该 dist 目录。

## 三、执行正式数据库迁移

项目自带迁移器会从基线 aab58c6 开始，按照固定的 28 项清单执行后续迁移。不要在宝塔 SQL Editor 中逐个执行 SQL 文件。

### 1. 临时输入正式数据库连接串

使用 Supabase PostgreSQL Direct Connection 或 Session Pooler 连接，通常使用 5432 和 SSL。不要使用 Transaction Pooler 的 6543。

~~~bash
cd /www/wwwroot/ai-xing

set +x
read -r -s -p '请输入正式数据库连接串（不会回显）: ' MCP_MIGRATION_DATABASE_URL
printf '\n'
export MCP_MIGRATION_DATABASE_URL
~~~

### 2. 执行迁移

~~~bash
npm --prefix mcp-server run migrate
MIGRATION_STATUS=$?

unset MCP_MIGRATION_DATABASE_URL

if [ "$MIGRATION_STATUS" -ne 0 ]; then
  echo "数据库迁移失败，停止部署。退出码：$MIGRATION_STATUS" >&2
  unset MIGRATION_STATUS
  exit 1
fi

unset MIGRATION_STATUS
~~~

正常结果：

- 新迁移显示 migration_applied；
- 已执行迁移显示 migration_skipped；
- 2026-08-27_mcp_task_indexes 显示 migration_deferred，这是正常状态；
- 命令退出码为 0。

首次迁移不要执行以下命令：

~~~bash
# 不要执行
npm --prefix mcp-server run migrate -- --include-indexes
npm --prefix mcp-server run migrate -- --adopt-existing
~~~

迁移失败时停止部署。不要手工修改迁移账本，不要删除失败记录，也不要把 SQL 文件复制到宝塔 SQL Editor 重跑。

## 四、配置 MCP 正式环境

首次部署时创建正式环境文件：

~~~bash
sudo mkdir -p /etc/ai-xing

if [ ! -f /etc/ai-xing/mcp.env ]; then
  sudo cp /www/wwwroot/ai-xing/mcp-server/.env.example /etc/ai-xing/mcp.env
fi

sudo vi /etc/ai-xing/mcp.env
~~~

至少确认以下配置：

~~~dotenv
SUPABASE_URL=https://<正式Supabase项目>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<正式Publishable或Anon Key>

NODE_ENV=production
MCP_ALLOW_NON_LOOPBACK=false
MCP_HOST=127.0.0.1
MCP_PORT=8787
MCP_ALLOWED_HOSTS=remix.btitib.com,127.0.0.1,localhost
MCP_TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1,::ffff:127.0.0.1
MCP_REQUIRE_HTTPS=true
~~~

注意：

- MCP_ALLOWED_HOSTS 只填写域名，不填写 https:// 或 /mcp；
- 不要把 MCP_MIGRATION_DATABASE_URL 放进该文件；
- 不要放入 Service Role Key、数据库密码、JWT 或 Access Token。

设置权限：

~~~bash
sudo chown root:root /etc/ai-xing/mcp.env
sudo chmod 600 /etc/ai-xing/mcp.env
~~~

## 五、安装并启动 MCP 常驻服务

### 1. 创建运行账户

~~~bash
id ai-xing >/dev/null 2>&1 || \
sudo useradd --system --no-create-home --shell /sbin/nologin ai-xing
~~~

### 2. 安装 systemd 服务

~~~bash
sudo cp \
  /www/wwwroot/ai-xing/deploy/systemd/ai-xing-mcp.service.example \
  /etc/systemd/system/ai-xing-mcp.service

NODE_BIN=$(command -v node)

sudo sed -i \
  's#/opt/ai-xing#/www/wwwroot/ai-xing#g' \
  /etc/systemd/system/ai-xing-mcp.service

sudo sed -i \
  "s#/usr/bin/node#$NODE_BIN#g" \
  /etc/systemd/system/ai-xing-mcp.service

unset NODE_BIN
~~~

如果 command -v node 指向 /root/.nvm/，不要继续。应先通过宝塔或系统方式安装所有服务账户都能访问的 Node.js 20 或更高版本。

### 3. 启动并设置开机自启

~~~bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-xing-mcp
sudo systemctl status ai-xing-mcp --no-pager
~~~

服务正常时应显示 active (running)。

## 六、配置宝塔 Nginx

进入：

~~~text
宝塔 -> 网站 -> remix.btitib.com -> 设置 -> 配置文件
~~~

在该域名 HTTPS 的 server {} 内加入：

~~~nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Mcp-Session-Id $http_mcp_session_id;
    proxy_set_header Last-Event-ID $http_last_event_id;
    proxy_set_header Connection "";

    proxy_pass_header Mcp-Session-Id;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    client_max_body_size 256k;
}
~~~

保存配置前先使用宝塔的 Nginx 配置检查功能，检查通过后再重载 Nginx。

不要在宝塔防火墙或云服务器安全组中开放 8787。公网只允许通过：

~~~text
https://remix.btitib.com/mcp
~~~

## 七、部署后验证

在服务器执行：

~~~bash
sudo systemctl status ai-xing-mcp --no-pager
curl --fail --silent http://127.0.0.1:8787/health
curl --fail --silent http://127.0.0.1:8787/ready
ss -ltnp | grep ':8787'
~~~

必须满足：

- systemd 为 active (running)；
- /health 正常；
- /ready 返回 ready；
- 8787 只监听 127.0.0.1，不监听 0.0.0.0 或服务器公网 IP。

如果 /ready 不是 ready，停止上线并查看日志：

~~~bash
sudo journalctl -u ai-xing-mcp -n 100 --no-pager
~~~

日志中不得复制或传播数据库连接串、密码、JWT 或 Authorization 内容。

## 八、以后更新代码的固定顺序

后续每次发布都按以下顺序：

~~~bash
cd /www/wwwroot/ai-xing

git status --short
git branch --show-current       # 必须显示 mcpkf
git pull --ff-only origin mcpkf

npm ci
npm run build:secure
npm --prefix mcp-server ci --omit=dev

set +x
read -r -s -p '请输入正式数据库连接串（不会回显）: ' MCP_MIGRATION_DATABASE_URL
printf '\n'
export MCP_MIGRATION_DATABASE_URL

npm --prefix mcp-server run migrate
MIGRATION_STATUS=$?
unset MCP_MIGRATION_DATABASE_URL

if [ "$MIGRATION_STATUS" -ne 0 ]; then
  echo "数据库迁移失败，不重启 MCP。退出码：$MIGRATION_STATUS" >&2
  unset MIGRATION_STATUS
  exit 1
fi

unset MIGRATION_STATUS
sudo systemctl restart ai-xing-mcp
curl --fail --silent http://127.0.0.1:8787/health
curl --fail --silent http://127.0.0.1:8787/ready
~~~

数据库迁移器是幂等的，已经成功执行的版本会显示 migration_skipped。
