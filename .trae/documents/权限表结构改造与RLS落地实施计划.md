# 权限表结构改造与 RLS 落地实施计划

## Summary

- 目标：把当前仓库 `d:\aixing\okr-ai` 从“前端菜单权限 + 粗粒度 RLS”演进到“结构化归属字段 + 可落地 RLS + 分阶段上线”的权限模型。
- 本计划聚焦两件事：
  - 先补哪些表结构字段，才能让权限真正可表达
  - 再按什么顺序落地 `RLS`，风险最低、收益最高
- 已确认业务规则：
  - 角色分层：`Admin / Manager / Employee`
  - 总经理等同 `Admin`
  - `Manager`：可看全公司数据，但只能写本部门数据
  - `Employee`：默认只能看本部门数据；任务中若自己是负责人、参与人、审批人，则可看跨部门任务
  - `Employee`：默认只能创建本部门数据；任务允许参与式跨部门协作
  - `Employee`：只能修改/删除自己创建的数据
- 总体实施策略：
  - **先补结构，再收 RLS**
  - **先做 `tasks`，再做 `processes`，再处理 `departments/okr`**
  - **先做强约束字段与数据库策略，最后再收前端权限体验**

## Current State Analysis

### 1. 当前最关键的问题不是“策略写得不够多”，而是“表结构不够表达权限”

- 关键文件：
  - `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
  - `d:\aixing\okr-ai\data.ts`
  - `d:\aixing\okr-ai\types.ts`
- 当前真实表结构现状：
  - `users` 有 `department_id`
  - `tasks` 有 `department_id`、`owner_id`、`participant_ids`、`approver_ids`
  - `processes` 没有 `department_id`、没有 `created_by`
  - `departments` 只有 `manager_name`，没有 `manager_user_id`
  - `strategy.company_okrs` 与 `departments.okrs` 仍是 JSONB blob
- 结论：
  - 现在最阻碍权限落地的，不是前端菜单权限，而是数据库缺乏稳定的“归属字段”

### 2. 当前 RLS 基本仍是二元模型，不匹配目标权限规则

- 关键文件：
  - `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
- 当前现状：
  - 多数业务表 `SELECT` 仍是 `USING (true)`
  - 多数写操作仍是“仅管理员”或“owner/管理员”
- 与目标规则的冲突：
  - 无法表达 `Manager` “全量可见、本部门可写”
  - 无法表达 `Employee` “本部门可见、参与任务可见、仅自己创建可写”
  - 无法表达“默认只能创建本部门数据”

### 3. 当前最适合优先收口的业务域是 `tasks`

- 原因：
  - 现有字段最接近权限所需条件
  - 业务规则最清晰
  - 改造后能最快验证角色模型是否有效
- 但仍有缺口：
  - 如果“创建者”不等于 `owner_id`，则仍需要 `created_by`

### 4. 当前最不适合直接上精细 RLS 的业务域是 `okr`

- 原因：
  - 仍混在 JSONB 中
  - 没有稳定的记录级主键、创建者、部门归属字段
  - 继续直接写 RLS，会把业务规则绑死在 JSON 结构和应用约定上

## Proposed Changes

### 一、目标权限模型

#### 1. 角色主枚举

- `Admin`
- `Manager`
- `Employee`

#### 2. 数据权限总原则

- `Admin`
  - 全量可见
  - 全量可写
- `Manager`
  - 全量可见
  - 仅本部门可写
- `Employee`
  - 默认仅本部门可见
  - 跨部门任务若自己参与，则可见
  - 默认仅本部门可创建
  - 仅自己创建的数据可修改/删除

#### 3. 菜单权限定位

- `systemRoles/customPermissions` 继续保留
- 但只负责：
  - 入口是否可见
  - 某按钮是否展示
- 不再负责最终安全边界
- 最终安全边界统一由 PostgreSQL RLS 实施

### 二、表结构改造方案

#### 第一优先级：`tasks`

- 涉及文件：
  - `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
  - `d:\aixing\okr-ai\data.ts`
  - `d:\aixing\okr-ai\types.ts`
- 当前已有：
  - `department_id`
  - `owner_id`
  - `participant_ids`
  - `approver_ids`
- 建议补充：
  - `created_by TEXT`
- 为什么：
  - 你要表达“自己创建可改删”，不能长期假设 `owner_id === created_by`
  - 任务是当前最优先做权限试点的域，字段应一次补到位
- 落地口径：
  - 新建任务时：
    - `created_by = current_user_id()`
    - 默认 `department_id = currentUser.departmentId`
  - 如果允许跨部门协作：
    - 通过 `participant_ids/approver_ids` 打开可见范围
    - 但不改变“默认创建属于本部门”的原则

#### 第二优先级：`processes`

- 涉及文件：
  - `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
  - `d:\aixing\okr-ai\data.ts`
  - `d:\aixing\okr-ai\types.ts`
- 建议新增：
  - `department_id TEXT`
  - `created_by TEXT`
- 为什么：
  - `Manager` 写本部门流程，需要 `department_id`
  - `Employee` 只能改自己创建流程，需要 `created_by`
- 业务约束建议：
  - `Employee` 创建流程时，`department_id` 必须等于本人部门
  - `Manager` 可创建所属部门流程
  - `Admin` 可创建任意部门流程

#### 第三优先级：`departments`

- 涉及文件：
  - `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
  - `d:\aixing\okr-ai\data.ts`
  - `d:\aixing\okr-ai\types.ts`
- 建议新增：
  - `manager_user_id TEXT`
- 为什么：
  - 当前只有 `manager_name`
  - 文本字段无法作为安全判断依据
- 用途：
  - 为 `Manager` 的部门写权限提供结构化映射依据
  - 后续可扩展为一个或多个负责人映射表

#### 第四优先级：`okr`

- 涉及文件：
  - `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
  - `d:\aixing\okr-ai\data.ts`
  - `d:\aixing\okr-ai\types.ts`
- 当前问题：
  - `departments.okrs` 与 `strategy.company_okrs` 仍为 JSONB
- 结构化建议：
  - 中期拆出独立 OKR 表，最少包含：
    - `id`
    - `department_id`
    - `created_by`
    - `scope` (`company` / `department` / `personal`)
    - 必要的 `owner_id` 或 `editor_scope`
- 短期策略：
  - 在结构化前，不建议让普通员工直接创建/编辑 OKR 主记录
  - 普通员工只允许提交输入类数据

#### 当前不需要因本次权限而优先改造的表

- `system_roles`
- `settings`
- `businesses`

### 三、RLS 落地顺序

#### Phase 1：补安全辅助函数

- 涉及文件：
  - `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
- 新增/调整建议：
  - `current_user_role()`
  - `current_user_department_id()`
  - `is_manager()`
  - `is_employee()`
  - `is_same_department(target_department_id)`
  - 若后续部门负责人结构稳定，再增加：
    - `is_department_manager(target_department_id)`
- 为什么：
  - 避免把复杂逻辑直接散写在 policy 里
  - 降低策略可读性和维护成本

#### Phase 2：先改 `tasks` 的 RLS

- 涉及文件：
  - `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
  - `d:\aixing\okr-ai\data.ts`
  - `d:\aixing\okr-ai\utils\permissions.ts`
- 目标规则：
  - `Admin`：全量可见/可写
  - `Manager`：全量可见，本部门任务可写
  - `Employee`：
    - 本部门任务可见
    - 自己负责/参与/审批的任务可见
    - 仅 `created_by = current_user_id()` 的任务可改删
    - 新建任务必须满足：
      - `department_id = current_user_department_id()`
      - `created_by = current_user_id()`
- 为什么先做：
  - 任务是当前规则最完整、结构最接近可落地的域
  - 适合作为权限模型试点
- 验收标准：
  - 普通员工无法读取其他部门不相关任务
  - 普通员工无法修改他人创建任务
  - 普通员工可看到自己参与的跨部门任务
  - 部门长无法修改其他部门任务

#### Phase 3：再改 `users`

- 目标规则：
  - `Admin`：全量可见/可写
  - `Manager`：可查看全员，但不能改用户角色、权限、账号主数据
  - `Employee`：仅可查看本部门最小必要字段；仅可修改本人有限字段
- 建议：
  - 不直接对 `users` 主表开放复杂写权限
  - 如有必要，后续拆“个人资料更新”RPC
- 验收标准：
  - 普通员工无法读取全员完整敏感字段
  - 普通员工无法修改他人资料

#### Phase 4：再改 `processes`

- 前置条件：
  - 已补 `department_id`
  - 已补 `created_by`
- 目标规则：
  - `Admin`：全量可见/可写
  - `Manager`：全量可见，本部门流程可写
  - `Employee`：本部门流程可见，仅自己创建流程可写
- 验收标准：
  - 普通员工无法创建跨部门流程
  - 部门长无法修改其他部门流程

#### Phase 5：最后处理 `departments / okr`

- 原因：
  - 这两个域当前仍依赖树形 JSON 与 blob
  - 直接上精细 RLS 风险最高
- 推荐顺序：
  - 先给 `departments` 加 `manager_user_id`
  - 再评估 OKR 拆表
  - 结构化完成后再写记录级 RLS
- 验收标准：
  - 权限逻辑不再依赖 `manager_name`
  - OKR 权限不再依赖前端约定和 JSON 路径

### 四、前端与数据访问层配套改造

#### 1. 类型与模型层

- 涉及文件：
  - `d:\aixing\okr-ai\types.ts`
- 需要调整：
  - `User.role` 扩展为 `Admin | Manager | Employee`
  - `PADEntry` 增加 `createdBy`
  - `ProcessDefinition` 增加 `departmentId`、`createdBy`
  - `Department` 增加 `managerUserId`

#### 2. DAO 层

- 涉及文件：
  - `d:\aixing\okr-ai\data.ts`
- 需要调整：
  - 所有 `select` 改为适配新的最小字段策略
  - `addTask/addProcess` 等创建方法写入默认归属字段
  - 对高风险写入入口优先改为 RPC，以避免前端绕过归属规则

#### 3. 前端权限工具

- 涉及文件：
  - `d:\aixing\okr-ai\hooks\usePermissions.ts`
  - `d:\aixing\okr-ai\utils\permissions.ts`
- 需要调整：
  - 从“Admin or not”的粗判断，迁移为三层角色默认规则
  - 前端只做体验控制，不再写与数据库强约束冲突的例外逻辑

### 五、实施顺序建议

1. 补角色枚举和辅助函数
2. 给 `tasks` 增加 `created_by`
3. 先落地 `tasks` 的 RLS
4. 收口 `users` 的读取范围和本人资料写入范围
5. 给 `processes` 增加 `department_id + created_by`
6. 落地 `processes` 的 RLS
7. 给 `departments` 增加 `manager_user_id`
8. 评估并启动 `okr` 结构化拆分
9. 最后再收前端菜单权限与页面体验

### 六、回滚与风险控制

#### 1. 回滚原则

- 每个阶段应独立可回滚
- 先加字段，再切读写，再收 RLS，避免一次性强切

#### 2. 推荐发布方式

- 第一步：
  - 加字段，不启用依赖该字段的新策略
- 第二步：
  - 后端写入链开始回填新字段
- 第三步：
  - 校验存量数据补齐
- 第四步：
  - 启用新 RLS

#### 3. 风险点

- 存量数据缺少 `created_by/department_id`
- 旧前端仍可能按旧结构发请求
- `okr` 仍是 blob，最容易出现“规则写不准”

## Assumptions & Decisions

- 决定 1：总经理等同 `Admin`
- 决定 2：角色模型采用三层，不继续维持 `Admin | User`
- 决定 3：`Employee` 默认只能创建本部门数据；任务允许参与式跨部门协作
- 决定 4：优先把 `tasks` 作为权限试点域
- 决定 5：`okr` 在结构化前，不作为第一批精细 RLS 实施对象
- 假设 1：未来“自己创建”不能长期依赖 `owner_id` 替代，因此最终需要 `created_by`
- 假设 2：`Manager` 的“本部门可写”需要结构化负责人标识，而不是继续依赖姓名文本

## Verification Steps

- 核验当前表结构缺口：
  - 阅读 `d:\aixing\okr-ai\sql\00_one_click_schema.sql`
  - 确认 `processes` 缺少 `department_id/created_by`
  - 确认 `tasks` 缺少 `created_by`
  - 确认 `departments` 缺少 `manager_user_id`
- 核验当前读取/映射层：
  - 阅读 `d:\aixing\okr-ai\data.ts`
  - 确认当前仍主要按旧字段映射
- 核验当前权限工具：
  - 阅读 `d:\aixing\okr-ai\utils\permissions.ts`
  - 确认当前任务可见逻辑已部分具备“部门 + 参与关系”基础
- 核验当前权限总体设计：
  - 阅读 `d:\aixing\okr-ai\.trae\documents\权限设计与角色分层方案规划.md`
  - 确认本实施计划与上层权限方案保持一致

## Final Recommendation

- 这次权限落地不要试图“一次把所有表的 RLS 都写完”
- 最稳妥路线是：
  - **先补字段**
  - **先做 `tasks`**
  - **再做 `processes`**
  - **最后处理 `departments/okr`**
- 如果要判断“这一轮先改什么最值”：
  - 第一优先级：`tasks.created_by + tasks RLS`
  - 第二优先级：`processes.department_id + processes.created_by + processes RLS`
  - 第三优先级：`departments.manager_user_id`
  - 第四优先级：`okr` 结构化
