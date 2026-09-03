/// <reference lib="deno.ns" />
// deno-lint-ignore-file no-import-prefix require-await

import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";

import {
  type AdminUserDependencies,
  AdminUserError,
  type AuthCreateInput,
  type BusinessUserInsert,
} from "../admin-user-manager/contracts.ts";
import { createUser, resetPassword } from "../admin-user-manager/service.ts";

const callerAuthId = "11111111-1111-4111-8111-111111111111";
const targetAuthId = "22222222-2222-4222-8222-222222222222";

const validCreateInput = {
  username: "Zhang.San",
  name: " 张三 ",
  role: "Employee",
  departmentId: "dept-001",
};

type DependencyOverrides = Partial<AdminUserDependencies>;

function createFakeDependencies(
  overrides: DependencyOverrides = {},
): AdminUserDependencies {
  return {
    findUserByUsername: async () => null,
    departmentExists: async () => true,
    createAuthUser: async (input: AuthCreateInput) => ({
      id: targetAuthId,
      email: input.email,
    }),
    deleteAuthUser: async () => {},
    insertBusinessUser: async (_input: BusinessUserInsert) => {},
    findUserByAuthId: async (authId: string) => ({ id: "user-target", authId }),
    updateAuthPassword: async () => {},
    createId: () => "user-33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
}

async function expectAdminError(
  operation: () => Promise<unknown>,
  code: AdminUserError["code"],
) {
  const error = await assertRejects(operation, AdminUserError);
  if (!(error instanceof AdminUserError)) throw error;
  assertEquals(error.code, code);
  return error;
}

Deno.test("createUser normalizes input and persists matching Auth and business identities", async () => {
  let authInput: AuthCreateInput | undefined;
  let businessInput: BusinessUserInsert | undefined;
  const dependencies = createFakeDependencies({
    createAuthUser: async (input) => {
      authInput = input;
      return { id: targetAuthId, email: input.email };
    },
    insertBusinessUser: async (input) => {
      businessInput = input;
    },
  });

  const result = await createUser(validCreateInput, dependencies);

  assertEquals(authInput, {
    email: "zhang.san@app.local",
    password: "888888",
    name: "张三",
    username: "zhang.san",
    role: "Employee",
  });
  assertEquals(businessInput, {
    id: "user-33333333-3333-4333-8333-333333333333",
    authId: targetAuthId,
    username: "zhang.san",
    name: "张三",
    role: "Employee",
    departmentId: "dept-001",
  });
  assertEquals(result, {
    userId: "user-33333333-3333-4333-8333-333333333333",
    authId: targetAuthId,
    email: "zhang.san@app.local",
    temporaryPassword: "888888",
  });
});

Deno.test("createUser rejects invalid roles before any write", async () => {
  let wrote = false;
  const dependencies = createFakeDependencies({
    createAuthUser: async () => {
      wrote = true;
      return { id: targetAuthId, email: "invalid@app.local" };
    },
  });

  await expectAdminError(
    () => createUser({ ...validCreateInput, role: "User" }, dependencies),
    "INVALID_ROLE",
  );
  assertEquals(wrote, false);
});

Deno.test("createUser rejects an existing username", async () => {
  const dependencies = createFakeDependencies({
    findUserByUsername: async () => ({ id: "user-existing" }),
  });

  await expectAdminError(
    () => createUser(validCreateInput, dependencies),
    "USER_ALREADY_EXISTS",
  );
});

Deno.test("createUser rejects a missing department", async () => {
  const dependencies = createFakeDependencies({
    departmentExists: async () => false,
  });

  await expectAdminError(
    () => createUser(validCreateInput, dependencies),
    "DEPARTMENT_NOT_FOUND",
  );
});

Deno.test("createUser maps Auth failures to a stable error", async () => {
  const dependencies = createFakeDependencies({
    createAuthUser: async () => {
      throw new Error("provider details must stay private");
    },
  });

  const error = await expectAdminError(
    () => createUser(validCreateInput, dependencies),
    "AUTH_CREATE_FAILED",
  );
  assertEquals(error.message.includes("provider details"), false);
});

Deno.test("createUser deletes Auth user when the business insert fails", async () => {
  const deleted: string[] = [];
  const dependencies = createFakeDependencies({
    insertBusinessUser: async () => {
      throw new Error("database details must stay private");
    },
    deleteAuthUser: async (authId) => {
      deleted.push(authId);
    },
  });

  await expectAdminError(
    () => createUser(validCreateInput, dependencies),
    "BUSINESS_USER_CREATE_FAILED",
  );
  assertEquals(deleted, [targetAuthId]);
});

Deno.test("createUser reports a failed compensation", async () => {
  const dependencies = createFakeDependencies({
    insertBusinessUser: async () => {
      throw new Error("insert failed");
    },
    deleteAuthUser: async () => {
      throw new Error("delete failed");
    },
  });

  await expectAdminError(
    () => createUser(validCreateInput, dependencies),
    "CREATE_COMPENSATION_FAILED",
  );
});

Deno.test("resetPassword updates only a bound non-self Auth user", async () => {
  const updates: Array<{ authId: string; password: string }> = [];
  const dependencies = createFakeDependencies({
    updateAuthPassword: async (authId, password) => {
      updates.push({ authId, password });
    },
  });

  const result = await resetPassword(
    { auth_id: targetAuthId },
    callerAuthId,
    dependencies,
  );

  assertEquals(updates, [{ authId: targetAuthId, password: "888888" }]);
  assertEquals(result, { authId: targetAuthId, temporaryPassword: "888888" });
});

Deno.test("resetPassword rejects unbound Auth users", async () => {
  const dependencies = createFakeDependencies({
    findUserByAuthId: async () => null,
  });

  await expectAdminError(
    () => resetPassword({ auth_id: targetAuthId }, callerAuthId, dependencies),
    "TARGET_USER_NOT_FOUND",
  );
});

Deno.test("resetPassword rejects self reset", async () => {
  const dependencies = createFakeDependencies();

  await expectAdminError(
    () => resetPassword({ auth_id: callerAuthId }, callerAuthId, dependencies),
    "SELF_RESET_NOT_ALLOWED",
  );
});

Deno.test("resetPassword rejects self reset regardless of UUID casing", async () => {
  const dependencies = createFakeDependencies();

  await expectAdminError(
    () =>
      resetPassword(
        { auth_id: callerAuthId.toUpperCase() },
        callerAuthId,
        dependencies,
      ),
    "SELF_RESET_NOT_ALLOWED",
  );
});

Deno.test("resetPassword maps Auth failures to a stable error", async () => {
  const dependencies = createFakeDependencies({
    updateAuthPassword: async () => {
      throw new Error("provider details must stay private");
    },
  });

  const error = await expectAdminError(
    () => resetPassword({ auth_id: targetAuthId }, callerAuthId, dependencies),
    "PASSWORD_RESET_FAILED",
  );
  assertEquals(error.message.includes("provider details"), false);
});
