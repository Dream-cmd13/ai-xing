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

本手册只用于现场执行。开始前必须先完成 `docs/mcp-production-deployment-preparation.md` 的全部阻断项和独立授权；两份文档冲突时，以该部署前准备文档和候选制品中的迁移 manifest 为准。

## 一、部署前确认

1. 本地代码已经提交并推送到 GitHub 的 mcpkf 分支。
2. 正式库已运行修正后的只读复盘预检：`REVIEW_PERIOD_KEY_INVALID`、`REVIEW_PERIOD_FORMAT_INVALID` 和 `REVIEWS_FORMAT_INVALID` 均为 0；任何其他复盘原因码均已有书面处置决定。
3. 正式库任务周期 dry-run 已取得现场数量和摘要，所有缺失、倒置或超长日期例外均已人工处理。
4. 已在 Supabase 或数据库平台完成正式库备份和隔离恢复演练。
5. 宝塔服务器已经安装 Git、Node.js 20 或更高版本、npm、PostgreSQL 客户端和 Nginx。
6. 服务器上的项目目录没有未提交修改。

检查：

~~~bash
cd /www/wwwroot/ai-xing
git status --short
node --version
npm --version
psql --version
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

## 三、正式库预检、回填和迁移

项目自带迁移器会从基线 aab58c6 开始，按照固定的 32 项清单执行后续迁移。不要在宝塔 SQL Editor 中逐个执行 SQL 文件。任务周期必须先完成只读预检和受控回填，再执行最终周期契约迁移；顺序不能颠倒。

### 1. 临时输入正式数据库连接串

使用 Supabase PostgreSQL Direct Connection 或 Session Pooler 连接，通常使用 5432 和 SSL。不要使用 Transaction Pooler 的 6543。

~~~bash
cd /www/wwwroot/ai-xing

set +x
read -r -s -p '请输入正式数据库连接串（不会回显）: ' MCP_DB_URI_INPUT
printf '\n'
export MCP_MIGRATION_DATABASE_URL="$MCP_DB_URI_INPUT"
export PGDATABASE="$MCP_DB_URI_INPUT"
unset MCP_DB_URI_INPUT
~~~

连接变量只在当前受控终端会话中临时存在，不得写入项目 `.env` 或 `/etc/ai-xing/mcp.env`。

### 2. 执行只读预检和周期 dry-run

先创建仅管理员可读的证据目录：

~~~bash
sudo install -d -m 700 /var/backups/ai-xing
cd /www/wwwroot/ai-xing

psql -X -v ON_ERROR_STOP=1 \
  -f sql/2026-08-27_mcp_review_data_scan.sql \
  > "/var/backups/ai-xing/review-scan-$(date +%Y%m%d-%H%M%S).txt"

psql -X -v ON_ERROR_STOP=1 \
  -f sql/preflight/2026-09-01_review_task_period_consistency.sql \
  > "/var/backups/ai-xing/task-period-scan-$(date +%Y%m%d-%H%M%S).txt"

export MCP_BACKFILL_DATABASE_URL="$MCP_MIGRATION_DATABASE_URL"
set -o pipefail
node mcp-server/scripts/backfill-task-period.mjs \
  | tee "/var/backups/ai-xing/task-period-dry-run-$(date +%Y%m%d-%H%M%S).log"
MCP_PERIOD_DRY_RUN_STATUS=${PIPESTATUS[0]}
set +o pipefail
unset MCP_BACKFILL_DATABASE_URL
if [ "$MCP_PERIOD_DRY_RUN_STATUS" -ne 0 ]; then
  echo '任务周期 dry-run 失败，停止发布。' >&2
  unset MCP_PERIOD_DRY_RUN_STATUS MCP_MIGRATION_DATABASE_URL PGDATABASE
  exit 1
fi
unset MCP_PERIOD_DRY_RUN_STATUS
~~~

检查 `review-scan` 文件：`REVIEW_PERIOD_KEY_INVALID`、`REVIEW_PERIOD_FORMAT_INVALID` 和 `REVIEWS_FORMAT_INVALID` 必须均为 0。出现任意复盘原因码时，停止发布，先完成人工处置或取得书面接受；扫描不得自动改写历史复盘。

记录 dry-run 最后一条 `backfill_dry_run` 的 `planned`、`exceptions` 和 `digest`，但不要把数据库连接信息或业务正文复制到发布记录。必须满足：

- `exceptions=0`；
- 缺失、倒置或超长日期已经由业务负责人通过正常授权入口修正；
- 不根据旧周、标题、创建时间或复盘内容猜测日期；
- 历史复盘引用只形成处置记录，不在本步骤自动移动、删除或改写。

任一条件不满足，停止发布。`planned` 可以大于 0，它表示备份完成后需要执行确定性周索引回填。

### 3. 完成备份和隔离恢复演练

在正式写入前，使用数据库平台的备份能力完成备份，并恢复到独立项目或隔离数据库进行抽样验证。不得把恢复目标指向正式库。没有可验证的备份和恢复结果，不得继续。

### 4. 执行受控任务周期回填

本步骤会写正式库，只能在取得本次正式库写入独立授权后执行。如果 dry-run 的 `planned=0`，跳过执行模式，直接再次 dry-run 确认 `planned=0`、`exceptions=0`。

`planned` 大于 0 时，人工输入刚才同一正式库 dry-run 的数量和摘要：

~~~bash
cd /www/wwwroot/ai-xing
export MCP_BACKFILL_DATABASE_URL="$MCP_MIGRATION_DATABASE_URL"

read -r -p '请输入本次 dry-run 的 planned 数量: ' MCP_PERIOD_EXPECTED_COUNT
read -r -p '请输入本次 dry-run 的 digest: ' MCP_PERIOD_EXPECTED_DIGEST

node mcp-server/scripts/backfill-task-period.mjs \
  --execute \
  "--expected-count=$MCP_PERIOD_EXPECTED_COUNT" \
  "--expected-digest=$MCP_PERIOD_EXPECTED_DIGEST"
MCP_PERIOD_BACKFILL_STATUS=$?

unset MCP_BACKFILL_DATABASE_URL MCP_PERIOD_EXPECTED_COUNT MCP_PERIOD_EXPECTED_DIGEST

if [ "$MCP_PERIOD_BACKFILL_STATUS" -ne 0 ]; then
  echo '任务周期回填失败或已回滚，停止发布。' >&2
  unset MCP_PERIOD_BACKFILL_STATUS
  exit 1
fi

unset MCP_PERIOD_BACKFILL_STATUS
~~~

回填只允许修改 `target_weeks` 并递增 `row_version`。执行后重新运行第 2 步的 dry-run，结果必须为 `planned=0`、`exceptions=0`；否则禁止迁移。

### 5. 执行迁移

~~~bash
npm --prefix mcp-server run migrate
MIGRATION_STATUS=$?

unset MCP_MIGRATION_DATABASE_URL

if [ "$MIGRATION_STATUS" -ne 0 ]; then
  echo "数据库迁移失败，停止部署。退出码：$MIGRATION_STATUS" >&2
  unset MIGRATION_STATUS PGDATABASE
  exit 1
fi

unset MIGRATION_STATUS
~~~

正常结果：

- 新迁移显示 migration_applied；
- 已执行迁移显示 migration_skipped；
- 2026-08-27_mcp_task_indexes 显示 migration_deferred，这是正常状态；
- 命令退出码为 0。

迁移完成后只读核对最终发布契约：

~~~bash
psql -X -v ON_ERROR_STOP=1 -c 'SELECT public.mcp_get_readiness();'
~~~

必须返回 `status=ready`，并包含：

- `releaseId=2026-09-01-task-date-weeks`；
- `manifestDigest=9061382fd04ea9deb77565a3c90ffb82f9e49a8da1a20a94000783604392bf5c`；
- `requiredMigrations=true`、`functionPrivileges=true`；
- `taskDateWeekFunction=true`、`taskDateWeekTrigger=true`、`taskPeriodDataConsistent=true`。

完成核对后清除一次性变量：

~~~bash
unset MCP_MIGRATION_DATABASE_URL PGDATABASE
~~~

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

后续每次发布都按以下顺序。只要候选 manifest 或数据契约变化，必须重新执行第三节的只读预检、备份、必要回填和迁移；不能直接跳到重启：

~~~bash
cd /www/wwwroot/ai-xing

git status --short
git branch --show-current       # 必须显示 mcpkf
git pull --ff-only origin mcpkf

npm ci
npm run build:secure
npm --prefix mcp-server ci --omit=dev
~~~

构建完成后执行第三节。只有迁移成功、发布契约为 ready 且已取得服务操作授权，才执行：

~~~bash
sudo systemctl restart ai-xing-mcp
curl --fail --silent http://127.0.0.1:8787/health
curl --fail --silent http://127.0.0.1:8787/ready
~~~

数据库迁移器是幂等的，已经成功执行的版本会显示 migration_skipped；任何预检、回填、迁移或 readiness 失败都必须保持服务不重启并停止发布。
