# Admin User Manager Edge Function Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route administrator user creation and password resets exclusively through a secured Supabase `admin-user-manager` Edge Function while keeping AI chat on Flask.

**Architecture:** A pure TypeScript handler validates HTTP, JWT-backed administrator authorization, request data, and stable responses. A Supabase runtime adapter supplies caller-scoped and service-role operations. The frontend invokes this function directly and accepts the returned user as already persisted.

**Tech Stack:** TypeScript, Supabase Edge Runtime, `@supabase/supabase-js`, React, Zustand, Node/Deno test runners.

---

### Task 1: Define contracts and service behavior

**Files:**
- Create: `supabase/functions/admin-user-manager/contracts.ts`
- Create: `supabase/functions/admin-user-manager/service.ts`
- Test: `supabase/functions/tests/admin-user-manager.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover successful creation, duplicate usernames, invalid departments, Auth creation failure, business insert compensation, compensation failure, successful reset, missing targets, self-reset, and Auth update failure. Use an in-memory dependency object and assert stable `AdminUserError.code` values.

```ts
Deno.test("deletes a newly-created auth user when the business insert fails", async () => {
  const calls: string[] = [];
  const dependencies = createFakeDependencies({
    insertBusinessUser: async () => { throw new Error("db detail"); },
    deleteAuthUser: async () => { calls.push("delete-auth"); },
  });
  await assertRejects(
    () => createUser(validCreateInput, dependencies),
    AdminUserError,
    "创建业务用户失败",
  );
  assertEquals(calls, ["delete-auth"]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx --yes deno@2.9.6 test supabase/functions/tests/admin-user-manager.test.ts --allow-env
```

Expected: failure because contracts and service modules do not exist.

- [ ] **Step 3: Implement contracts and validation**

Define `AdminUserError`, stable error codes, `CreateUserInput`, response types, and validators. Normalize usernames to lowercase and accept only `^[a-z0-9._-]{1,64}$`; accept roles `Admin`, `Manager`, and `Employee`; validate names, departments, actions, and UUIDs.

```ts
export class AdminUserError extends Error {
  constructor(
    public readonly code: AdminUserErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AdminUserError";
  }
}
```

- [ ] **Step 4: Implement create and reset services**

Use dependency interfaces for all network and database calls. Create Auth first, insert `public.users` second, and delete Auth on insert failure. Reset only an Auth ID bound to `public.users` and reject the caller's own Auth ID.

```ts
export interface AdminUserDependencies {
  findUserByUsername(username: string): Promise<{ id: string } | null>;
  departmentExists(departmentId: string): Promise<boolean>;
  createAuthUser(input: AuthCreateInput): Promise<{ id: string; email: string }>;
  deleteAuthUser(authId: string): Promise<void>;
  insertBusinessUser(input: BusinessUserInsert): Promise<void>;
  findUserByAuthId(authId: string): Promise<{ id: string; authId: string } | null>;
  updateAuthPassword(authId: string, password: string): Promise<void>;
  createId(): string;
}
```

- [ ] **Step 5: Run service tests**

Run the Deno test command. Expected: all service cases pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/admin-user-manager supabase/functions/tests/admin-user-manager.test.ts
git commit -m "feat: 实现管理员边缘函数业务逻辑"
```

### Task 2: Implement the secured HTTP handler and Supabase runtime

**Files:**
- Create: `supabase/functions/admin-user-manager/handler.ts`
- Create: `supabase/functions/admin-user-manager/index.ts`
- Create: `supabase/config.toml`
- Modify: `supabase/functions/tests/admin-user-manager.test.ts`

- [ ] **Step 1: Add handler tests**

Test CORS preflight, rejected origins, unsupported methods, missing bearer tokens, invalid sessions, non-admin callers, malformed JSON, both valid actions, sanitized internal errors, and request IDs.

```ts
const response = await handler(new Request("https://example.test", {
  method: "POST",
  headers: { Origin: "https://remix.btitib.com", "Content-Type": "application/json" },
  body: JSON.stringify({ action: "reset_password", auth_id: validTargetAuthId }),
}));
assertEquals(response.status, 401);
```

- [ ] **Step 2: Implement handler**

Create a `createAdminUserHandler()` factory. Allow requests without an Origin for controlled CLI checks, require configured origins for browser requests, parse Bearer JWTs, authenticate the caller, call `isAdmin`, dispatch actions, and return stable JSON envelopes.

- [ ] **Step 3: Implement Supabase runtime adapter**

Read `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `ADMIN_ALLOWED_ORIGINS`. Build a caller-scoped client for `auth.getUser()` and `rpc('is_admin')`, and a service-role client for Auth Admin and table operations. Never log environment values or raw provider errors.

- [ ] **Step 4: Configure JWT verification**

```toml
project_id = "ai-xing"

[functions.admin-user-manager]
verify_jwt = true
```

- [ ] **Step 5: Run tests and type checks**

```powershell
npx --yes deno@2.9.6 fmt --check supabase/functions/admin-user-manager supabase/functions/tests/admin-user-manager.test.ts
npx --yes deno@2.9.6 lint supabase/functions/admin-user-manager supabase/functions/tests/admin-user-manager.test.ts
npx --yes deno@2.9.6 test supabase/functions/tests/admin-user-manager.test.ts --allow-env
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/config.toml supabase/functions/admin-user-manager supabase/functions/tests/admin-user-manager.test.ts
git commit -m "feat: 加固管理员边缘函数入口"
```

### Task 3: Route frontend administrator actions to Edge Function

**Files:**
- Modify: `services/backendGateway.ts`
- Modify: `.env.example`
- Test: `local-test-files` is not used; validation runs against source and build output.

- [ ] **Step 1: Replace Flask administrator branches**

Keep `chatWithAI()` and `postToRest()` for AI. Make both administrator methods invoke `admin-user-manager` directly and normalize the function envelope.

```ts
const invokeAdminUserManager = async <T>(body: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.functions.invoke("admin-user-manager", { body });
  if (error || !data?.success || !data?.data) {
    throw new Error(error?.message || data?.error?.message || data?.error || "管理员操作失败");
  }
  return data.data as T;
};
```

- [ ] **Step 2: Document environment ownership**

Keep the existing public Supabase variables. Explain in `.env.example` that `VITE_BACKEND_TARGET` and `VITE_BACKEND_API_BASE_URL` affect AI only and administrator actions always use Edge Function.

- [ ] **Step 3: Verify source contract**

```powershell
rg -n "admin-user-manager" services/backendGateway.ts
rg -n "/api/admin/users" services/backendGateway.ts
```

Expected: the first command finds both administrator actions; the second has no output.

- [ ] **Step 4: Commit**

```bash
git add services/backendGateway.ts .env.example
git commit -m "feat: 管理员操作切换边缘函数"
```

### Task 4: Keep persisted user state consistent

**Files:**
- Modify: `store/useAppStore.ts`
- Modify: `hooks/useAppActions.ts`
- Modify: `components/UserView.tsx`

- [ ] **Step 1: Add a persisted-user store action**

Add `acceptPersistedUser(user)` that upserts the same user into `users` and `lastSavedUsers` without changing `dirtyDomains` or clearing pre-existing user edits.

```ts
acceptPersistedUser: (user) => set((state) => ({
  users: upsertUser(state.users, user),
  lastSavedUsers: upsertUser(state.lastSavedUsers, user),
})),
```

- [ ] **Step 2: Expose the action through `useAppActions`**

Call the store action and synchronize `stateRef`, without setting the user domain dirty.

- [ ] **Step 3: Update `UserView`**

After Edge success, construct the new `User` with empty permissions, `rowVersion: 0`, and call `acceptPersistedUser`. Remove the extra `setUsers()` and `setIsDirty(true)` calls from the create path. Leave normal user editing behavior unchanged.

- [ ] **Step 4: Run TypeScript validation**

```powershell
npm run lint:app
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add store/useAppStore.ts hooks/useAppActions.ts components/UserView.tsx
git commit -m "fix: 同步已创建用户保存基线"
```

### Task 5: Update operational documentation

**Files:**
- Modify: `docs/admin-user-manager-edge-function-spec.md`
- Modify: `docs/flask-edge-compatible-backend-analysis.md`
- Modify: `docs/production-deployment-quick-guide.md`
- Modify: `local-test-files/generate_deployment_doc.py`
- Regenerate: `docs/AI-Xing正式服部署步骤-简版.docx`

- [ ] **Step 1: Correct the Edge Function specification**

Replace stale paths and `role: User`, mark the function implemented, document stable errors, compensation, JWT verification, CORS, and deployment order.

- [ ] **Step 2: Correct Flask ownership documentation**

State that Flask handles AI only; administrator endpoints remain temporarily for rollback and must be removed with the Flask service-role secret after formal acceptance.

- [ ] **Step 3: Update deployment instructions**

Add Edge Function deployment before frontend deployment. State that frontend environment has no administrator-specific variable and that AI Flask variables do not control user administration.

- [ ] **Step 4: Regenerate and structurally inspect the Word guide**

Use the bundled document runtime, then confirm the DOCX ZIP is valid and contains `admin-user-manager`, `ADMIN_ALLOWED_ORIGINS`, and the Edge deployment sequence.

- [ ] **Step 5: Commit**

```bash
git add docs/admin-user-manager-edge-function-spec.md docs/flask-edge-compatible-backend-analysis.md docs/production-deployment-quick-guide.md docs/AI-Xing正式服部署步骤-简版.docx
git commit -m "docs: 更新边缘函数部署说明"
```

### Task 6: Run release validation

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run all deterministic checks**

```powershell
npx --yes deno@2.9.6 fmt --check supabase/functions/admin-user-manager supabase/functions/tests/admin-user-manager.test.ts
npx --yes deno@2.9.6 lint supabase/functions/admin-user-manager supabase/functions/tests/admin-user-manager.test.ts
npx --yes deno@2.9.6 test supabase/functions/tests/admin-user-manager.test.ts --allow-env
npm run lint:app
npm run build:secure
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Inspect the production bundle**

```powershell
rg -n "admin-user-manager" dist/assets
rg -n "/api/admin/users" dist/assets
```

Expected: Edge function name is present; Flask administrator paths are absent.

- [ ] **Step 3: Review repository status**

Only intended source, tests, documentation, and the pre-existing local artifacts may remain. No `.env`, secret, access token, build output, cache, or temporary file is staged.

### Task 7: Deploy after explicit production authorization

**Files:**
- External Supabase Edge Function deployment and formal server build.

- [ ] **Step 1: Configure the custom function secret**

```powershell
npx supabase secrets set ADMIN_ALLOWED_ORIGINS=https://remix.btitib.com --project-ref $projectRef
```

`$projectRef` is derived locally from the approved production `VITE_SUPABASE_URL`; its value is not printed or committed.

- [ ] **Step 2: Deploy the function before the frontend**

```powershell
npx supabase functions deploy admin-user-manager --project-ref $projectRef
```

- [ ] **Step 3: Verify unauthenticated rejection**

Call the deployed function without a user JWT and expect HTTP 401. This check performs no business write.

- [ ] **Step 4: Merge the verified changes to `main` and rebuild the formal frontend**

Use the existing approved Git release process. Keep public Supabase values and AI Flask variables; add no administrator frontend variable.

- [ ] **Step 5: Perform approved-account acceptance**

An administrator creates one approved acceptance user and resets one approved target password. Browser requests must use `/functions/v1/admin-user-manager`; no `/api/admin/users` request is allowed.
