# AI Xing 正式服部署前准备

> 文档状态：独立候选发布门禁。本文不继承历史部署文档中的完成结论。
>
> 目标平台：CentOS 7。未取得单独授权前，不连接正式库、不执行正式迁移或数据库写入，也不启动、停止或重启正式服务。

## 1. 当前结论

当前代码已完成本地层面的依赖、前端状态、任务校验、迁移契约、MCP readiness、范围查询失败关闭、仓储拆分、systemd 模板和 allowlist 打包加固。正式发布仍然被以下现场证据阻断：

1. 正式库身份、版本、时区、基线对象、RLS、触发器、函数签名和权限尚未只读核验；
2. 正式库迁移账本与本候选制品的 28 项 manifest、顺序、状态和 digest 尚未核验；
3. 历史扫描发现的 45 条 `REVIEW_PERIOD_KEY_INVALID` 尚未逐条修复或取得书面接受；
4. 正式库备份和恢复演练尚未完成；
5. 正式迁移尚未获得独立授权，也未执行迁移后验收；发布契约不一致时必须返回 `RELEASE_CONTRACT_MISMATCH` 并保持 fail-closed；
6. CentOS 7 目标机的 glibc、Node、systemd、Nginx、HTTPS、防火墙、重启恢复和角色验收尚未完成；
7. 最终冻结提交、正式发布标签和正式制品摘要尚未生成。

因此当前状态是“本地候选修复中/待最终门禁”，不是“允许上线”。

## 2. 发布边界

数据库基线固定为提交 `aab58c6`。候选发布提交不得写死在文档中，必须在干净工作区执行打包时由 Git 读取，并写入制品的 `SHA256SUMS.json`。

本次范围包括：

- 当前网页生产构建和安全扫描；
- MCP Node 服务、只读/写入工具、认证、Session、限流和 readiness；
- `mcp-server/scripts/migrate.mjs` manifest 中的 28 个 SQL 迁移；
- Nginx 和 CentOS 7 systemd 模板；
- allowlist 发布制品和 SHA-256 清单。

本次不包括第三、第四阶段、无关前端重构、临时诊断文件或未进入冻结提交的用户修改。

## 3. 不可违反的限制

- 文档、日志、命令输出、制品和提交中不得记录密码、JWT、Authorization、Refresh Token、密钥、数据库连接串或高权限配置。
- MCP 运行进程只允许使用 Supabase 公共 URL 和 Publishable/Anon Key。禁止注入 Service Role、Secret Key、数据库密码或迁移连接变量。
- 正式库先只读核验。迁移和任何写入必须另行授权。
- 迁移只通过受控迁移器执行，不在 SQL Editor 手工粘贴整批迁移。
- 不从脏工作区制作正式制品，不手工复制目录作为发布包。
- `local-test-files/`、`.env`、日志、诊断、回填和 live smoke 文件不得进入正式制品。
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
- 仅复制显式 allowlist 中的 `dist/`、MCP `src/`、运行依赖锁、迁移器、部署模板、本文和 manifest SQL；
- 生成只含相对路径、SHA-256 和候选提交号的 `SHA256SUMS.json`；
- 安全扫描失败时不得继续发布。

打包脚本不会包含 `.env`、`local-test-files/`、诊断脚本、回填脚本、live smoke、日志或 manifest 之外的 SQL。

## 5. 已实现的本地门禁

2026-09-01 当前候选工作区的本地证据如下。冻结提交生成后仍需再运行一次同样的门禁：

- `npm run lint:app`：通过，TypeScript 零错误；
- `npm run build:secure`：通过，40 个文本构建资产敏感模式扫描通过，仅保留既有大 chunk 警告；
- `npm run mcp:test`：281/281 通过；
- 根项目和 `mcp-server` 的生产依赖审计：均为 0 vulnerabilities；
- MCP `src/`、`scripts/` 和根发布脚本 `.mjs`：`node --check` 全部通过；
- `git diff --check`：通过；
- manifest/SQL 对齐：28 项，无缺失、无额外未登记 MCP 迁移；
- allowlist 打包测试：2/2 通过，测试目录已清理且未生成正式制品；
- 本轮未连接任何正式环境，未执行数据库迁移或写入，未启动、停止或重启服务。

已实现内容：

- 根项目生产依赖审计为零漏洞，Router 固定版本，未使用依赖和浏览器 Gemini 密钥注入已删除；
- `build:secure` 在生产构建后扫描敏感模式；
- 范围任务加载按 ID 合并全局状态，网页和 MCP 人员补全每批最多 50 个任务；
- 任务更新校验由前向 SQL 迁移统一覆盖，人员函数固定 `search_path` 和执行权限；
- manifest 为 28 项，发布契约保存 ordered required versions 和 digest；
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
7. 只读复盘数据扫描仍为 45 条、数量是否变化，以及每条异常的处置决策；
8. 数据规模、索引状态和迁移锁风险。

正式库未完成上述只读证据前，不得执行迁移。

## 10. 迁移与索引规则

`mcp-server/scripts/migrate.mjs` 中的 `MIGRATION_MANIFEST` 是唯一权威清单，当前共 28 项。执行规则：

- 先完成备份和恢复演练；
- 先核对候选制品 SHA-256 和 release digest；
- 事务迁移按 manifest 顺序执行；
- 已执行且同校验和版本返回 `skipped`；
- 顺序缺口、校验和变化、历史失败或 release contract 不一致立即停止；
- `2026-08-27_mcp_task_indexes.sql` 默认 deferred，只有单独评估和授权后才使用 include-indexes；
- `--adopt-existing` 只允许在历史对象逐项核验完全一致后单独授权，禁止用来掩盖失败；
- 迁移连接变量不得进入 MCP systemd 环境。

## 11. 授权后的部署顺序

1. 冻结候选提交并通过第 4 节全部门禁；
2. 生成 allowlist 制品和 SHA-256 清单；
3. 完成 CentOS 7 运行时、端口、磁盘、Nginx 和 systemd 只读检查；
4. 完成正式库只读预检、45 条异常处置决策、备份和恢复演练；
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

- 28 项 manifest、release digest、成功状态和 deferred index 状态一致；
- 公司 2026 OKR 和产品部 Q3 OKR 在 `includeTasks=false/true` 下目标、KR 和任务槽位完整；
- 父、子、兄弟部门按现有只读权限可见，跨顶级部门树隔离；
- Admin 查询子部门成员任务与部门负责人/成员的合法可见集合一致；
- 父部门负责人可在管理子树创建和复盘，普通成员不能越权写入；
- KR 下标、任务字段、人员数组和复盘同步在网页、Node 和数据库边界一致拒绝非法值；
- 45 条历史异常不会被自动修复或覆盖。

### 12.3 安全和制品

- 两个生产依赖审计均为零漏洞；
- 制品摘要覆盖除摘要文件自身外的全部 allowlist 文件；
- 制品不含 `.env`、临时文件、诊断/回填/live smoke、日志或未知 SQL；
- 服务进程没有高权限密钥或迁移连接变量；
- 日志和验收材料没有凭据、连接信息或完整业务载荷。

## 13. 失败与回滚

- 应用失败：切回上一份已验证制品，重新核对 `/health`、`/ready` 和 Nginx；不自动删除新增数据库对象。
- 事务迁移失败：停止后续版本，保留失败证据，核对事务回滚和账本，不手改成功状态。
- deferred 索引失败：记录已创建索引并人工评估，不盲目重跑。
- readiness 失败：保持 MCP fail-closed，先修复契约或依赖，不绕过门禁。
- 数据异常：保留原因码和 ID，走人工处置或书面接受，不自动改写 45 条历史记录。

常驻服务排障命令只能在获得服务器操作授权后执行：

```bash
systemctl status ai-xing-mcp
journalctl -u ai-xing-mcp --since '30 minutes ago' --no-pager
ss -ltnp | grep ':8787'
curl --fail --silent http://127.0.0.1:8787/health
```

本文件定义的是上线前门禁，不构成正式库迁移授权或正式服务操作授权。
