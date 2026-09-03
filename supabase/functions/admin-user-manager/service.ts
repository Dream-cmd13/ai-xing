import {
  ADMIN_USER_ROLES,
  type AdminUserDependencies,
  AdminUserError,
  type AdminUserRole,
  type CreateUserResult,
  DEFAULT_PASSWORD,
  type ResetPasswordResult,
} from "./contracts.ts";

const USERNAME_PATTERN = /^[a-z0-9._-]{1,64}$/;
const AUTH_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CreateUserInput = {
  username: string;
  name: string;
  role: AdminUserRole;
  departmentId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCreateUserInput(input: unknown): CreateUserInput {
  if (!isRecord(input)) {
    throw new AdminUserError("INVALID_REQUEST", "创建用户参数格式不正确", 400);
  }

  const username = typeof input.username === "string"
    ? input.username.trim().toLowerCase()
    : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const role = typeof input.role === "string" ? input.role : "";
  const departmentId = typeof input.departmentId === "string"
    ? input.departmentId.trim()
    : "";

  if (!USERNAME_PATTERN.test(username)) {
    throw new AdminUserError(
      "INVALID_REQUEST",
      "用户名须为 1 至 64 位小写字母、数字、点、下划线或连字符",
      400,
    );
  }
  if (!name || name.length > 100) {
    throw new AdminUserError(
      "INVALID_REQUEST",
      "姓名须为 1 至 100 个字符",
      400,
    );
  }
  if (!ADMIN_USER_ROLES.includes(role as AdminUserRole)) {
    throw new AdminUserError("INVALID_ROLE", "用户角色不受支持", 400);
  }
  if (departmentId.length > 128) {
    throw new AdminUserError("INVALID_REQUEST", "部门标识格式不正确", 400);
  }

  return {
    username,
    name,
    role: role as AdminUserRole,
    ...(departmentId ? { departmentId } : {}),
  };
}

function parseResetInput(input: unknown): string {
  if (!isRecord(input)) {
    throw new AdminUserError("INVALID_REQUEST", "重置密码参数格式不正确", 400);
  }
  const authId = typeof input.auth_id === "string" ? input.auth_id.trim() : "";
  if (!AUTH_ID_PATTERN.test(authId)) {
    throw new AdminUserError("INVALID_REQUEST", "用户身份标识格式不正确", 400);
  }
  return authId;
}

export async function createUser(
  input: unknown,
  dependencies: AdminUserDependencies,
): Promise<CreateUserResult> {
  const request = parseCreateUserInput(input);
  const existingUser = await dependencies.findUserByUsername(request.username);
  if (existingUser) {
    throw new AdminUserError("USER_ALREADY_EXISTS", "用户名已存在", 409);
  }

  if (
    request.departmentId &&
    !(await dependencies.departmentExists(request.departmentId))
  ) {
    throw new AdminUserError("DEPARTMENT_NOT_FOUND", "所选部门不存在", 400);
  }

  const email = `${request.username}@app.local`;
  let authUser: { id: string; email: string };
  try {
    authUser = await dependencies.createAuthUser({
      email,
      password: DEFAULT_PASSWORD,
      name: request.name,
      username: request.username,
      role: request.role,
    });
  } catch {
    throw new AdminUserError("AUTH_CREATE_FAILED", "创建登录账号失败", 502);
  }

  const userId = dependencies.createId();
  try {
    await dependencies.insertBusinessUser({
      id: userId,
      authId: authUser.id,
      username: request.username,
      name: request.name,
      role: request.role,
      ...(request.departmentId ? { departmentId: request.departmentId } : {}),
    });
  } catch {
    try {
      await dependencies.deleteAuthUser(authUser.id);
    } catch {
      throw new AdminUserError(
        "CREATE_COMPENSATION_FAILED",
        "用户资料创建失败，且登录账号回滚失败，请联系管理员处理",
        500,
      );
    }
    throw new AdminUserError(
      "BUSINESS_USER_CREATE_FAILED",
      "创建用户资料失败",
      500,
    );
  }

  return {
    userId,
    authId: authUser.id,
    email: authUser.email || email,
    temporaryPassword: DEFAULT_PASSWORD,
  };
}

export async function resetPassword(
  input: unknown,
  callerAuthId: string,
  dependencies: AdminUserDependencies,
): Promise<ResetPasswordResult> {
  const authId = parseResetInput(input);
  if (authId === callerAuthId) {
    throw new AdminUserError(
      "SELF_RESET_NOT_ALLOWED",
      "不能在此处重置当前登录账号的密码",
      400,
    );
  }

  const targetUser = await dependencies.findUserByAuthId(authId);
  if (!targetUser || targetUser.authId !== authId) {
    throw new AdminUserError(
      "TARGET_USER_NOT_FOUND",
      "未找到已绑定的目标用户",
      404,
    );
  }

  try {
    await dependencies.updateAuthPassword(authId, DEFAULT_PASSWORD);
  } catch {
    throw new AdminUserError("PASSWORD_RESET_FAILED", "重置密码失败", 502);
  }

  return { authId, temporaryPassword: DEFAULT_PASSWORD };
}
