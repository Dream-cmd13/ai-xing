/// <reference lib="deno.ns" />
// deno-lint-ignore-file no-import-prefix require-await

import { assertEquals } from "jsr:@std/assert@1.0.14";

import type { AdminUserDependencies } from "../admin-user-manager/contracts.ts";
import {
  type AdminUserHandlerDependencies,
  createAdminUserHandler,
} from "../admin-user-manager/handler.ts";

const callerAuthId = "11111111-1111-4111-8111-111111111111";
const targetAuthId = "22222222-2222-4222-8222-222222222222";
const allowedOrigin = "https://remix.btitib.com";

function createAdminDependencies(): AdminUserDependencies {
  return {
    findUserByUsername: async () => null,
    departmentExists: async () => true,
    createAuthUser: async (input) => ({ id: targetAuthId, email: input.email }),
    deleteAuthUser: async () => {},
    insertBusinessUser: async () => {},
    findUserByAuthId: async (authId) => ({ id: "user-target", authId }),
    updateAuthPassword: async () => {},
    createId: () => "user-33333333-3333-4333-8333-333333333333",
  };
}

function createHandler(
  overrides: Partial<AdminUserHandlerDependencies> = {},
) {
  return createAdminUserHandler({
    authenticate: async () => ({ id: callerAuthId }),
    isAdmin: async () => true,
    adminUser: createAdminDependencies(),
    allowedOrigins: new Set([allowedOrigin]),
    createRequestId: () => "request-1",
    ...overrides,
  });
}

function createRequest(
  body: Record<string, unknown>,
  options: { token?: string; origin?: string; method?: string } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.token !== "missing") {
    headers.set("Authorization", `Bearer ${options.token ?? "valid-token"}`);
  }
  if (options.origin) headers.set("Origin", options.origin);
  return new Request(
    "https://project.supabase.co/functions/v1/admin-user-manager",
    {
      method: options.method ?? "POST",
      headers,
      body: options.method === "OPTIONS" ? undefined : JSON.stringify(body),
    },
  );
}

Deno.test("handler creates a user after authentication and admin authorization", async () => {
  const response = await createHandler()(createRequest({
    action: "create_user",
    username: "zhang.san",
    name: "张三",
    role: "Employee",
  }, { origin: allowedOrigin }));
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );
  assertEquals(body.success, true);
  assertEquals(body.data.authId, targetAuthId);
  assertEquals(body.requestId, "request-1");
});

Deno.test("handler rejects requests without a bearer token", async () => {
  const response = await createHandler()(createRequest(
    { action: "reset_password", auth_id: targetAuthId },
    { token: "missing" },
  ));
  const body = await response.json();

  assertEquals(response.status, 401);
  assertEquals(body.error.code, "AUTH_REQUIRED");
});

Deno.test("handler rejects an invalid session", async () => {
  const response = await createHandler({
    authenticate: async () => {
      throw new Error("provider detail");
    },
  })(createRequest({ action: "reset_password", auth_id: targetAuthId }));
  const body = await response.json();

  assertEquals(response.status, 401);
  assertEquals(body.error.code, "AUTH_REQUIRED");
  assertEquals(JSON.stringify(body).includes("provider detail"), false);
});

Deno.test("handler rejects authenticated non-admin users", async () => {
  const response = await createHandler({ isAdmin: async () => false })(
    createRequest({
      action: "reset_password",
      auth_id: targetAuthId,
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 403);
  assertEquals(body.error.code, "ADMIN_REQUIRED");
});

Deno.test("handler rejects browser origins outside the allowlist", async () => {
  let authenticated = false;
  const response = await createHandler({
    authenticate: async () => {
      authenticated = true;
      return { id: callerAuthId };
    },
  })(createRequest(
    { action: "reset_password", auth_id: targetAuthId },
    { origin: "https://evil.example" },
  ));
  const body = await response.json();

  assertEquals(response.status, 403);
  assertEquals(body.error.code, "ORIGIN_NOT_ALLOWED");
  assertEquals(authenticated, false);
});

Deno.test("handler accepts preflight only from an allowed origin", async () => {
  const response = await createHandler()(createRequest(
    {},
    { origin: allowedOrigin, method: "OPTIONS" },
  ));

  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );
});

Deno.test("handler rejects unsupported HTTP methods", async () => {
  const response = await createHandler()(
    new Request(
      "https://project.supabase.co/functions/v1/admin-user-manager",
      { method: "GET", headers: { Authorization: "Bearer valid-token" } },
    ),
  );
  const body = await response.json();

  assertEquals(response.status, 405);
  assertEquals(body.error.code, "METHOD_NOT_ALLOWED");
});

Deno.test("handler rejects malformed JSON", async () => {
  const response = await createHandler()(
    new Request(
      "https://project.supabase.co/functions/v1/admin-user-manager",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid-token",
          "Content-Type": "application/json",
        },
        body: "{",
      },
    ),
  );
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.error.code, "INVALID_REQUEST");
});

Deno.test("handler resets a bound target user", async () => {
  const response = await createHandler()(createRequest({
    action: "reset_password",
    auth_id: targetAuthId,
  }));
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body.data, {
    authId: targetAuthId,
    temporaryPassword: "888888",
  });
});

Deno.test("handler rejects unknown actions with a stable error code", async () => {
  const response = await createHandler()(
    createRequest({ action: "delete_user" }),
  );
  const body = await response.json();

  assertEquals(response.status, 400);
  assertEquals(body.error.code, "INVALID_ACTION");
});

Deno.test("handler does not expose unexpected internal error details", async () => {
  const response = await createHandler({
    adminUser: {
      ...createAdminDependencies(),
      findUserByUsername: async () => {
        throw new Error("secret database details");
      },
    },
  })(createRequest({
    action: "create_user",
    username: "zhang.san",
    name: "张三",
    role: "Employee",
  }));
  const body = await response.json();

  assertEquals(response.status, 500);
  assertEquals(body.error.code, "INTERNAL_ERROR");
  assertEquals(JSON.stringify(body).includes("secret database"), false);
});
