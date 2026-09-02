const DEFAULT_MESSAGES = Object.freeze({
  AUTHENTICATION_REQUIRED: '请提供系统账号和密码。',
  AUTHENTICATION_FAILED: '账号或密码错误。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  SESSION_EXPIRED: '登录会话已失效，请重新连接。',
  INVALID_ARGUMENT: '请求参数无效。',
  CONFIRMATION_REQUIRED: '该写入操作需要先执行预览确认。',
  CONFIRMATION_INVALID: '确认令牌无效、已过期或已使用，请重新执行预览。',
  VERSION_CONFLICT: '数据已被其他用户修改，请重新读取并确认。',
  PERMISSION_DENIED: '当前账号无权执行该写入操作。',
  REQUEST_IN_FLIGHT: '同一请求正在执行中，请稍后重试。',
  SERVICE_NOT_READY: '服务依赖尚未就绪，请稍后重试。',
  MCP_VALIDATION: '数据库拒绝了无效的任务数据。',
  TASK_PERIOD_MISMATCH: 'targetWeeks 与任务日期派生周不一致。',
  RPC_NOT_CONFIGURED: '所需数据库接口尚未启用，请先完成当前版本迁移后重试。',
  USER_NOT_FOUND: '未找到匹配的用户，请检查姓名和部门名称。',
  USER_NAME_AMBIGUOUS: '姓名存在同名用户，请补充部门名称。',
  DEPARTMENT_NOT_FOUND: '未找到匹配的部门，请检查部门名称。',
  DEPARTMENT_NAME_AMBIGUOUS: '部门名称存在重复，请使用部门 ID。',
  DATA_ACCESS_FAILED: '数据读取失败，请稍后重试。',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试。',
});

export class AppError extends Error {
  constructor(code, message = DEFAULT_MESSAGES[code] ?? DEFAULT_MESSAGES.INTERNAL_ERROR, status = 500, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (details && typeof details === 'object' && !Array.isArray(details)) this.details = details;
  }
}

export function toPublicError(error) {
  if (error instanceof AppError && DEFAULT_MESSAGES[error.code]) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details && typeof error.details === 'object' ? { details: error.details } : {}),
    };
  }
  return { code: 'INTERNAL_ERROR', message: DEFAULT_MESSAGES.INTERNAL_ERROR };
}

export function authenticationRequired() {
  return new AppError('AUTHENTICATION_REQUIRED', DEFAULT_MESSAGES.AUTHENTICATION_REQUIRED, 401);
}

export function authenticationFailed() {
  return new AppError('AUTHENTICATION_FAILED', DEFAULT_MESSAGES.AUTHENTICATION_FAILED, 401);
}

export function sessionExpired() {
  return new AppError('SESSION_EXPIRED', DEFAULT_MESSAGES.SESSION_EXPIRED, 401);
}
