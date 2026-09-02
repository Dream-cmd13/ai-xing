# MCP 失败迁移受控恢复设计

## 1. 背景

当前本地 MCP 连接的测试库已有 26 条成功迁移，最新版本为 `2026-08-31_web_task_center_scoped_pagination`。默认迁移器执行 `2026-09-01_mcp_task_validation_and_people_security` 时因 PostgreSQL `42601` 停止。事务已回滚，验证函数和 release contract 表均未残留，但账本按设计保留了一条失败记录，MCP readiness 因缺少完整发布契约返回 `RELEASE_CONTRACT_MISMATCH`。

根因是 PL/pgSQL 条件中的 `CASE` 表达式没有括号，形成有歧义的 `END THEN`。本次只恢复当前测试库，不连接正式库，不执行 deferred 索引，不启停服务。

## 2. 选定方案

采用最小、带强校验的失败恢复：

1. 将数组长度判断改为带括号的 `> (CASE ... END) THEN`。
2. 增加 SQL 静态契约断言，防止该表达式退回无括号形式。
3. 由于该迁移 checksum 会变化，重新计算事务 manifest digest，并同步更新 Node release contract 与 SQL readiness 中的期望摘要。
4. 先在同一测试库的显式事务中执行修正后的迁移正文并回滚，证明 SQL 可解析且不会留下对象。
5. 将失败记录的版本、文件名、旧 checksum、错误码和回滚对象状态保存到 `local-test-files/`，不记录连接信息或业务数据。
6. 使用同一 advisory lock 执行受控账本恢复。只有以下条件全部满足才删除失败行：
   - 目标版本、文件名、旧 checksum、`status=failed`、`error_code=42601` 完全匹配；
   - 既有 26 条记录全部成功，且没有该版本之后的成功迁移；
   - `mcp_validate_task_changes(jsonb,boolean)` 与 `mcp_internal.release_contracts` 均不存在；
   - `DELETE ... RETURNING` 恰好返回一行。
7. 重新运行默认迁移器，不使用 `--include-indexes` 或 `--adopt-existing`。迁移器应跳过既有版本，应用两个 2026-09-01 事务迁移并记录 release contract。

## 3. 验证与成功条件

- 针对 SQL 契约与迁移器的自动化测试通过。
- 修正后的迁移正文可以在 PostgreSQL 事务中完整执行并回滚。
- 迁移账本没有失败记录，28 个 manifest 版本均为成功；既有 deferred/include-indexes 状态不被改变。
- release contract 的 ID、manifest digest、required versions 和函数权限与当前代码完全一致。
- `/health` 返回 200，`/ready` 在缓存过期后返回 200。
- 未认证的 `/mcp` initialize 请求返回认证错误而不是 503，证明协议入口已越过 readiness 门禁。
- 不重启 MCP；Trae 旧 Session 由客户端重新初始化。

## 4. 失败处理

任何守卫条件不满足、事务回滚验证失败、摘要不一致或迁移再次失败时立即停止。不得批量删除账本、把失败状态手工改成成功、绕过 release contract、执行 deferred 索引或把迁移连接变量注入 MCP 进程。
