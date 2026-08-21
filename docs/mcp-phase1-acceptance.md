# 第一阶段公网 MCP 验收记录

## 1. 阶段范围

本阶段只验收：

- 现有域名 `/mcp`；
- Basic Auth 系统账号密码认证；
- Supabase 用户 JWT 和 RLS；
- MCP Session 和 Token 刷新；
- 五个只读工具；
- 限流、HTTPS 检查、日志脱敏；
- 部署、使用和回滚文档。

本阶段不验收任何写入工具、KR 结构化迁移、Redis、OAuth 或主动推送。

## 2. 自动化测试证据

| 测试 | 命令 | 当前状态 |
|---|---|---|
| MCP 独立测试 | `npm run mcp:test` | 通过：58项测试全部通过 |
| 官方 MCP Client 协议测试 | 包含在 `npm run mcp:test` | 通过：初始化、工具发现、工具调用、Session终止 |
| MCP 源码语法检查 | `node --check` 遍历 `src/` 和 `scripts/` | 通过 |
| MCP 依赖安全扫描 | `npm audit --omit=dev --registry=https://registry.npmjs.org` | 通过：0个已知漏洞 |
| 本地真实进程健康检查 | `npm start` 后请求 `http://127.0.0.1:8787/health` | 通过 |
| 前端构建回归 | `npm run build` | 通过；保留现有大 chunk 警告 |
| TypeScript 检查 | `npm run lint` | 未通过：现有 `ProcessView.tsx`、`StrategyView.tsx`、`WeeklyView.tsx` 存在既有类型错误，本阶段未修改这些文件 |
| 只读边界扫描 | 见第6节 | 通过：MCP生产代码未发现高权限密钥或 Supabase 写操作 |
| 进程环境隔离 | `config.test.mjs`、`runtime.test.mjs` | 通过：不读取项目根 `.env`，发现高权限密钥时拒绝启动 |
| 大结果兼容性 | `tools.test.mjs` | 通过：Text Content 不再重复 Structured Content，避免组织数据被重复放大 |
| 任务批量读取兼容性 | `repository.test.mjs` | 通过：周 PAD 和任务搜索复用网站现有 `get_visible_tasks_full` 权限 RPC，RPC 缺失时才回退直接查询 |
| TRAE 文本结果兼容性 | `tools.test.mjs` | 通过：五个只读工具均返回紧凑业务摘要，同时保留完整 `structuredContent` |

## 3. TRAE 人工验收

以下项目必须在部署到真实服务器后由用户完成：

- [ ] TRAE 能连接 `https://现有域名/mcp`；
- [ ] TRAE 能看到且只看到5个第一阶段工具；
- [ ] `get_organization_info` 返回网站中可见的组织信息；
- [ ] `get_department_weekly_pad` 返回正确部门和周次；
- [ ] `search_pad_tasks` 的状态和标题筛选正确；
- [ ] `get_personal_workbench` 只能返回当前账号工作台；
- [ ] `get_process_sipoc` 返回流程节点和连线；
- [ ] 现有网站和 Flask API 不受影响。

## 4. 真实账号权限矩阵

| 场景 | Admin | Manager | Employee | 当前状态 |
|---|---:|---:|---:|---|
| 正确密码连接 | 应成功 | 应成功 | 应成功 | 等待真实账号 |
| 错误密码连接 | 应失败 | 应失败 | 应失败 | 等待真实账号 |
| 查看个人工作台 | 本人数据 | 本人数据 | 本人数据 | 等待真实账号 |
| 查看授权部门任务 | 按RLS | 按RLS | 按RLS | 等待真实账号 |
| 查看非授权敏感任务 | 按RLS | 应拒绝/空结果 | 应拒绝/空结果 | 等待真实账号 |
| 调用写工具 | 不存在 | 不存在 | 不存在 | 等待真实 TRAE |

真实测试命令：

```bash
MCP_TEST_URL=https://现有域名/mcp \
MCP_TEST_USERNAME=角色测试账号 \
MCP_TEST_PASSWORD=角色测试密码 \
npm run mcp:test:live
```

三个角色必须分别执行，禁止在文档中记录真实密码或 Authorization Header。

## 5. 安全验收

- [ ] 公网 HTTP 被跳转到 HTTPS 或拒绝；
- [ ] 8787端口没有直接开放公网；
- [ ] 连续错误连接触发429；
- [ ] 日志不包含密码；
- [ ] 日志不包含 Authorization Header；
- [ ] 日志不包含 Supabase JWT 或 Refresh Token；
- [ ] MCP 环境中没有 Service Role Key 或 Secret Key；
- [ ] MCP 启动日志确认未因高权限环境变量而拒绝启动；
- [ ] 项目 Git 文件中没有真实个人 TRAE Header。

## 6. 只读边界扫描

检查生产数据访问代码中没有 Supabase 写操作和高权限密钥：

```powershell
Get-ChildItem mcp-server/src -File | Select-String -Pattern 'service_role|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|\.insert\(|\.update\(|\.upsert\('
```

允许出现 `Map.delete()` 形式的内存会话清理；不得出现 `supabase.from(...).delete()`。

## 7. 已知限制

- 单实例内存 Session；
- MCP 服务重启后需要重新连接；
- Basic Header 是密码等价物；
- 当前阶段不提供写入能力；
- 线上 HTTPS、Nginx、TRAE 和三类真实账号测试必须由实际部署环境证明。
- 项目现有 `npm run lint` 基线未通过；错误位于本阶段未修改的 React 组件，不能用第一阶段 MCP 测试替代其后续治理。

## 8. 验收结论

当前结论：**第一阶段代码开发和本地自动化验证已完成，等待用户部署到真实服务器并完成 TRAE、HTTPS、日志和三类真实账号验收。**

只有全部必测项通过后，用户才能回复：

```text
第一阶段验收通过，同意开始第二阶段
```

在此之前不得开始第二阶段。
