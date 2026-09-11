const getErrorMessageText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : '';
  }
  return '';
};

const getErrorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.trim().toLowerCase() : '';
};

const getErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
};

export const getLoginUserFacingError = (error: unknown): string => {
  const code = getErrorCode(error);
  const status = getErrorStatus(error);
  const message = getErrorMessageText(error).trim().toLowerCase();

  if (
    status === 429 ||
    code.includes('rate_limit') ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  ) {
    return '登录尝试过于频繁，请稍后再试';
  }

  if (
    status === 400 ||
    ['invalid_credentials', 'email_not_confirmed'].includes(code) ||
    message.includes('invalid login credentials') ||
    message.includes('email not confirmed')
  ) {
    return '账号或密码错误，请重新输入';
  }

  if (
    message.includes('failed to fetch') ||
    message.includes('network error') ||
    message.includes('network request failed') ||
    message.includes('fetch failed')
  ) {
    return '网络异常，请检查网络连接后重试';
  }

  return '登录失败，请稍后重试';
};

export const getUserFacingError = (error: unknown, fallback = '操作失败，请稍后重试'): string => {
  const rawMessage = getErrorMessageText(error).trim();
  if (!rawMessage) return fallback;
  if (
    rawMessage.includes('无权限') ||
    rawMessage.includes('权限不足') ||
    rawMessage.includes('没有权限') ||
    rawMessage.includes('禁止访问') ||
    rawMessage.includes('禁止操作')
  ) {
    return '您暂无权限执行该操作，请联系管理员检查权限配置';
  }

  if (/[\u4e00-\u9fff]/.test(rawMessage)) return rawMessage;

  const lowerMessage = rawMessage.toLowerCase();

  if (
    lowerMessage.includes('row-level security policy') ||
    lowerMessage.includes('violates row level security policy') ||
    lowerMessage.includes('violates row-level security policy') ||
    lowerMessage.includes('permission denied') ||
    lowerMessage.includes('not authorized') ||
    lowerMessage.includes('forbidden')
  ) {
    return '您暂无权限执行该操作，请联系管理员检查权限配置';
  }

  if (
    lowerMessage.includes('invalid login credentials') ||
    lowerMessage.includes('email not confirmed') ||
    lowerMessage.includes('invalid_credentials')
  ) {
    return '账号或密码错误，请重新输入';
  }

  if (
    lowerMessage.includes('jwt expired') ||
    lowerMessage.includes('invalid jwt') ||
    lowerMessage.includes('auth session missing') ||
    lowerMessage.includes('session expired')
  ) {
    return '登录状态已失效，请重新登录后再试';
  }

  if (
    lowerMessage.includes('failed to fetch') ||
    lowerMessage.includes('network error') ||
    lowerMessage.includes('network request failed') ||
    lowerMessage.includes('fetch failed')
  ) {
    return '网络异常，请检查网络连接后重试';
  }

  if (
    lowerMessage.includes('duplicate key') ||
    lowerMessage.includes('already exists') ||
    lowerMessage.includes('unique constraint')
  ) {
    return '数据已存在，请勿重复提交';
  }

  if (
    lowerMessage.includes('foreign key constraint') ||
    lowerMessage.includes('violates foreign key constraint')
  ) {
    return '关联数据不存在或已失效，请刷新页面后重试';
  }

  if (lowerMessage.includes('timeout')) {
    return '请求超时，请稍后重试';
  }

  if (lowerMessage.includes('password should be at least 6 characters')) {
    return '密码至少需要 6 位';
  }

  return fallback;
};
