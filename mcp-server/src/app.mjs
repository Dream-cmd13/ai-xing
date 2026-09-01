import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { parseBasicAuthorization } from './basic-auth.mjs';
import { ConfirmationStore } from './confirmation-store.mjs';
import { AppError, toPublicError } from './errors.mjs';
import { createSessionMcpServer } from './mcp-server.mjs';
import { createReadRepository } from './repository.mjs';
import { createIdentityRepository } from './identity-repository.mjs';
import { createWriteRepository } from './write-repository.mjs';
import { createSessionId } from './session-registry.mjs';
import { FixedWindowRateLimiter } from './rate-limiter.mjs';

function jsonRpcSessionError(res, status = 400, code = -32000, message = '无效或已过期的 MCP Session。', dataCode = 'SESSION_EXPIRED') {
  return res.status(status).json({
    jsonrpc: '2.0',
    id: null,
    error: {
      code,
      message,
      data: { code: dataCode },
    },
  });
}

function publicHttpError(res, error, extraHeaders = {}) {
  const payload = toPublicError(error);
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  return res.status(error instanceof AppError ? error.status : 500).json({ error: payload });
}

function isHttpsRequest(req) {
  if (req.socket?.encrypted) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return protocol?.trim().toLowerCase() === 'https';
}

export function createMcpHttpApp({
  config,
  authProvider,
  sessionRegistry,
  rateLimiter,
  initializeRateLimiter,
  readRateLimiter,
  writeRateLimiter,
  createTransport = (options) => new StreamableHTTPServerTransport(options),
  createRepository = createReadRepository,
  createWriteRepository: createWriteRepositoryFactory = createWriteRepository,
  createServer = createSessionMcpServer,
  confirmationStore = new ConfirmationStore({ ttlMs: config.confirmationTtlMs ?? 10 * 60 * 1000 }),
  logger = console,
}) {
  sessionRegistry.setOnSessionDestroyed?.((sessionId) => confirmationStore.revokeSession(sessionId));
  const initLimiter = initializeRateLimiter ?? rateLimiter ?? new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs ?? 60_000,
    max: config.initializeRateLimitMax ?? config.rateLimitMax ?? 30,
  });
  const readLimiter = readRateLimiter ?? new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs ?? 60_000,
    max: config.readRateLimitMax ?? config.rateLimitMax ?? 30,
  });
  const writeLimiter = writeRateLimiter ?? new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs ?? 60_000,
    max: config.writeRateLimitMax ?? config.rateLimitMax ?? 30,
  });
  let draining = false;
  let activeRequests = 0;
  let drainWaiters = [];
  const writeTools = new Set([
    'prepare_create_pad_task', 'commit_create_pad_task',
    'prepare_update_pad_task', 'commit_update_pad_task',
    'submit_pad_task', 'save_review_record',
  ]);
  const notifyDrained = () => {
    if (activeRequests !== 0) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    waiters.forEach((resolve) => resolve());
  };
  const waitForDrain = (timeoutMs) => new Promise((resolve) => {
    if (activeRequests === 0) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    drainWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  const consumeSessionRateLimit = (req, record, body) => {
    const method = body?.method;
    const toolName = body?.params?.name;
    const isWrite = method === 'tools/call' && writeTools.has(toolName);
    const limiter = isWrite ? writeLimiter : readLimiter;
    const category = isWrite ? 'write' : 'read';
    const key = `${req.ip ?? req.socket.remoteAddress ?? 'unknown'}:${record.context?.userId ?? 'unknown'}:${category}`;
    return limiter.consume(key);
  };
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });

  app.use((req, res, next) => {
    // GET /mcp is a long-lived SSE stream. It is closed through the session
    // registry during shutdown and must not block the short request drain.
    const longLivedTransport = req.method === 'GET' && req.path === '/mcp';
    if (!longLivedTransport) {
      activeRequests += 1;
      res.once('finish', () => {
        activeRequests = Math.max(activeRequests - 1, 0);
        notifyDrained();
      });
    }
    const startedAt = Date.now();
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.once('finish', () => {
      const sessionHeader = req.headers['mcp-session-id'];
      logger.info?.({
        event: 'http_request',
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        // 仅记录布尔状态（是否携带 MCP session 头），用于诊断 session 复用，不记录 token 本体。
        hasSessionId: Boolean(Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader),
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'ai-xing-okr-mcp',
      version: '0.2.0',
      port: config.port ?? null,
      responseMode: config.enableJsonResponse === false ? 'sse' : 'json',
      draining,
    });
  });

  app.get('/ready', async (_req, res) => {
    if (draining) return res.status(503).json({ status: 'draining' });
    if (typeof authProvider.checkReadiness !== 'function') {
      return res.status(503).json({ status: 'degraded', reason: 'READINESS_CHECK_NOT_CONFIGURED' });
    }
    try {
      const readiness = await Promise.race([
        Promise.resolve(authProvider.checkReadiness()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), config.requestTimeoutMs ?? 15_000)),
      ]);
      const ready = readiness?.status === 'ready';
      return res.status(ready ? 200 : 503).json(readiness);
    } catch {
      return res.status(503).json({ status: 'degraded', reason: 'READINESS_CHECK_FAILED' });
    }
  });

  app.use('/mcp', (req, res, next) => {
    if (!config.requireHttps || isHttpsRequest(req)) return next();
    res.setHeader('Upgrade', 'TLS/1.2');
    return res.status(426).json({
      error: { code: 'HTTPS_REQUIRED', message: 'MCP 只允许通过 HTTPS 访问。' },
    });
  });

  async function existingSession(req, res, body) {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (!sessionId) return jsonRpcSessionError(res);
    let record;
    try {
      record = await sessionRegistry.ensureReady(sessionId);
    } catch {
      // 会话不存在 / TTL 过期 / token 刷新失败：按 MCP 规范与 SDK 的 validateSession
      // 行为返回 404 Session not found。客户端（如 TRAE）收到 404 才会自动重新
      // initialize；返回 400 会被当作不可恢复错误，直接丢弃整个 MCP 连接。
      logger.error?.({
        event: 'mcp_session_request_failed',
        code: 'SESSION_REQUEST_FAILED',
        method: req.method,
        hasSessionId: true,
      });
      if (res.headersSent) {
        res.destroy();
        return undefined;
      }
      return jsonRpcSessionError(res, 404, -32001, 'Session not found');
    }
    if (draining) return res.status(503).json({ error: { code: 'SERVICE_DRAINING', message: '服务正在平滑停止，请稍后重试。' } });
    const rate = consumeSessionRateLimit(req, record, body);
    if (!rate.allowed) {
      const error = new AppError('RATE_LIMITED', '请求过于频繁，请稍后重试。', 429);
      return publicHttpError(res, error, {
        'Retry-After': String(Math.max(Math.ceil(rate.retryAfterMs / 1000), 1)),
      });
    }
    try {
      await record.transport.handleRequest(req, res, body);
      return undefined;
    } catch {
      logger.error?.({
        event: 'mcp_session_request_failed',
        code: 'SESSION_REQUEST_FAILED',
        method: req.method,
        hasSessionId: true,
      });
      if (res.headersSent) {
        // transport 已经开始写响应：只能断开连接，不能再叠加一个 400。
        res.destroy();
        return undefined;
      }
      return jsonRpcSessionError(res);
    }
  }

  app.post('/mcp', async (req, res) => {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const wantsInitialize = isInitializeRequest(req.body);
    if (sessionId && !wantsInitialize) return existingSession(req, res, req.body);
    if (!wantsInitialize) return jsonRpcSessionError(res);
    if (draining) return res.status(503).json({ error: { code: 'SERVICE_DRAINING', message: '服务正在平滑停止，请稍后重试。' } });
    if (sessionId && sessionRegistry.get(sessionId)) {
      // 客户端重连时可能携带旧 session-id 重新 initialize。SDK 默认对已初始化的
      // transport 返回 400，会让部分客户端（如 TRAE）判定服务不可用并丢弃连接。
      // 这里回收旧会话后按全新初始化处理，保证客户端总能拿到可用的新会话。
      await sessionRegistry.remove(sessionId);
      logger.info?.({ event: 'mcp_session_recycled', code: 'REINITIALIZE' });
    }

    let credentials;
    try {
      credentials = parseBasicAuthorization(req.headers.authorization);
    } catch (error) {
      return publicHttpError(res, error, {
        'WWW-Authenticate': 'Basic realm="AI Xing MCP", charset="UTF-8"',
      });
    }

    const rateKey = `${req.ip ?? req.socket.remoteAddress ?? 'unknown'}:${credentials.username}`;
    const rate = initLimiter.consume(rateKey);
    if (!rate.allowed) {
      const error = new AppError('RATE_LIMITED', '请求过于频繁，请稍后重试。', 429);
      return publicHttpError(res, error, {
        'Retry-After': String(Math.max(Math.ceil(rate.retryAfterMs / 1000), 1)),
      });
    }

    let transport;
    let server;
    let registeredSessionId;
    try {
      const authContext = await authProvider.authenticate(credentials);
      let sessionRecord = null;
      const getContext = () => sessionRecord?.context ?? authContext;
      const createUserClient = (token) => authProvider.createUserClient(token);
      const identityRepository = createIdentityRepository({
        createUserClient,
        getContext,
        requestTimeoutMs: config.requestTimeoutMs,
        logger,
      });
      const repository = createRepository({
        createUserClient,
        getContext,
        requestTimeoutMs: config.requestTimeoutMs,
        logger,
        identityRepository,
      });
      const writeRepository = createWriteRepositoryFactory({
        createUserClient,
        getContext,
        requestTimeoutMs: config.requestTimeoutMs,
        logger,
        identityRepository,
      });
      server = createServer(repository, writeRepository, confirmationStore);
      transport = createTransport({
        sessionIdGenerator: createSessionId,
        enableJsonResponse: config.enableJsonResponse ?? true,
        keepAliveMs: config.sseKeepAliveMs ?? 15_000,
        onsessioninitialized: (sessionId) => {
          registeredSessionId = sessionId;
          sessionRegistry.register(sessionId, { transport, server, context: { ...authContext, sessionId } });
          sessionRecord = sessionRegistry.get(sessionId);
        },
      });
      transport.onerror = () => {
        logger.error?.({
          event: 'mcp_transport_error',
          code: 'TRANSPORT_ERROR',
          hasSessionId: Boolean(transport.sessionId ?? registeredSessionId),
        });
      };
      transport.onclose = () => {
        const sessionId = transport.sessionId ?? registeredSessionId;
        logger.info?.({
          event: 'mcp_transport_closed',
          hasSessionId: Boolean(sessionId),
        });
        if (sessionId) {
          const record = sessionRegistry.get(sessionId);
          sessionRegistry.handleTransportClosed(sessionId);
          void record?.server?.close?.().catch?.(() => {});
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return undefined;
    } catch (error) {
      if (registeredSessionId) await sessionRegistry.remove(registeredSessionId);
      else {
        await transport?.close?.().catch(() => {});
        await server?.close?.().catch(() => {});
      }
      return publicHttpError(res, error, {
        'WWW-Authenticate': 'Basic realm="AI Xing MCP", charset="UTF-8"',
      });
    }
  });

  app.get('/mcp', (req, res) => existingSession(req, res));

  app.delete('/mcp', async (req, res) => {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (!sessionId) return jsonRpcSessionError(res);
    try {
      const record = await sessionRegistry.ensureReady(sessionId);
      await record.transport.handleRequest(req, res);
      if (sessionRegistry.get(sessionId)) await sessionRegistry.remove(sessionId);
      return undefined;
    } catch {
      // 会话已失效：同样返回 404，让客户端走重新 initialize 流程。
      return jsonRpcSessionError(res, 404, -32001, 'Session not found');
    }
  });

  app.use((error, _req, res, _next) => {
    logger.error?.({ event: 'http_error', code: 'INTERNAL_ERROR' });
    if (!res.headersSent) publicHttpError(res, error);
  });

  const cleanupTimer = setInterval(() => {
    initLimiter.cleanup();
    readLimiter.cleanup();
    writeLimiter.cleanup();
    confirmationStore.cleanupExpired();
    void sessionRegistry.cleanupExpired();
  }, Math.min(config.rateLimitWindowMs, 60_000));
  cleanupTimer.unref?.();

  return {
    app,
    async close() {
      clearInterval(cleanupTimer);
      draining = true;
      await waitForDrain(config.drainTimeoutMs ?? 10_000);
      await sessionRegistry.closeAll();
    },
    setDraining() {
      draining = true;
    },
    get draining() {
      return draining;
    },
  };
}
