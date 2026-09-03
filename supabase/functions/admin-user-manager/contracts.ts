export const DEFAULT_PASSWORD = "888888";

export const ADMIN_USER_ROLES = ["Admin", "Manager", "Employee"] as const;
export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];

export type AdminUserErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_ACTION"
  | "INVALID_ROLE"
  | "METHOD_NOT_ALLOWED"
  | "ORIGIN_NOT_ALLOWED"
  | "AUTH_REQUIRED"
  | "ADMIN_REQUIRED"
  | "DEPARTMENT_NOT_FOUND"
  | "USER_ALREADY_EXISTS"
  | "AUTH_CREATE_FAILED"
  | "BUSINESS_USER_CREATE_FAILED"
  | "CREATE_COMPENSATION_FAILED"
  | "TARGET_USER_NOT_FOUND"
  | "SELF_RESET_NOT_ALLOWED"
  | "PASSWORD_RESET_FAILED"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

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

export type AuthCreateInput = {
  email: string;
  password: string;
  name: string;
  username: string;
  role: AdminUserRole;
};

export type BusinessUserInsert = {
  id: string;
  authId: string;
  username: string;
  name: string;
  role: AdminUserRole;
  departmentId?: string;
};

export interface AdminUserDependencies {
  findUserByUsername(username: string): Promise<{ id: string } | null>;
  departmentExists(departmentId: string): Promise<boolean>;
  createAuthUser(
    input: AuthCreateInput,
  ): Promise<{ id: string; email: string }>;
  deleteAuthUser(authId: string): Promise<void>;
  insertBusinessUser(input: BusinessUserInsert): Promise<void>;
  findUserByAuthId(
    authId: string,
  ): Promise<{ id: string; authId: string } | null>;
  updateAuthPassword(authId: string, password: string): Promise<void>;
  createId(): string;
}

export type CreateUserResult = {
  userId: string;
  authId: string;
  email: string;
  temporaryPassword: string;
};

export type ResetPasswordResult = {
  authId: string;
  temporaryPassword: string;
};
