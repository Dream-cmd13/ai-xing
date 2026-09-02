import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { config as loadDotEnv } from 'dotenv';

import { createMcpHttpApp } from './app.mjs';
import { createSupabaseAuthProvider } from './auth-provider.mjs';
import { loadConfig } from './config.mjs';
import { ConfirmationStore } from './confirmation-store.mjs';
import { FixedWindowRateLimiter } from './rate-limiter.mjs';
import { collectPortDriftWarnings } from './port-drift.mjs';
import { SessionRegistry } from './session-registry.mjs';

function writeLog(stream, event) {
  stream.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

const SENSITIVE_ERROR_VALUE = /((?:authorization|password|passphrase|secret|token|refresh[_-]?token|access[_-]?token|api[_-]?key|database[_-]?url)\s*[:=]\s*)[^\s,;&]+/gi;
const SENSITIVE_QUERY_VALUE = /([?&](?:authorization|password|secret|token|refresh[_-]?token|access[_-]?token|api[_-]?key|key)=)[^&\s]+/gi;
const SENSITIVE_BEARER_VALUE = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const URL_VALUE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s,;]+/gi;

function redactErrorMessage(message) {
  return String(message)
    .replace(SENSITIVE_ERROR_VALUE, '$1<redacted>')
    .replace(SENSITIVE_QUERY_VALUE, '$1<redacted>')
    .replace(SENSITIVE_BEARER_VALUE, '$1 <redacted>')
    .replace(JWT_VALUE, '<redacted>')
    .replace(URL_VALUE, '<redacted-url>')
    .slice(0, 300);
}

/**
 * 将启动/运行期错误压缩成可诊断但不含凭据的字段。
 * 不记录 stack 或任意自定义属性，避免把连接串、Token 等带进日志。
 */
export function toSafeErrorLog(error) {
  const details = {};
  if (typeof error?.name === 'string' && error.name.trim()) details.errorName = error.name.trim().slice(0, 80);
  if (typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) details.errorCode = error.code;
  if (typeof error?.syscall === 'string' && error.syscall.trim()) details.syscall = error.syscall.trim().slice(0, 80);
  if (typeof error?.address === 'string' && error.address.trim()) details.address = error.address.trim().slice(0, 80);
  if (Number.isInteger(error?.port) && error.port > 0 && error.port <= 65_535) details.port = error.port;
  if (typeof error?.message === 'string' && error.message.trim()) details.errorMessage = redactErrorMessage(error.message);
  return details;
}

export const safeLogger = Object.freeze({
  info: (event) => writeLog(process.stdout, event),
  error: (event) => writeLog(process.stderr, event),
});

export function startHttpServer({ app, config, logger = safeLogger }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host);
    const onError = (error) => {
      logger.error?.({
        event: 'mcp_server_listen_failed',
        host: config.host,
        port: config.port,
        ...toSafeErrorLog(error),
      });
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      let closed = false;
      const address = server.address();
      logger.info?.({
        event: 'mcp_server_started',
        host: typeof address === 'object' && address ? address.address : config.host,
        port: typeof address === 'object' && address ? address.port : config.port,
      });
      resolve({
        server,
        address,
        close: () => new Promise((closeResolve, closeReject) => {
          if (closed) return closeResolve();
          closed = true;
          server.close((error) => {
            if (error) return closeReject(error);
            logger.info?.({ event: 'mcp_server_stopped' });
            return closeResolve();
          });
        }),
      });
    });
  });
}

const defaultServerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadEnvironmentFiles({ serverRoot = defaultServerRoot, loader = loadDotEnv } = {}) {
  loader({
    path: path.join(serverRoot, '.env'),
    override: false,
    quiet: true,
  });
}

export async function main() {
  loadEnvironmentFiles();
  const config = loadConfig(process.env);
  const authProvider = createSupabaseAuthProvider({ config });
  const confirmationStore = new ConfirmationStore({ ttlMs: config.confirmationTtlMs });
  const sessionRegistry = new SessionRegistry({
    ttlMs: config.sessionTtlMs,
    refreshWindowMs: config.refreshWindowMs,
    authProvider,
    onSessionDestroyed: (sessionId) => confirmationStore.revokeSession(sessionId),
  });
  const rateLimiter = new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
  });
  const initializeRateLimiter = new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.initializeRateLimitMax,
  });
  const readRateLimiter = new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.readRateLimitMax,
  });
  const writeRateLimiter = new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.writeRateLimitMax,
  });
  const application = createMcpHttpApp({
    config,
    authProvider,
    sessionRegistry,
    rateLimiter,
    initializeRateLimiter,
    readRateLimiter,
    writeRateLimiter,
    confirmationStore,
    logger: safeLogger,
  });
  const runtime = await startHttpServer({ app: application.app, config, logger: safeLogger });

  // 启动自检：默认端口必须是 8787；若历史漂移端口（8878）仍有旧进程监听，
  // 记录告警事件，便于定位“客户端连错端口”类故障。日志只含事件名与端口。
  for (const warning of await collectPortDriftWarnings({ activePort: config.port })) {
    safeLogger.error(warning);
  }

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    safeLogger.info({ event: 'mcp_server_shutdown', signal });
    application.setDraining?.();
    const httpClose = runtime.close();
    await application.close();
    await httpClose;
  };
  const handleSignal = (signal) => {
    void stop(signal).catch((error) => {
      safeLogger.error({
        event: 'mcp_server_shutdown_failed',
        signal,
        ...toSafeErrorLog(error),
      });
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  return { ...runtime, application, stop };
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryUrl === import.meta.url) {
  process.once('beforeExit', (code) => {
    safeLogger.info({ event: 'mcp_process_before_exit', exitCode: code });
  });
  main().catch((error) => {
    safeLogger.error({
      event: 'mcp_server_start_failed',
      ...toSafeErrorLog(error),
    });
    process.exitCode = 1;
  });
}
