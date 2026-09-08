# MCP 输出契约与登录错误提示修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 MCP 现有响应字段、不修改 OKR 数据的前提下修复输出 Schema 漂移，并为管理员错误登录提供持久、脱敏、可访问的表单提示。

**Architecture:** MCP 读取工具使用独立模块维护唯一输出契约，真实分支必须通过官方 MCP SDK 的 `tools/list → callTool` 校验。登录页使用专用登录错误映射与持久表单状态，成功 Toast 与失败反馈分离。

**Tech Stack:** Node.js 20+、MCP SDK 1.30、Zod 4、React 19、TypeScript 5.8、Supabase JS 2.105、Playwright 1.60。

---

## 文件结构

- Create: `mcp-server/src/read-tool-output-schemas.mjs` — 九个 MCP 只读工具输出契约的唯一来源。
- Modify: `mcp-server/src/tools.mjs` — 引用集中契约，不再内联声明输出结构。
- Modify: `mcp-server/test/protocol.integration.test.mjs` — 使用真实返回形状覆盖部门 OKR 和任务搜索三类分支。
- Modify: `mcp-server/test/tools.test.mjs` — 校验受影响工具公开字段完整。
- Modify: `utils/userFacingError.ts` — 增加登录专用、安全的错误分类函数。
- Modify: `components/LoginView.tsx` — 增加持久表单错误、焦点恢复和无障碍关联。
- Modify: `local-test-files/e2e-tests/tests/login.spec.ts` — 模拟 Auth 400/429，验证错误显示和清除。
- Modify: `local-test-files/e2e-tests/package.json` — 提供可重复执行的 Playwright 命令。
- Modify: `docs/管理员网页功能测试执行记录.md` — 记录管理员错误登录复测。
- Modify: `docs/部门长网页功能测试执行记录.md` — 记录 MCP Schema 复测。
- Modify: `docs/普通用户网页功能测试执行记录.md` — 记录 MCP Schema 复测。

### Task 1: 用真实响应形状复现 MCP 契约失败

**Files:**
- Modify: `mcp-server/test/protocol.integration.test.mjs:42`
- Modify: `mcp-server/test/tools.test.mjs:34`

- [ ] **Step 1: 让协议测试假仓储返回生产字段**

将部门 OKR 假响应补充 `limit`，并让任务搜索覆盖基础、部门和人员分支：

```js
searchPadTasks: async ({ departmentId, departmentName, scope, userName, limit, offset }) => {
  const page = {
    tasks: [], offset, limit, total: 0, hasMore: false, nextCursor: null, truncated: false,
  };
  if (userName) {
    return {
      user: { name: userName, role: 'Employee', departmentId: 'dept-1', departmentName: departmentName ?? '部门一' },
      ...page,
    };
  }
  if (departmentId || departmentName) {
    return {
      departmentId: departmentId ?? 'dept-1',
      departmentName: departmentName ?? '部门一',
      scope: scope === 'auto' ? 'subtree' : scope,
      ...page,
    };
  }
  return page;
},
getDepartmentOkrs: async ({ year, period, limit }) => ({
  year, period: period ?? null, departmentCount: 1, hasMore: false, limit,
  departments: [{
    id: 'dept-1', name: '部门一', managerName: '张三', parentName: null,
    periods: { Annual: [{ id: 'okr-1', objective: '年度目标', keyResults: ['KR一'], krCount: 1, truncated: false, krTasks: [] }] },
  }],
}),
```

- [ ] **Step 2: 通过官方 SDK 调用全部受影响分支**

在 `listTools()` 后增加：

```js
const departmentTasks = await client.callTool({
  name: 'search_pad_tasks',
  arguments: { departmentId: 'dept-1', scope: 'subtree', limit: 5 },
});
assert.equal(departmentTasks.isError, false);
assert.equal(departmentTasks.structuredContent.departmentId, 'dept-1');

const userTasks = await client.callTool({
  name: 'search_pad_tasks',
  arguments: { userName: '张三', departmentName: '部门一', relation: 'owner', limit: 5 },
});
assert.equal(userTasks.isError, false);
assert.equal(userTasks.structuredContent.user.name, '张三');
```

将部门 OKR 调用参数补充 `limit: 5`，并断言 `structuredContent.limit === 5`。

- [ ] **Step 3: 增加公开 Schema 字段测试**

```js
const departmentOkrOutput = tools.get('get_department_okrs').definition.outputSchema;
assert.ok('limit' in departmentOkrOutput);

const searchOutput = tools.get('search_pad_tasks').definition.outputSchema;
for (const key of ['departmentId', 'departmentName', 'scope', 'user']) {
  assert.ok(key in searchOutput);
}
```

- [ ] **Step 4: 运行测试并确认修复前失败**

Run:

```powershell
node --test mcp-server/test/tools.test.mjs mcp-server/test/protocol.integration.test.mjs
```

Expected: FAIL；部门 OKR 报未声明 `limit`，或任务搜索报未声明范围字段。

- [ ] **Step 5: 提交失败测试**

```powershell
git add -- mcp-server/test/tools.test.mjs mcp-server/test/protocol.integration.test.mjs
git commit -m "test: 复现MCP输出契约不一致"
```

### Task 2: 建立 MCP 输出契约单一来源并修复 Schema

**Files:**
- Create: `mcp-server/src/read-tool-output-schemas.mjs`
- Modify: `mcp-server/src/tools.mjs:1`

- [ ] **Step 1: 创建集中输出契约**

新模块必须导出以下结构，并保留其余只读工具现有字段：

```js
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());
const taskListOutput = { tasks: z.array(recordSchema) };
const scopeSchema = z.enum(['auto', 'exact', 'subtree']);
const pageInfoSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
});

export const readToolOutputSchemas = Object.freeze({
  getOrganizationInfo: {
    strategy: recordSchema.nullable(),
    departments: z.array(recordSchema),
    businesses: z.array(recordSchema),
  },
  getDepartmentPeople: {
    departmentId: z.string(),
    departmentName: z.string().nullable(),
    scope: z.enum(['exact', 'subtree']),
    people: z.array(recordSchema),
    hasMore: z.boolean(),
  },
  getDepartmentWeeklyPad: {
    departmentId: z.string(),
    departmentName: z.string().optional(),
    scope: scopeSchema.optional(),
    weekId: z.string(),
    limit: z.number(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    truncated: z.boolean(),
    ...taskListOutput,
  },
  searchPadTasks: {
    ...taskListOutput,
    offset: z.number(),
    limit: z.number(),
    total: z.number().nullable(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    truncated: z.boolean(),
    departmentId: z.string().optional(),
    departmentName: z.string().nullable().optional(),
    scope: scopeSchema.optional(),
    user: z.object({
      name: z.string(),
      role: z.string(),
      departmentId: z.string().nullable(),
      departmentName: z.string().nullable(),
    }).optional(),
  },
  getWeeklyReviewGaps: {
    weekId: z.string(), groups: z.array(recordSchema), total: z.number(),
    limit: z.number(), offset: z.number(), hasMore: z.boolean(),
  },
  getCompanyOkrs: {
    year: z.number().nullable(), okrCount: z.number(), okrs: z.array(recordSchema),
  },
  getDepartmentOkrs: {
    year: z.number().nullable(), period: z.string().nullable(), departmentCount: z.number(),
    hasMore: z.boolean(), limit: z.number().int().min(1).max(50), departments: z.array(recordSchema),
  },
  getPersonalWorkbench: {
    userId: z.string(), limit: z.number(), currentWeekId: z.string().optional(), nextWeekId: z.string().optional(),
    todayTasks: z.array(recordSchema), thisWeekTasks: z.array(recordSchema), nextWeekTasks: z.array(recordSchema),
    pageInfo: z.object({ today: pageInfoSchema, thisWeek: pageInfoSchema, nextWeek: pageInfoSchema }),
    ...taskListOutput,
  },
  getProcessSipoc: { limit: z.number(), processes: z.array(recordSchema) },
});
```

- [ ] **Step 2: 在工具注册中引用集中契约**

`tools.mjs` 增加：

```js
import { readToolOutputSchemas } from './read-tool-output-schemas.mjs';
```

九处 `outputSchema` 分别替换为对应导出项，并删除只为输出 Schema 服务的本地 `recordSchema`、`taskListOutput`。

- [ ] **Step 3: 运行聚焦测试**

```powershell
node --test mcp-server/test/tools.test.mjs mcp-server/test/protocol.integration.test.mjs
```

Expected: PASS，官方 SDK 能读取 `limit`、部门上下文和人员上下文。

- [ ] **Step 4: 运行 MCP 全量测试**

```powershell
npm --prefix mcp-server test
```

Expected: 316 项原有测试加新增测试全部 PASS，无 FAIL。

- [ ] **Step 5: 提交 MCP 修复**

```powershell
git add -- mcp-server/src/read-tool-output-schemas.mjs mcp-server/src/tools.mjs
git commit -m "fix: 统一MCP读取工具输出契约"
```

### Task 3: 用浏览器测试锁定登录失败体验

**Files:**
- Modify: `local-test-files/e2e-tests/tests/login.spec.ts`
- Modify: `local-test-files/e2e-tests/package.json`

- [ ] **Step 1: 启用 Playwright 测试命令**

```json
"scripts": {
  "test": "playwright test"
}
```

- [ ] **Step 2: 增加错误凭据拦截测试**

```ts
test('shows a persistent sanitized error when authentication rejects credentials', async ({ page }) => {
  await page.route('**/auth/v1/token?grant_type=password', async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'invalid_credentials', msg: 'Invalid login credentials' }),
    });
  });
  await page.goto('/login');
  await page.getByLabel('登录账号').fill('invalid-user');
  await page.getByLabel('登录密码').fill('invalid-password');
  await page.getByRole('button', { name: '验证身份并进入' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('账号或密码错误，请重新输入');
  await page.waitForTimeout(3200);
  await expect(alert).toBeVisible();

  await page.getByLabel('登录密码').fill('changed-password');
  await expect(alert).toHaveCount(0);
});
```

- [ ] **Step 3: 增加 429 脱敏测试**

模拟 HTTP 429 和英文限流消息，断言只显示“登录尝试过于频繁，请稍后再试”。

- [ ] **Step 4: 启动本地网页并确认修复前失败**

```powershell
npm run dev -- --host 127.0.0.1 --port 3001
```

另一个终端执行：

```powershell
Set-Location local-test-files/e2e-tests
npm test -- --project=chromium tests/login.spec.ts
```

Expected: FAIL；页面不存在持久的 `role=alert` 错误区域。

### Task 4: 实现安全、持久的登录错误状态

**Files:**
- Modify: `utils/userFacingError.ts:1`
- Modify: `components/LoginView.tsx:1`

- [ ] **Step 1: 增加登录专用错误映射**

```ts
const getErrorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.trim().toLowerCase() : '';
};

const getErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
};

export const getLoginUserFacingError = (error: unknown): string => {
  const code = getErrorCode(error);
  const status = getErrorStatus(error);
  const message = getErrorMessageText(error).trim().toLowerCase();

  if (status === 429 || code.includes('rate_limit') || message.includes('rate limit') || message.includes('too many requests')) {
    return '登录尝试过于频繁，请稍后再试';
  }
  if (
    status === 400 ||
    ['invalid_credentials', 'email_not_confirmed'].includes(code) ||
    message.includes('invalid login credentials') ||
    message.includes('email not confirmed')
  ) {
    return '账号或密码错误，请重新输入';
  }
  if (
    message.includes('failed to fetch') || message.includes('network error') ||
    message.includes('network request failed') || message.includes('fetch failed')
  ) {
    return '网络异常，请检查网络连接后重试';
  }
  return '登录失败，请稍后重试';
};
```

- [ ] **Step 2: 增加登录表单错误状态**

`LoginView.tsx` 使用 `useRef`、`loginError` 和密码输入引用；提交失败时调用 `setLoginError(getLoginUserFacingError(error))`，空输入设置“请输入用户名和密码”，成功时清空错误。

- [ ] **Step 3: 渲染可访问错误区域**

```tsx
{loginError && (
  <div
    id="login-form-error"
    role="alert"
    aria-live="assertive"
    className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"
  >
    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <span>{loginError}</span>
  </div>
)}
```

账号和密码输入框增加稳定的 `id`，标签使用 `htmlFor` 关联；错误存在时设置 `aria-invalid="true"`，并通过 `aria-describedby="login-form-error"` 关联提示。

- [ ] **Step 4: 运行类型检查与生产构建**

```powershell
npm run lint
npm run build
```

Expected: 两条命令均为 exit code 0。

- [ ] **Step 5: 运行登录 E2E**

```powershell
Set-Location local-test-files/e2e-tests
npm test -- --project=chromium tests/login.spec.ts
```

Expected: 错误凭据和 429 用例 PASS，错误超过三秒仍可见，输入变化后清除。

- [ ] **Step 6: 提交登录修复**

```powershell
git add -- components/LoginView.tsx utils/userFacingError.ts
git commit -m "fix: 增强登录失败提示与脱敏处理"
```

`local-test-files/e2e-tests` 按项目规则保持为本地回归资产，不强制加入 Git；其修改用于本轮可重复验证和保留本地证据。

### Task 5: 最终回归与测试记录闭环

**Files:**
- Modify: `docs/管理员网页功能测试执行记录.md`
- Modify: `docs/部门长网页功能测试执行记录.md`
- Modify: `docs/普通用户网页功能测试执行记录.md`

- [ ] **Step 1: 执行最终自动化门禁**

```powershell
npm --prefix mcp-server test
npm run lint
npm run build
```

Expected: 全部 exit code 0；MCP 测试数量不少于原有 316 项。

- [ ] **Step 2: 执行三个角色 MCP 真实回归**

凭据通过交互输入，不写入文件或命令历史。每个角色执行 `tools/list` 后调用 `get_department_okrs` 和 `search_pad_tasks`，确认不再出现 `-32602`，且字段和值与修复前原始响应一致。

- [ ] **Step 3: 执行管理员网页错误登录复测**

使用错误凭据验证持久错误，再使用正确凭据验证正常登录。截图不得包含密码、Token、Session 或 Authorization。

- [ ] **Step 4: 更新三份执行记录**

只更新本次两个缺陷的复测日期、结果和证据；不得改写 OKR 数据质量、跨部门权限、限流及其他未处理项的状态。

- [ ] **Step 5: 检查没有 OKR 数据改动或凭据泄漏**

```powershell
git diff --check
git diff --name-only
rg -n -S "888888|Authorization:|Bearer |confirmationToken" docs mcp-server/src components utils local-test-files/e2e-tests
```

Expected: 修改文件中没有凭据；不存在 SQL、迁移或 OKR 数据文件改动。

- [ ] **Step 6: 提交复测记录**

```powershell
git add -- docs/管理员网页功能测试执行记录.md docs/部门长网页功能测试执行记录.md docs/普通用户网页功能测试执行记录.md
git commit -m "docs: 记录MCP契约与登录提示复测结果"
```

## 完成定义

- 所有新增和原有测试通过。
- 官方 MCP SDK 能消费真实部门 OKR、部门任务和人员任务响应。
- 登录 400/429 显示持久、脱敏、可访问的表单错误。
- MCP 响应字段没有删除或改名。
- 没有数据库迁移、OKR 数据改动或权限行为变更。
- 三份角色测试记录只更新本次修复项。
