const DEFAULT_MESSAGES = Object.freeze({
  AUTHENTICATION_REQUIRED: '请提供系统账号和密码。',
  AUTHENTICATION_FAILED: '账号或密码错误。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  SESSION_EXPIRED: '登录会话已失效，请重新连接。',
  INVALID_ARGUMENT: '请求参数无效。',
  DATA_ACCESS_FAILED: '数据读取失败，请稍后重试。',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试。',
});

export class AppError extends Error {
  constructor(code, message = DEFAULT_MESSAGES[code] ?? DEFAULT_MESSAGES.INTERNAL_ERROR, status = 500) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function toPublicError(error) {
  if (error instanceof AppError && DEFAULT_MESSAGES[error.code]) {
    return { code: error.code, message: error.message };
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
