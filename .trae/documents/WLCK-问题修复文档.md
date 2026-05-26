# WLCK 问题修复文档

## 文档目标

本文档基于已完成的 3 轮测试结果，给出当前 WLCK 的主要问题、根因判断、修复方案、建议改动点和回归验证项，供开发按优先级落地修复。

## 当前仓库复核结论

> 复核时间：2026-05-26  
> 当前仓库路径：`d:\aixing\okr-ai`

本次基于当前代码复核后，文档结论需要做如下修正：

| 问题 | 文档原判断 | 当前代码复核结果 | 本轮处理 |
|------|------|------|------|
| Bug #002 新建任务误入编辑态 | 存在 | **仍然存在，且不止 `/task-center`**。`TaskCenterView`、`WorkbenchView` 仍存在创建态误传编辑态的问题 | 本轮修复 |
| Bug #003 任务并发保存静默失败 | 存在 | **当前代码已基本修复**。`updateTask()` 已抛出明确冲突消息，`persistTaskEntries()` 已做回滚并向上抛错，页面已有错误提示链路 | 本轮只保留结论修正，不重复改造 |
| Bug #004 Tailwind CDN 生产告警 | 存在 | **仍然存在**。`index.html` 依然直接加载 `cdn.tailwindcss.com` | 本轮修复 |
| Bug #005 `npm run lint` 失败 | 存在 | **仍然存在**。`lint` 仍直接跑 `tsc --noEmit`，且未隔离 `supabase/functions` | 本轮修复 |

### 本轮执行策略

1. 先修正文档与当前仓库实际状态不一致的问题
2. 再按当前代码真实问题执行修复
3. 最后用 `diagnostics`、`npm run lint`、`npm run build` 回归验证

### 路径说明

文档中部分 `D:/WLCK/...` 路径为历史测试产物引用，不代表当前仓库真实路径；本轮开发与回归以 `d:\aixing\okr-ai` 为准。

关联资料：
- [WLCK-Bug记录表.md](D:/WLCK/qa-artifacts/reports/WLCK-Bug记录表.md)
- [WLCK-测试总结报告.md](D:/WLCK/qa-artifacts/reports/WLCK-测试总结报告.md)
- [WLCK-多轮对比分析.md](D:/WLCK/qa-artifacts/reports/WLCK-多轮对比分析.md)

---

## 修复优先级

| 优先级 | 问题 | 影响 |
|------|------|------|
| P1 | Bug #002 新建任务误入编辑态 | 核心任务录入交互错误 |
| P2 | Bug #004 Tailwind CDN 生产告警 | 发布形态不规范，影响稳定性 |
| P2 | Bug #005 `npm run lint` 失败 | 工具链不可用，影响持续集成 |



## Bug #002 新建任务误入编辑态

### 现象

- 页面：`/task-center`
- 操作：点击“新增任务”
- 结果：弹窗显示“删除任务 / 保存更改”，而不是“存草稿 / 提交 / 提交并继续下一条”

### 直接证据

- [components/TaskCenterView.tsx](D:/WLCK/ai-xing/components/TaskCenterView.tsx:401) 点击“新增任务”时，确实构造了一条新任务数据
- 但 [components/TaskCenterView.tsx](D:/WLCK/ai-xing/components/TaskCenterView.tsx:586) 传给 `TaskModal` 的 `isEditing` 被硬编码为 `true`

### 根因判断

新建态与编辑态的判定逻辑写死了，导致所有弹窗都按“编辑任务”渲染。

也就是说：
- 数据层面虽然在创建新对象
- 视图层面却强制走编辑态按钮集

### 解决方案

#### 方案 A：按是否已有持久化记录判断 `isEditing`

推荐做法：

1. 打开新建弹窗时传入 `isEditing={false}`
2. 打开已有任务时传入 `isEditing={true}`
3. 不要依赖“有无 id”判断，因为当前新建任务在打开弹窗前就先生成了临时 id

可选实现方式：
- 在 `taskModal` 状态里新增 `mode: 'create' | 'edit'`
- `TaskModal` 改用 `mode` 决定按钮集，而不是只靠 `isEditing`

#### 方案 B：以 `padId/index/来源入口` 区分

也能做，但可维护性差。因为同一弹窗会从 `TaskCenterView`、`WorkbenchView`、`ExecutionView` 等多个入口进入，统一显式 `mode` 更清晰。

### 建议改动点

- [components/TaskCenterView.tsx](D:/WLCK/ai-xing/components/TaskCenterView.tsx:401)
- [components/TaskCenterView.tsx](D:/WLCK/ai-xing/components/TaskCenterView.tsx:586)
- [components/TaskModal.tsx](D:/WLCK/ai-xing/components/TaskModal.tsx:433)

建议把 `TaskModal` 的接口从：

```ts
isEditing: boolean
```

改成：

```ts
mode: 'create' | 'edit'
```

### 验收标准

1. 点击“新增任务”后只能看到创建态按钮
2. 创建态不显示“删除任务”
3. 已有任务打开后显示“保存更改 / 删除任务”
4. 创建态提交后任务可正常进入列表
5. 编辑态保存不会影响创建态按钮逻辑

### 回归测试项

1. `/task-center` 新建任务
2. `/task-center` 编辑任务
3. 若 `WorkbenchView`、`ExecutionView`、`WeeklyView` 也复用 `TaskModal`，必须逐页验证

---

## Bug #003 任务并发保存静默失败

> 当前仓库复核结论：**该问题在当前代码中已基本关闭，不再作为本轮主修项。**

### 现象

- 页面：`/task-center`
- 场景：两个会话同时打开同一任务，A 先保存，B 后保存
- 结果：数据库只保留 A 的修改；B 不落库，但没有错误提示、没有冲突提示、没有回滚提示

### 直接证据

- [data.ts](D:/WLCK/ai-xing/data.ts:797) 更新任务时确实带了 `.eq('row_version', currentRowVersion)`，说明数据库层已经做了乐观锁
- [hooks/useAppActions.ts](D:/WLCK/ai-xing/hooks/useAppActions.ts:82) 的 `persistTaskEntries` 只负责 optimistic update、调用 `updateDbTask`、失败回滚
- 实测第 2 次保存后数据库 `row_version` 只增长到 1，标题保留为 A 版本，但 B 没有任何可感知反馈

### 根因判断

数据库层的乐观锁在工作，但前端冲突反馈链路没有闭合。

可能问题在两层：
1. `updateDbTask` 抛出的冲突错误没有被正确映射成用户可读消息
2. 页面 toast / backend error / modal 状态没有在冲突时显示给用户

对比部门保存逻辑可见：
- 部门有 `applyDepartmentPatch / hasDepartmentPatchConflict`
- 任务没有对应的 rebase 或冲突提示流程

### 当前代码复核说明

当前仓库中已经存在以下修复迹象：

1. `data.ts` 的 `updateTask()` 在 `!data` 时会抛出“任务已被其他人修改，请先刷新最新数据后再重试”
2. `useAppActions.ts` 的 `persistTaskEntries()` 失败时会回滚本地 optimistic state
3. `TaskCenterView`、`WeeklyView`、`ReviewView` 等入口会在 `catch` 中显示错误通知

因此，文档原始描述的“静默失败”已不完全符合当前代码现状。后续如果还要增强，可继续做任务级 patch/rebase，但不再作为本轮阻断项。

### 解决方案

#### 方案 A：先补“明确失败提示 + 数据回滚”

这是最低可接受修法。

落地要求：
1. `updateDbTask` 返回 `!data` 时抛出的冲突错误，必须被标准化成固定错误码或固定消息
2. `persistTaskEntries` 捕获冲突时：
   - 回滚本地 optimistic state
   - 关闭 saving 状态
   - 弹出明确 toast，例如“任务已被其他人修改，请刷新后重试”
   - 保留弹窗并提示用户重新加载

#### 方案 B：补任务级 rebase / merge 逻辑

适合后续增强，但优先级低于“先别静默失败”。

如果任务字段允许局部合并，可参考部门保存逻辑：
- 比较 lastSavedTask 与 latestTask
- 仅对本地修改字段进行 patch
- 非同字段冲突时可自动重放
- 同字段冲突时弹冲突提示

### 建议改动点

- [hooks/useAppActions.ts](D:/WLCK/ai-xing/hooks/useAppActions.ts:82)
- [data.ts](D:/WLCK/ai-xing/data.ts:797)
- [utils/taskSyncState.js](D:/WLCK/ai-xing/utils/taskSyncState.js:1)

建议新增：
- `buildTaskConflictError`
- `hasTaskPatchConflict`
- `applyTaskPatch`

或者至少新增：
- 统一冲突错误消息映射函数

### 验收标准

1. 第二次保存失败时必须出现明确提示
2. 第二次保存失败后页面不能假装成功
3. 列表与弹窗状态必须和数据库一致
4. 刷新后看到的数据与提示一致
5. 不同入口编辑同一任务时也走相同逻辑

### 回归测试项

1. `/task-center` 双会话同任务编辑
2. `/execution` 与 `/task-center` 多入口编辑同一任务
3. A 保存后 B 删除 / B 保存后 A 删除
4. 同字段修改与不同字段修改两类冲突

---

## Bug #004 Tailwind CDN 生产告警

### 现象

- 所有页面控制台稳定出现：
  `cdn.tailwindcss.com should not be used in production`

### 直接证据

- [index.html](D:/WLCK/ai-xing/index.html:13) 直接引入了 `https://cdn.tailwindcss.com`

### 根因判断

项目当前不是标准的 Tailwind 构建接入，而是运行时 CDN 注入。开发期可用，但生产环境会带来：
- 初始化依赖外网
- 控制台告警
- 样式生成不可控
- 发布一致性差

### 解决方案

#### 方案 A：切到本地 Tailwind 构建

推荐做法：
1. 安装 `tailwindcss postcss autoprefixer`
2. 增加 `tailwind.config.*` 与 `postcss.config.*`
3. 把当前 `index.html` 中的 `tailwind.config` 迁移到配置文件
4. 在 `index.css` 中使用 `@tailwind base; @tailwind components; @tailwind utilities;`
5. 删除 CDN `<script>`

#### 方案 B：如果短期不迁移

至少不要以“生产环境”形态发布该版本。但这只是规避，不是解决。

### 建议改动点

- [index.html](D:/WLCK/ai-xing/index.html:13)
- [package.json](D:/WLCK/ai-xing/package.json:12)
- `tailwind.config.*`
- `postcss.config.*`
- `index.css`

### 验收标准

1. 页面样式与当前版本一致
2. 控制台不再出现 Tailwind CDN 告警
3. 构建产物不依赖运行时 Tailwind CDN

### 回归测试项

1. 登录页
2. 主布局
3. 任务中心
4. 用户管理
5. 任意表单与弹窗样式

---

## Bug #005 `npm run lint` 失败

### 现象

- 执行 `npm run lint`
- 结果：`tsc --noEmit` 因 `supabase/functions/ai-chat/index.ts` 中的 Deno/`npm:` import 报错

### 直接证据

- [package.json](D:/WLCK/ai-xing/package.json:9) 当前 `lint` 只是 `tsc --noEmit`
- [tsconfig.json](D:/WLCK/ai-xing/tsconfig.json:1) 没有把 `supabase/functions` 与前端 TS 环境隔离

### 根因判断

同一套 TypeScript 检查同时覆盖了：
- 前端 Vite/React 代码
- Deno Edge Function 代码

但两者运行时和类型环境不同，因此前端 `tsc` 无法理解 Deno 全局和 `npm:` specifier。

### 解决方案

#### 方案 A：拆分 TS 配置

推荐做法：
1. 保留前端 `tsconfig.json`
2. 新增 `tsconfig.app.json` 只检查前端目录
3. 新增 `tsconfig.supabase.json` 专门检查 `supabase/functions`
4. `package.json` 中把 `lint` 拆成：
   - `lint:app`
   - `lint:supabase`
   - `lint`

#### 方案 B：前端 lint 直接排除 `supabase/functions`

如果短期只想恢复前端 CI，这是更快的方案。

例如：
- 在前端 tsconfig 中 `exclude: ["supabase/functions"]`

缺点是 Edge Function 完全失去类型检查，因此最好配合单独的 Deno 检查。

### 建议改动点

- [package.json](D:/WLCK/ai-xing/package.json:6)
- [tsconfig.json](D:/WLCK/ai-xing/tsconfig.json:1)
- 新增 `tsconfig.app.json`
- 新增 `tsconfig.supabase.json`

### 验收标准

1. `npm run lint` 恢复可执行
2. 前端代码类型检查通过
3. Edge Function 代码也能在正确环境下被检查

### 回归测试项

1. `npm run lint`
2. `npm run build`
3. Edge Function 本地或 CI 检查命令

---

## 建议修复顺序

### 第一阶段：先解阻断

1. Bug #002 新建任务模式错误

目标：

- 任务录入语义恢复

### 第二阶段：收技术债

1. Bug #004 Tailwind CDN
2. Bug #005 lint 工具链

目标：
- 发布形态规范化
- CI/本地检查恢复稳定

---

## 修复后建议的回归顺序

1. 先回归任务中心：新建、编辑、删除
2. 再做并发：同页双会话、多入口双会话
3. 最后跑 1 轮全站烟测与 `build/lint`

---

## 最终结论

当前最需要解决的不是样式或构建告警，而是两条核心业务链路：

1. 新建任务交互语义错误
2. Tailwind CDN 与 lint 工具链问题

并发失败“静默无反馈”这一条在当前代码中已基本修复；本轮应优先完成创建态修正与工程化问题收口，再做一轮完整回归。
