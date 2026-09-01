import { AppError } from '../../errors.mjs';

export const MAX_VISIBLE_TASK_SCAN = 10_000;

export function clampInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), maximum);
}

export function decodeCursor(value) {
  if (!value) return {};
  if (typeof value !== 'string' || value.length > 512) throw new AppError('INVALID_ARGUMENT', '分页游标无效。');
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(decoded?.updatedAt) || typeof decoded?.id !== 'string' || decoded.id.length === 0) {
      throw new Error('invalid cursor');
    }
    return { updatedAt: decoded.updatedAt, id: decoded.id };
  } catch {
    throw new AppError('INVALID_ARGUMENT', '分页游标无效。');
  }
}

export function encodeCursor(value) {
  if (!value || !Number.isSafeInteger(Number(value.updatedAt)) || typeof value.id !== 'string' || value.id.length === 0) {
    return null;
  }
  return Buffer.from(JSON.stringify({ updatedAt: Number(value.updatedAt), id: value.id })).toString('base64url');
}

export function safeDiagnosticCode(error) {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : 'UNKNOWN';
}

export function dataAccessError(error, message = '数据读取失败，请稍后重试。', status = 502) {
  const appError = new AppError('DATA_ACCESS_FAILED', message, status);
  appError.diagnosticCode = safeDiagnosticCode(error);
  return appError;
}

export function isMissingFunction(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return error?.code === 'PGRST202' || error?.code === '42883'
    || /could not find the function|function .* does not exist|schema cache/i.test(message);
}

export function mapRpcError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (isMissingFunction(error)) {
    const result = new AppError('RPC_NOT_CONFIGURED', undefined, 503);
    result.diagnosticCode = 'RPC_NOT_FOUND';
    return result;
  }
  if (message.startsWith('MCP_PERMISSION_DENIED:')) return new AppError('PERMISSION_DENIED');
  if (message.startsWith('MCP_VALIDATION:')) return new AppError('MCP_VALIDATION', undefined, 400);
  if (message.startsWith('MCP_USER_NOT_FOUND:')) return new AppError('USER_NOT_FOUND');
  if (message.startsWith('MCP_USER_NAME_AMBIGUOUS:')) return new AppError('USER_NAME_AMBIGUOUS');
  if (message.startsWith('MCP_DEPARTMENT_NOT_FOUND:')) return new AppError('DEPARTMENT_NOT_FOUND');
  if (message.startsWith('MCP_DEPARTMENT_NAME_AMBIGUOUS:')) return new AppError('DEPARTMENT_NAME_AMBIGUOUS');
  return dataAccessError(error);
}

export function assertResult(result) {
  if (result?.error) throw dataAccessError(result.error);
  return result?.data ?? [];
}

export function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(dataAccessError(
      { code: 'TIMEOUT' },
      '数据读取超时，请稍后重试。',
      504,
    )), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export function createRepositoryExecutor({ createUserClient, getContext, logger = console }) {
  return async function execute(operationName, operation) {
    try {
      const context = getContext();
      if (!context?.accessToken) throw new AppError('SESSION_EXPIRED', '登录会话已失效，请重新连接。', 401);
      const client = createUserClient(context.accessToken);
      return await operation(client, context);
    } catch (error) {
      const publicError = error instanceof AppError ? error : dataAccessError(error);
      if (publicError.code === 'DATA_ACCESS_FAILED') {
        logger.error?.({
          event: 'supabase_query_failed',
          operation: operationName,
          code: publicError.diagnosticCode ?? 'UNKNOWN',
        });
      }
      throw publicError;
    }
  };
}
