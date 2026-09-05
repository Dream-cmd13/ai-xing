# 普通员工在 OKR 执行页创建任务 Implementation Plan

> **For agentic workers:** 逐项执行本计划；本次用户明确要求不提交代码。

**Goal:** 恢复普通员工在自己部门相关 OKR 看板创建本人任务的能力，同时保持部门长和管理员现有范围。

**Architecture:** 将执行页的创建范围与落库部门选择提取为无状态 JavaScript 策略函数，由 `ExecutionView` 传入已有的菜单权限、角色和部门范围判断结果。普通员工只能写入自己的部门并以自己为负责人；部门长和管理员继续使用所选且有管理权限的部门。

**Tech Stack:** React、TypeScript、Node.js `node:test`

---

### Task 1: 增加创建范围回归测试

**Files:**
- Create: `local-test-files/executionTaskCreation.test.mjs`

- [ ] 覆盖普通员工本部门/上级展示节点、无菜单权限、无关部门、部门长管理树、管理员以及最终写入部门的行为。
- [ ] 运行 `node --test local-test-files/executionTaskCreation.test.mjs`，确认实现前因模块不存在而失败。

### Task 2: 实现并接入权限策略

**Files:**
- Create: `utils/executionTaskCreation.js`
- Modify: `components/ExecutionView.tsx`

- [ ] 实现纯函数 `canCreateExecutionTaskForScope` 和 `resolveExecutionTaskCreationDepartmentId`。
- [ ] 将执行页创建按钮、创建弹窗初始数据和保存前部门归属接入策略函数。
- [ ] 保持普通员工负责人强制为本人，部门长和管理员现有负责人范围不变。

### Task 3: 验证

- [ ] 运行 `node --test local-test-files/executionTaskCreation.test.mjs`，预期全部通过。
- [ ] 运行 `npm run lint:app`，预期 TypeScript 无错误。
- [ ] 运行 `npm run build`，预期生产构建成功。
- [ ] 检查 `git diff --check` 和 `git status --short`，不提交代码。
