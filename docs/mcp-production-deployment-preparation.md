# AI Xing 正式服部署前准备

> 文档状态：独立候选发布门禁。本文不继承历史部署文档中的完成结论。
>
> 目标平台：CentOS 7。未取得单独授权前，不连接正式库、不执行正式迁移或数据库写入，也不启动、停止或重启正式服务。

## 1. 当前结论

当前代码已完成本地层面的依赖、前端状态、任务校验、迁移契约、MCP readiness、范围查询失败关闭、仓储拆分、systemd 模板和 allowlist 打包加固。正式发布仍然被以下现场证据阻断：

1. 正式库身份、版本、时区、基线对象、RLS、触发器、函数签名和权限尚未只读核验；
2. 正式库迁移账本与本候选制品的 32 项 manifest、顺序、状态和 digest 尚未核验；
3. 正式库尚未使用修正后的规则完成只读复盘预检；任何真实复盘原因码均须逐条处置或取得书面接受，其中 `REVIEW_PERIOD_KEY_INVALID`、`REVIEW_PERIOD_FORMAT_INVALID` 和 `REVIEWS_FORMAT_INVALID` 必须为 0；
4. 正式库任务日期/周只读扫描、缺失日期人工补全和受控周回填尚未完成；
5. 正式库备份和恢复演练尚未完成；
6. 正式迁移尚未获得独立授权，也未执行迁移后验收；发布契约不一致时必须返回 `RELEASE_CONTRACT_MISMATCH` 并保持 fail-closed；
7. CentOS 7 目标机的 glibc、Node、systemd、Nginx、HTTPS、防火墙、重启恢复和角色验收尚未完成；
8. 最终冻结提交、正式发布标签和正式制品摘要尚未生成。

因此当前状态是“本地候选已完成/待正式现场门禁”，不是“允许上线”。

## 2. 发布边界

数据库基线固定为提交 `aab58c6`。候选发布提交不得写死在文档中，必须在干净工作区执行打包时由 Git 读取，并写入制品的 `SHA256SUMS.json`。

本次范围包括：

- 当前网页生产构建和安全扫描；
- MCP Node 服务、只读/写入工具、认证、Session、限流和 readiness；
- `mcp-server/scripts/migrate.mjs` manifest 中的 32 个 SQL 迁移；
- Nginx 和 CentOS 7 systemd 模板；
- allowlist 发布制品和 SHA-256 清单。

本次不包括第三、第四阶段、无关前端重构、临时诊断文件或未进入冻结提交的用户修改。

## 3. 不可违反的限制

- 文档、日志、命令输出、制品和提交中不得记录密码、JWT、Authorization、Refresh Token、密钥、数据库连接串或高权限配置。
- MCP 运行进程只允许使用 Supabase 公共 URL 和 Publishable/Anon Key。禁止注入 Service Role、Secret Key、数据库密码或迁移连接变量。
- 正式库先只读核验。迁移和任何写入必须另行授权。
- 迁移只通过受控迁移器执行，不在 SQL Editor 手工粘贴整批迁移。
- 不从脏工作区制作正式制品，不手工复制目录作为发布包。
- `local-test-files/`、`.env`、日志、诊断、未批准的回填和 live smoke 文件不得进入正式制品。
- 正式环境不得运行会创建或更新业务数据的 `live-smoke.mjs`。

## 4. 候选制品

先在本地干净冻结提交上执行：

```bash
npm ci
npm --prefix mcp-server ci
npm run lint:app
npm run build:secure
npm run mcp:test
npm audit --omit=dev --registry=https://registry.npmjs.org
npm --prefix mcp-server audit --omit=dev --registry=https://registry.npmjs.org
git diff --check
npm run package:production -- release-output/<candidate>
```

还需对全部 MCP `.mjs` 执行 `node --check`。正式打包命令要求：

- 工作区干净；
- 输出位于工作区 `release-output/` 下的新目录；
- 输出目录不存在，拒绝覆盖；
- 仅复制显式 allowlist 中的 `dist/`、MCP `src/`、运行依赖锁、迁移器、经批准的任务周期回填器、部署模板、本文、32 项 manifest SQL 和两份只读正式库预检 SQL；
- 生成只含相对路径、SHA-256 和候选提交号的 `SHA256SUMS.json`；
- 安全扫描失败时不得继续发布。

打包脚本不会包含 `.env`、`local-test-files/`、诊断脚本、未批准的回填脚本、live smoke、日志或上述资产之外的 SQL。唯一允许的维护脚本是 `mcp-server/scripts/backfill-task-period.mjs`；两份 preflight SQL 仅用于只读检查，不进入迁移账本。

## 5. 已实现的本地门禁

2026-09-01 当前候选工作区的本地证据如下。冻结提交生成后仍需再运行一次同样的门禁：

- `npm run lint:app`：通过，TypeScript 零错误；
- `npm run build:secure`：通过，41 个文本构建资产敏感模式扫描通过，仅保留既有大 chunk 警告；
- `npm run mcp:test`：312/312 通过；冻结提交生成后仍需重跑，任何失败均阻断发布；
- 根项目和 `mcp-server` 的生产依赖审计：均为 0 vulnerabilities；
- MCP `src/`、`scripts/` 和根发布脚本 `.mjs`：`node --check` 全部通过；
- `git diff --check`：通过；
- manifest/SQL 对齐：32 项迁移无缺失；两份只读预检 SQL 单独作为发布资产，不进入迁移账本；
- allowlist 打包测试：2/2 通过，测试目录已清理且未生成正式制品；
- release contract 摘要由迁移器、Node readiness 校验和 SQL readiness 等值固定为当前候选摘要；摘要不匹配时返回 `RELEASE_CONTRACT_MISMATCH`；
- production 配置模板要求正式域名、loopback、可信 loopback 代理和 `MCP_REQUIRE_HTTPS=true`，错误配置会在启动时失败关闭；
- 本轮未连接任何正式环境；当前 MCP 测试库已完成任务周期迁移和幂等重放，本地 MCP 已重启并通过新版 readiness。

已实现内容：

- 根项目生产依赖审计为零漏洞，Router 固定版本，未使用依赖和浏览器 Gemini 密钥注入已删除；
- `build:secure` 在生产构建后扫描敏感模式；
- 范围任务加载按 ID 合并全局状态，网页和 MCP 人员补全每批最多 50 个任务；
- 任务更新校验由前向 SQL 迁移统一覆盖，人员函数固定 `search_path` 和执行权限；
- manifest 为 32 项，发布契约保存 ordered required versions 和 digest；
- 事务迁移使用注释、字符串和 dollar quote 感知的外层事务解析器；
- `2026-08-27_mcp_readiness.sql` 是唯一登记的历史无外壳例外；
- `/health` 只表示进程存活，`/ready` 和 POST/GET/DELETE `/mcp` 使用同一 readiness gate；
- readiness 降级、异常或超时时，MCP 在认证和 Session 处理前返回 `SERVICE_NOT_READY`；
- 生产 `MCP_HOST` 强制 loopback，非生产非 loopback 需要显式危险开关且生产环境拒绝该开关；
- `X-Forwarded-Proto` 只信任配置的代理地址；
- `auto/subtree` 任务范围、部门复盘和部门 OKR 缺少新版 RPC 时返回 `RPC_NOT_CONFIGURED`；
- `scope=exact` 仅保留经过测试的旧 RPC 等价兼容路径；
- 数据库任务契约拒绝统一返回公开码 `MCP_VALIDATION`，不暴露数据库内部错误正文；
- `repository.mjs` 是薄组合工厂，组织、任务、人员、OKR、复盘和流程读取位于独立仓储模块；
- systemd 模板采用 `Restart=always`、5 秒重启间隔、CentOS 7 启动限速和文件描述符限制。

### 5.1 当前测试库的任务周期证据

2026-09-01 对当前 MCP 测试库执行了方案 2 的受控回填：

- dry-run 新快照为 346 条可确定修复、2 条缺失日期例外；
- 346 条在同一 advisory lock 和事务内全部更新成功，只修改 `target_weeks` 并递增 `row_version`；
- 两条缺失日期任务由用户确认删除，没有新增专用迁移，也没有根据旧周推测日期；
- 删除后复查为 `planned=0`、`exceptions=0`；
- 两条通用任务周期迁移已成功应用，重放均返回 `skipped`；
- 本地 MCP 重启后 `/health=200`、`/ready=200`，release ID 为 `2026-09-01-task-date-weeks`，三个任务周期 readiness 标志均为 true；
- 日期为 `2026-06-29` 至 `2026-07-05` 的 89 条测试库任务全部精确绑定 `2026-W27`，`2026-W39` 命中为 0；
- 本证据只属于当前测试库。正式库必须生成自己的数量和摘要，不得复用 346 或测试库摘要。

正式库若发现缺失日期，仍必须由业务负责人给出起止日期。禁止根据旧周、任务文本、创建时间或历史复盘推测；历史复盘引用只报告，不自动移动、删除或改写。

## 6. CentOS 7 运行路径

CentOS 7 已停止常规维护，Node 20+ 与系统 glibc 兼容性不能靠版本号推断。上线前只能选择以下经过验证的路径之一：

1. 优先迁移到仍受支持的 Rocky Linux、AlmaLinux 或 RHEL，再运行受支持的 Node 20+；
2. 必须保留 CentOS 7 时，使用固定镜像容器，或使用在目标架构和 glibc 上完成验证的兼容 Node 构建。

目标机只读检查：

```bash
cat /etc/centos-release
uname -m
ldd --version
node --version
npm --version
systemctl --version
nginx -v
```

任一运行时、架构、TLS 或 systemd 条件不满足即停止发布，不在部署窗口临时升级系统运行库。

## 7. 目标拓扑与运行配置

```text
客户端 -> HTTPS /mcp -> Nginx -> 127.0.0.1:8787 MCP -> Supabase 公共 API/RLS
```

MCP 只绑定 loopback，公网不得直连 8787。生产环境文件至少明确：

```dotenv
NODE_ENV=production
MCP_HOST=127.0.0.1
MCP_PORT=8787
MCP_REQUIRE_HTTPS=true
MCP_ALLOWED_HOSTS=<正式域名>
MCP_TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1,::ffff:127.0.0.1
```

真实 Supabase 公共配置只放在权限为 600 的服务器环境文件中，不写入 Git、制品清单或验收记录。

### 7.1 正式配置交付方式

不要把正式配置原文粘贴到聊天窗口，也不要把正式值写入项目根目录 `.env`、`mcp-server/.env`、Git、工单附件或发布包。建议采用以下交付路径：

1. 在本地仅使用 `mcp-server/.env.example` 生成字段清单；聊天或工单中最多提供脱敏后的域名、端口、Node/systemd/Nginx 版本和配置键名，所有值只保留占位符。
2. 由有权限的部署人员通过受控 SSH/堡垒机登录正式服务器，在服务器上创建 `/etc/ai-xing/mcp.env`，写入真实的 Supabase URL 和 Publishable/Anon Key 以及本节规定的非秘密运行参数。
3. 写入后立即执行 `chown root:ai-xing /etc/ai-xing/mcp.env` 和 `chmod 600 /etc/ai-xing/mcp.env`；systemd 仅通过 `EnvironmentFile=/etc/ai-xing/mcp.env` 读取，禁止复制回代码目录。
4. 验收时只核对“文件存在、权限为 600、必需键存在、禁止键不存在、`MCP_REQUIRE_HTTPS=true`”等布尔结果，不打印值。若通过密码管理器或 Secret Manager 注入，也必须最终满足同样的文件权限和日志脱敏要求。

如需我协助核对配置，请发送脱敏模板（例如 `SUPABASE_URL=https://<project>.supabase.co`、`SUPABASE_PUBLISHABLE_KEY=<redacted>`）和键名/布尔检查结果，不要发送任何真实凭据。

## 8. systemd 准备

以 `deploy/systemd/ai-xing-mcp.service.example` 为模板。CentOS 7 使用 `[Unit]` 下的 `StartLimitInterval=60` 和 `StartLimitBurst=10`，服务使用：

```ini
Restart=always
RestartSec=5s
LimitNOFILE=65536
```

安装前只验证 unit：

```bash
systemd-analyze verify /etc/systemd/system/ai-xing-mcp.service
```

`Restart=always` 可处理进程正常退出和异常退出，但管理员执行 `systemctl stop` 后服务仍会保持停止。企业目标应定义为自动恢复、监控和告警，不承诺服务“不可停止”。`enable/start/restart` 只能在正式窗口授权后执行。

## 9. 正式库只读预检

本节必须由负责人确认目标确为正式库后执行，当前不得执行。只记录对象名、版本、数量、布尔状态和原因码，不记录业务正文或连接信息。

必须核验：

1. PostgreSQL 版本、当前数据库、当前角色和时区；
2. `tasks`、`departments`、`users`、`strategy` 的关键字段、RLS 和触发器；
3. MCP 函数签名、`SECURITY DEFINER` 的固定 `search_path`、owner 和 `authenticated` 权限；
4. `mcp_internal.schema_migrations` 的版本、顺序、状态和校验和；
5. release contract 的 release ID、manifest digest、required versions 和 deferred index 状态；
6. readiness 各标志与候选代码要求一致；
7. 修正后的只读复盘数据扫描结果、原因码和每条真实异常的处置决策；
8. 任务日期派生周预检的可修复数量、摘要、缺失/倒置/超长日期例外和历史复盘引用；
9. 数据规模、索引状态和迁移锁风险。

正式库未完成上述只读证据前，不得执行迁移。

## 10. 迁移与索引规则

`mcp-server/scripts/migrate.mjs` 中的 `MIGRATION_MANIFEST` 是唯一权威清单，当前共 32 项。执行规则：

- 先完成备份和恢复演练；
- 先核对候选制品 SHA-256 和 release digest；
- 事务迁移按 manifest 顺序执行；
- 已执行且同校验和版本返回 `skipped`；
- 顺序缺口、校验和变化、历史失败或 release contract 不一致立即停止；
- `2026-08-27_mcp_task_indexes.sql` 默认 deferred，只有单独评估和授权后才使用 include-indexes；
- `--adopt-existing` 只允许在历史对象逐项核验完全一致后单独授权，禁止用来掩盖失败；
- 迁移连接变量不得进入 MCP systemd 环境。

### 10.1 宝塔/CentOS 7 正式库迁移命令

以下命令应在宝塔面板的 **终端** 或受控 SSH 会话中执行，不能在 SQL Editor 中手工逐个粘贴迁移文件。`<release-root>`、`<candidate>`、备份路径和数据库目标必须由现场负责人替换并二次核对。

#### 1. 核对候选制品和运行时

```bash
export MCP_RELEASE_ROOT=/www/wwwroot/<site>/releases/<candidate>
cd "$MCP_RELEASE_ROOT/mcp-server"
node --version                 # 必须满足 mcp-server/package.json 的 Node >=20
npm --version
command -v psql
psql --version
sha256sum "$MCP_RELEASE_ROOT"/SHA256SUMS.json
```

正式库若使用 Supabase，迁移连接必须使用 Direct 或 Session Pooler 的 PostgreSQL 连接（通常为 5432，并启用 SSL），不要使用 Transaction Pooler 的 6543 端口；迁移器依赖同一会话中的 advisory lock 和事务。

#### 2. 以不回显方式建立一次性迁移会话

不要把连接串写进命令历史、`/etc/ai-xing/mcp.env`、systemd 或日志。下面的变量只在当前终端临时存在：

```bash
set +x
read -r -s -p '请输入正式 PostgreSQL 连接串（不会回显）: ' MCP_DB_URI_INPUT
printf '\n'
export MCP_MIGRATION_DATABASE_URL="$MCP_DB_URI_INPUT"
export PGDATABASE="$MCP_DB_URI_INPUT"
unset MCP_DB_URI_INPUT
```

MCP 服务仍只能使用公共 URL 和 Publishable/Anon Key；`MCP_MIGRATION_DATABASE_URL` 只给迁移器使用，严禁放入 MCP 运行环境。

#### 3. 正式库只读预检

先确认输出中的数据库、角色、时区和服务器版本确实是正式目标，再继续：

```bash
psql -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT current_database() AS database_name,
       current_user AS role_name,
       current_setting('TimeZone') AS timezone,
       current_setting('server_version') AS server_version;
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('tasks', 'departments', 'users', 'strategy')
ORDER BY table_name, ordinal_position;
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relrowsecurity,
       c.relforcerowsecurity
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('tasks', 'departments', 'users', 'strategy')
ORDER BY c.relname;
SELECT event_object_table, trigger_name, action_timing, event_manipulation
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table IN ('tasks', 'departments', 'users', 'strategy')
ORDER BY event_object_table, trigger_name;
SELECT p.oid::regprocedure AS function_signature,
       p.prosecdef AS security_definer,
       pg_get_userbyid(p.proowner) AS owner_name,
       p.proconfig AS configuration
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('mcp_get_readiness', 'mcp_update_pad_task',
                    'mcp_update_pad_task_scoped',
                    'mcp_update_pad_task_with_review_sync_scoped',
                    'get_current_user_task_users_for_tasks')
ORDER BY function_signature::text;
SELECT to_regclass('mcp_internal.schema_migrations') AS migration_ledger,
       to_regclass('mcp_internal.release_contracts') AS release_contract;
ROLLBACK;
SQL
```

如果 `migration_ledger` 已存在，再执行以下只读查询并核对版本、文件名、状态和 checksum；出现 `failed`、校验和不一致或后续版本已存在而前序缺失时立即停止：

```bash
psql -X -v ON_ERROR_STOP=1 -c \
  "SELECT version, file_name, status, source_kind, checksum FROM mcp_internal.schema_migrations ORDER BY applied_at, version"
```

执行只读历史复盘扫描，结果只包含对象 ID、JSON 路径和原因码：

```bash
umask 077
mkdir -p /var/backups/ai-xing
psql -X -v ON_ERROR_STOP=1 \
  -f "$MCP_RELEASE_ROOT/sql/2026-08-27_mcp_review_data_scan.sql" \
  > "/var/backups/ai-xing/review-data-scan-$(date +%Y%m%d-%H%M%S).txt"
```

修正后的扫描中，`REVIEW_PERIOD_KEY_INVALID`、`REVIEW_PERIOD_FORMAT_INVALID` 和 `REVIEWS_FORMAT_INVALID` 必须均为 0；出现任意复盘原因码时，先形成书面处置决定。预检和迁移均不得自动改写历史复盘。

再执行任务周期只读预检和 dry-run。输出只包含安全标识、日期、周、行版本、原因码、数量和摘要：

```bash
psql -X -v ON_ERROR_STOP=1 \
  -f "$MCP_RELEASE_ROOT/sql/preflight/2026-09-01_review_task_period_consistency.sql" \
  > "/var/backups/ai-xing/task-period-scan-$(date +%Y%m%d-%H%M%S).txt"

export MCP_BACKFILL_DATABASE_URL="$MCP_MIGRATION_DATABASE_URL"
set -o pipefail
node "$MCP_RELEASE_ROOT/mcp-server/scripts/backfill-task-period.mjs" \
  | tee "/var/backups/ai-xing/task-period-dry-run-$(date +%Y%m%d-%H%M%S).log"
MCP_PERIOD_DRY_RUN_STATUS=${PIPESTATUS[0]}
set +o pipefail
unset MCP_BACKFILL_DATABASE_URL
if [ "$MCP_PERIOD_DRY_RUN_STATUS" -ne 0 ]; then
  echo "任务周期 dry-run 失败，停止发布。" >&2
  unset MCP_PERIOD_DRY_RUN_STATUS MCP_MIGRATION_DATABASE_URL PGDATABASE MCP_RELEASE_ROOT
  exit 1
fi
unset MCP_PERIOD_DRY_RUN_STATUS
```

记录 `planned`、`exceptions` 和 `digest`。`exceptions` 必须为 0；任何 `MISSING_DATE`、`DATE_RANGE_INVALID` 或 `DATE_RANGE_TOO_LONG` 都必须先由业务负责人补齐/纠正日期并重新 dry-run，不能从旧周次推测日期。历史复盘引用单独审批，不在这个步骤自动移动或删除。

#### 4. 备份和恢复演练

若是自建 PostgreSQL，在独立备份目录执行（备份文件权限设为 600），并把恢复目标指定为隔离数据库，绝不能填正式库：

```bash
MCP_BACKUP_FILE="/var/backups/ai-xing/ai-xing-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --no-acl --file "$MCP_BACKUP_FILE"
chmod 600 "$MCP_BACKUP_FILE"
pg_restore --list "$MCP_BACKUP_FILE" > "$MCP_BACKUP_FILE.list"
chmod 600 "$MCP_BACKUP_FILE.list"
```

若是 Supabase 托管库，使用平台备份/恢复能力恢复到独立项目或隔离实例，完成抽样校验后再进入迁移窗口。没有可验证的备份和恢复结果，不得继续。

#### 5. 执行受控任务周回填

完成备份后，把正式库本次 dry-run 的数量和摘要人工二次核对。若 `planned=0`，跳过执行模式并再次 dry-run 确认 `planned=0`、`exceptions=0`；`planned` 大于 0 时才执行：

```bash
export MCP_BACKFILL_DATABASE_URL="$MCP_MIGRATION_DATABASE_URL"
read -r -p '请输入本次 dry-run 的 planned 数量: ' MCP_PERIOD_EXPECTED_COUNT
read -r -p '请输入本次 dry-run 的 digest: ' MCP_PERIOD_EXPECTED_DIGEST
node "$MCP_RELEASE_ROOT/mcp-server/scripts/backfill-task-period.mjs" \
  --execute \
  "--expected-count=$MCP_PERIOD_EXPECTED_COUNT" \
  "--expected-digest=$MCP_PERIOD_EXPECTED_DIGEST"
MCP_PERIOD_BACKFILL_STATUS=$?
unset MCP_BACKFILL_DATABASE_URL MCP_PERIOD_EXPECTED_COUNT MCP_PERIOD_EXPECTED_DIGEST
if [ "$MCP_PERIOD_BACKFILL_STATUS" -ne 0 ]; then
  echo "任务周回填失败或已回滚，停止发布。" >&2
  unset MCP_PERIOD_BACKFILL_STATUS
  exit 1
fi
unset MCP_PERIOD_BACKFILL_STATUS
```

回填器会锁定快照、验证两条既有任务保护触发器、在表锁事务内临时禁用并恢复这两条触发器，然后只按 ID、行版本、旧周和日期守卫更新 `target_weeks` 与 `row_version`。执行后必须再次 dry-run，结果必须为 `planned=0`、`exceptions=0`，否则禁止迁移。

#### 6. 执行受控迁移（首次不带任何可选参数）

确认前五步证据通过、已进入维护窗口后，在候选制品的 `mcp-server` 目录执行：

```bash
cd "$MCP_RELEASE_ROOT/mcp-server"
npm ci --omit=dev
set -o pipefail
npm run migrate 2>&1 | tee "/var/backups/ai-xing/mcp-migrate-$(date +%Y%m%d-%H%M%S).log"
MCP_MIGRATION_STATUS=${PIPESTATUS[0]}
set +o pipefail
if [ "$MCP_MIGRATION_STATUS" -ne 0 ]; then
  echo "迁移失败，停止后续操作。退出码：$MCP_MIGRATION_STATUS" >&2
  unset MCP_MIGRATION_DATABASE_URL PGDATABASE MCP_RELEASE_ROOT MCP_MIGRATION_STATUS
  exit "$MCP_MIGRATION_STATUS"
fi
```

首次执行不要添加 `--include-indexes` 或 `--adopt-existing`。正常首次结果是事务迁移按 manifest 顺序 `applied`，已存在且 checksum 相同的版本为 `skipped`，`2026-08-27_mcp_task_indexes` 为 `deferred`；迁移器随后记录 release contract。

#### 7. 迁移后核对

```bash
psql -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT version, file_name, status, source_kind, checksum
FROM mcp_internal.schema_migrations
ORDER BY applied_at, version;
SELECT release_id, manifest_digest, required_versions, deferred_indexes
FROM mcp_internal.release_contracts
WHERE release_id = '2026-09-01-task-date-weeks';
SELECT public.mcp_get_readiness();
SQL
```

必须同时满足：所有必需事务版本为 `success`，文件名和 checksum 与候选制品一致；`release_id` 为 `2026-09-01-task-date-weeks` 且 digest 为 `9061382fd04ea9deb77565a3c90ffb82f9e49a8da1a20a94000783604392bf5c`；readiness 返回 `status=ready`、`requiredMigrations=true`、`functionPrivileges=true`、`taskDateWeekFunction=true`、`taskDateWeekTrigger=true`、`taskPeriodDataConsistent=true`，OKR 和任务中心兼容标志为 true。`deferredIndexes` 为 `pending` 可以接受，索引是否执行必须另行评估。

迁移失败时只查询失败记录和安全错误码，禁止手工修改账本、删除失败记录或直接粘贴 SQL 重跑：

```bash
psql -X -v ON_ERROR_STOP=1 -c \
  "SELECT version, file_name, status, error_code FROM mcp_internal.schema_migrations WHERE status = 'failed' ORDER BY applied_at"
```

只有取得单独授权并完成锁竞争/性能评估后，才允许在同一候选制品上执行 `npm run migrate -- --include-indexes`。`--adopt-existing` 仅适用于只读预检已证明对象定义完全一致、但账本缺失的历史场景，不能用于绕过失败。

迁移和核对完成后清除一次性连接变量：

```bash
unset MCP_MIGRATION_DATABASE_URL PGDATABASE MCP_RELEASE_ROOT MCP_BACKUP_FILE MCP_MIGRATION_STATUS
```

## 11. 授权后的部署顺序

1. 冻结候选提交并通过第 4 节全部门禁；
2. 生成 allowlist 制品和 SHA-256 清单；
3. 完成 CentOS 7 运行时、端口、磁盘、Nginx 和 systemd 只读检查；
4. 完成正式库只读预检和真实复盘异常处置决策、任务周期零例外回填、备份和恢复演练；
5. 取得正式迁移独立授权；
6. 使用受控迁移器执行事务迁移并核对账本；
7. 单独决定 deferred 索引；
8. 部署制品和最小权限环境文件；
9. 授权安装/启用 systemd，验证本机 `/health` 和 `/ready`；
10. 验证 Nginx HTTPS、Session Header、长连接和 8787 公网隔离；
11. 使用批准的 Admin、Manager、Employee 账号验收权限，不运行写正式数据的自动 live smoke；
12. 全部证据通过后再创建正式发布标签。

## 12. 上线验收

### 12.1 进程和网络

- 开机后 systemd 自动启动；
- 模拟 Node 异常退出后 5 秒内进入恢复流程，启动限速生效；
- `/health` 正常，完整迁移后 `/ready` 为 ready；
- readiness 降级时，新 initialize 和已有 Session 请求都被拒绝；
- 8787 只监听 loopback，公网只通过 HTTPS `/mcp`；
- Nginx 正确转发 Host、Authorization、`Mcp-Session-Id` 和可信协议头；
- 日志能区分端口冲突、配置失败、停止信号、自然退出和 OOM。

### 12.2 数据和权限

- 32 项 manifest、release digest、成功状态和 deferred index 状态一致；
- 公司 2026 OKR 和产品部 Q3 OKR 在 `includeTasks=false/true` 下目标、KR 和任务槽位完整；
- 父、子、兄弟部门按现有只读权限可见，跨顶级部门树隔离；
- Admin 查询子部门成员任务与部门负责人/成员的合法可见集合一致；
- 父部门负责人可在管理子树创建和复盘，普通成员不能越权写入；
- KR 下标、任务字段、人员数组和复盘同步在网页、Node 和数据库边界一致拒绝非法值；
- 任务 `startDate/dueDate` 派生出的 ISO 周与 `targetWeeks` 完全一致，`2026-06-29` 至 `2026-07-05` 只出现在 `2026-W27`，不出现在 `2026-W39`；
- 历史复盘不会被预检、回填或迁移自动修复或覆盖。

### 12.3 安全和制品

- 两个生产依赖审计均为零漏洞；
- 制品摘要覆盖除摘要文件自身外的全部 allowlist 文件；
- 制品不含 `.env`、临时文件、未批准的诊断/回填/live smoke、日志或未知 SQL；任务周期回填器是唯一获准维护脚本；
- 服务进程没有高权限密钥或迁移连接变量；
- 日志和验收材料没有凭据、连接信息或完整业务载荷。

## 13. 失败与回滚

- 应用失败：切回上一份已验证制品，重新核对 `/health`、`/ready` 和 Nginx；不自动删除新增数据库对象。
- 事务迁移失败：停止后续版本，保留失败证据，核对事务回滚和账本，不手改成功状态。
- deferred 索引失败：记录已创建索引并人工评估，不盲目重跑。
- readiness 失败：保持 MCP fail-closed，先修复契约或依赖，不绕过门禁。
- 数据异常：保留原因码和 ID，走人工处置或书面接受，不自动改写历史复盘记录。

常驻服务排障命令只能在获得服务器操作授权后执行：

```bash
systemctl status ai-xing-mcp
journalctl -u ai-xing-mcp --since '30 minutes ago' --no-pager
ss -ltnp | grep ':8787'
curl --fail --silent http://127.0.0.1:8787/health
```

本文件定义的是上线前门禁，不构成正式库迁移授权或正式服务操作授权。
