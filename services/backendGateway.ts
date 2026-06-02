import { supabase } from "../supabase";

type BackendTarget = "flask" | "edge";

type ErrorShape = {
  code?: string;
  message?: string;
  details?: unknown;
};

type SuccessEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: ErrorShape | string;
  reply?: string;
  provider?: string;
  model?: string;
};

export type AIChatPayload = {
  prompt: string;
  provider?: "gemini" | "deepseek";
  model?: string;
};

export type AIChatResult = {
  reply: string;
  provider?: string;
  model?: string;
};

export type CreateAdminUserPayload = {
  username: string;
  name: string;
  role: string;
  departmentId?: string;
};

export type AdminUserResponse = {
  userId: string;
  authId: string;
  email: string;
  temporaryPassword: string;
};

export type ResetPasswordResponse = {
  authId: string;
  temporaryPassword: string;
};

const backendTarget = ((import.meta.env.VITE_BACKEND_TARGET || "flask").trim().toLowerCase() ||
  "flask") as BackendTarget;

const backendBaseUrl =
  (import.meta.env.VITE_BACKEND_API_BASE_URL || import.meta.env.VITE_FLASK_API_BASE_URL || "").trim();

const getSessionToken = async (): Promise<string> => {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message || "获取登录态失败");
  const token = data.session?.access_token;
  if (!token) throw new Error("当前未登录或登录态已过期");
  return token;
};

const normalizeErrorMessage = (payload: SuccessEnvelope<unknown> | null, fallback: string): string => {
  if (!payload) return fallback;
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  if (payload.error?.message) return payload.error.message;
  return fallback;
};

const ensureBackendBaseUrl = () => {
  if (!backendBaseUrl) {
    throw new Error("缺少后端地址配置，请设置 VITE_BACKEND_API_BASE_URL。");
  }
};

const postToRest = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
  ensureBackendBaseUrl();
  const token = await getSessionToken();
  const response = await fetch(`${backendBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as SuccessEnvelope<T> | null;
  if (!response.ok || !payload?.success) {
    throw new Error(normalizeErrorMessage(payload, "后端请求失败"));
  }

  return (payload.data || (payload as T)) as T;
};

export const chatWithAI = async (payload: AIChatPayload): Promise<AIChatResult> => {
  if (backendTarget === "edge") {
    const { data, error } = await supabase.functions.invoke("ai-chat", { body: payload });
    if (error) throw new Error(error.message || "AI 调用失败");
    if (data?.success && data?.data) return data.data;
    if (typeof data?.reply === "string") {
      return { reply: data.reply, provider: data.provider, model: data.model };
    }
    throw new Error("AI 响应格式不正确");
  }

  return postToRest<AIChatResult>("/api/ai/chat", payload);
};

export const createAdminUser = async (
  payload: CreateAdminUserPayload
): Promise<AdminUserResponse> => {
  if (backendTarget === "edge") {
    const { data, error } = await supabase.functions.invoke("admin-user-manager", {
      body: { action: "create_user", ...payload },
    });
    if (error || !data?.success) {
      throw new Error(error?.message || data?.error?.message || data?.error || "创建用户失败");
    }
    return data.data;
  }

  return postToRest<AdminUserResponse>("/api/admin/users", payload);
};

export const resetAdminUserPassword = async (
  authId: string
): Promise<ResetPasswordResponse> => {
  if (backendTarget === "edge") {
    const { data, error } = await supabase.functions.invoke("admin-user-manager", {
      body: { action: "reset_password", auth_id: authId },
    });
    if (error || !data?.success) {
      throw new Error(error?.message || data?.error?.message || data?.error || "重置密码失败");
    }
    return data.data;
  }

  return postToRest<ResetPasswordResponse>("/api/admin/users/reset-password", { authId });
};
