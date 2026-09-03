import {
  type AdminUserDependencies,
  AdminUserError,
  type AdminUserErrorCode,
} from "./contracts.ts";
import { createUser, resetPassword } from "./service.ts";

export type HandlerLogEntry = {
  requestId: string;
  action?: string;
  callerAuthId?: string;
  code?: AdminUserErrorCode;
  status: number;
};

export type AdminUserHandlerDependencies = {
  authenticate(token: string): Promise<{ id: string }>;
  isAdmin(token: string): Promise<boolean>;
  adminUser: AdminUserDependencies;
  allowedOrigins: ReadonlySet<string>;
  createRequestId(): string;
  log?(entry: HandlerLogEntry): void;
};

type ErrorEnvelope = {
  success: false;
  error: { code: AdminUserErrorCode; message: string };
  requestId: string;
};

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function getCorsHeaders(origin: string | null, allowed: boolean): HeadersInit {
  return {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    ...(origin && allowed
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {}),
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function errorResponse(
  error: AdminUserError,
  requestId: string,
  corsHeaders: HeadersInit,
): Response {
  const body: ErrorEnvelope = {
    success: false,
    error: { code: error.code, message: error.message },
    requestId,
  };
  return jsonResponse(body, error.status, corsHeaders);
}

export function createAdminUserHandler(
  dependencies: AdminUserHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = dependencies.createRequestId();
    const origin = request.headers.get("origin");
    const originAllowed = !origin || dependencies.allowedOrigins.has(origin);
    const corsHeaders = getCorsHeaders(origin, originAllowed);
    let action: string | undefined;
    let callerAuthId: string | undefined;

    try {
      if (!originAllowed) {
        throw new AdminUserError(
          "ORIGIN_NOT_ALLOWED",
          "当前请求来源不在允许列表中",
          403,
        );
      }

      if (request.method === "OPTIONS") {
        dependencies.log?.({ requestId, status: 204 });
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (request.method !== "POST") {
        throw new AdminUserError(
          "METHOD_NOT_ALLOWED",
          "仅支持 POST 请求",
          405,
        );
      }

      const contentType = request.headers.get("content-type")?.toLowerCase() ??
        "";
      if (!contentType.includes("application/json")) {
        throw new AdminUserError(
          "INVALID_REQUEST",
          "Content-Type 必须为 application/json",
          400,
        );
      }

      const token = getBearerToken(request);
      if (!token) {
        throw new AdminUserError("AUTH_REQUIRED", "登录状态无效或已过期", 401);
      }

      try {
        const caller = await dependencies.authenticate(token);
        callerAuthId = caller.id;
      } catch {
        throw new AdminUserError("AUTH_REQUIRED", "登录状态无效或已过期", 401);
      }

      let admin = false;
      try {
        admin = await dependencies.isAdmin(token);
      } catch {
        admin = false;
      }
      if (!admin) {
        throw new AdminUserError(
          "ADMIN_REQUIRED",
          "仅管理员可以执行此操作",
          403,
        );
      }

      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new AdminUserError("INVALID_REQUEST", "请求内容格式不正确", 400);
      }

      action = typeof body.action === "string" ? body.action : undefined;
      let data: unknown;
      if (action === "create_user") {
        data = await createUser(body, dependencies.adminUser);
      } else if (action === "reset_password") {
        data = await resetPassword(body, callerAuthId, dependencies.adminUser);
      } else {
        throw new AdminUserError("INVALID_ACTION", "不支持的管理员操作", 400);
      }

      dependencies.log?.({ requestId, action, callerAuthId, status: 200 });
      return jsonResponse({ success: true, data, requestId }, 200, corsHeaders);
    } catch (cause) {
      const error = cause instanceof AdminUserError
        ? cause
        : new AdminUserError("INTERNAL_ERROR", "管理员操作执行失败", 500);
      dependencies.log?.({
        requestId,
        action,
        callerAuthId,
        code: error.code,
        status: error.status,
      });
      return errorResponse(error, requestId, corsHeaders);
    }
  };
}
