/// <reference lib="deno.ns" />

// deno-lint-ignore no-import-prefix
import { createClient } from "npm:@supabase/supabase-js@2.105.4";

import type {
  AdminUserDependencies,
  AuthCreateInput,
  BusinessUserInsert,
} from "./contracts.ts";
import {
  type AdminUserHandlerDependencies,
  createAdminUserHandler,
} from "./handler.ts";

type RuntimeConfiguration = {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  allowedOrigins: ReadonlySet<string>;
};

function getRequiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment: ${name}`);
  return value;
}

function loadConfiguration(): RuntimeConfiguration {
  const origins = getRequiredEnvironment("ADMIN_ALLOWED_ORIGINS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (origins.length === 0) throw new Error("ADMIN_ALLOWED_ORIGINS is empty");

  return {
    supabaseUrl: getRequiredEnvironment("SUPABASE_URL"),
    anonKey: getRequiredEnvironment("SUPABASE_ANON_KEY"),
    serviceRoleKey: getRequiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    allowedOrigins: new Set(origins),
  };
}

function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function createRuntimeDependencies(
  configuration: RuntimeConfiguration,
): AdminUserHandlerDependencies {
  const serviceClient = createClient(
    configuration.supabaseUrl,
    configuration.serviceRoleKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const createUserClient = (token: string) =>
    createClient(configuration.supabaseUrl, configuration.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

  const adminUser: AdminUserDependencies = {
    async findUserByUsername(username) {
      const { data, error } = await serviceClient
        .from("users")
        .select("id")
        .ilike("username", escapeIlikePattern(username))
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id } : null;
    },
    async departmentExists(departmentId) {
      const { data, error } = await serviceClient
        .from("departments")
        .select("id")
        .eq("id", departmentId)
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    async createAuthUser(input: AuthCreateInput) {
      const { data, error } = await serviceClient.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: {
          name: input.name,
          username: input.username,
          role: input.role,
        },
      });
      if (error || !data.user) throw error ?? new Error("Auth user missing");
      return { id: data.user.id, email: data.user.email ?? input.email };
    },
    async deleteAuthUser(authId) {
      const { error } = await serviceClient.auth.admin.deleteUser(authId);
      if (error) throw error;
    },
    async insertBusinessUser(input: BusinessUserInsert) {
      const { error } = await serviceClient.from("users").insert({
        id: input.id,
        auth_id: input.authId,
        username: input.username,
        name: input.name,
        role: input.role,
        department_id: input.departmentId ?? null,
        pad_permissions: [],
        reviews: {},
        system_role_ids: [],
        custom_permissions: {},
        row_version: 0,
      });
      if (error) throw error;
    },
    async findUserByAuthId(authId) {
      const { data, error } = await serviceClient
        .from("users")
        .select("id,auth_id")
        .eq("auth_id", authId)
        .maybeSingle();
      if (error) throw error;
      return data?.auth_id ? { id: data.id, authId: data.auth_id } : null;
    },
    async updateAuthPassword(authId, password) {
      const { error } = await serviceClient.auth.admin.updateUserById(authId, {
        password,
      });
      if (error) throw error;
    },
    createId: () => `user-${crypto.randomUUID()}`,
  };

  return {
    allowedOrigins: configuration.allowedOrigins,
    adminUser,
    createRequestId: () => crypto.randomUUID(),
    async authenticate(token) {
      const { data, error } = await createUserClient(token).auth.getUser(token);
      if (error || !data.user) throw error ?? new Error("User missing");
      return { id: data.user.id };
    },
    async isAdmin(token) {
      const { data, error } = await createUserClient(token).rpc("is_admin");
      if (error) throw error;
      return data === true;
    },
    log(entry) {
      console.info(JSON.stringify({ event: "admin_user_manager", ...entry }));
    },
  };
}

let handler: ((request: Request) => Promise<Response>) | undefined;

Deno.serve(async (request: Request) => {
  try {
    handler ??= createAdminUserHandler(
      createRuntimeDependencies(loadConfiguration()),
    );
    return await handler(request);
  } catch {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "CONFIGURATION_ERROR",
          message: "管理员服务配置不完整",
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
});
