import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { parseBasicAuthorization } from './basic-auth.mjs';
import { AppError, toPublicError } from './errors.mjs';
import { createSessionMcpServer } from './mcp-server.mjs';
import { createReadRepository } from './repository.mjs';
import { createSessionId } from './session-registry.mjs';

function jsonRpcSessionError(res) {
  return res.status(400).json({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32000,
      message: '无效或已过期的 MCP Session。',
      data: { code: 'SESSION_EXPIRED' },
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
  createTransport = (options) => new StreamableHTTPServerTransport(options),
  createRepository = createReadRepository,
  createServer = createSessionMcpServer,
  logger = console,
}) {
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });

  app.use((req, res, next) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.once('finish', () => {
      logger.info?.({
        event: 'http_request',
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'ai-xing-okr-mcp', version: '0.1.0' });
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
    try {
      const record = await sessionRegistry.ensureReady(sessionId);
      await record.transport.handleRequest(req, res, body);
      return undefined;
    } catch {
      return jsonRpcSessionError(res);
    }
  }

  app.post('/mcp', async (req, res) => {
    if (req.headers['mcp-session-id']) return existingSession(req, res, req.body);
    if (!isInitializeRequest(req.body)) return jsonRpcSessionError(res);

    let credentials;
    try {
      credentials = parseBasicAuthorization(req.headers.authorization);
    } catch (error) {
      return publicHttpError(res, error, {
        'WWW-Authenticate': 'Basic realm="AI Xing MCP", charset="UTF-8"',
      });
    }

    const rateKey = `${req.ip ?? req.socket.remoteAddress ?? 'unknown'}:${credentials.username}`;
    const rate = rateLimiter.consume(rateKey);
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
      const repository = createRepository({
        createUserClient: (token) => authProvider.createUserClient(token),
        getContext: () => sessionRecord?.context ?? authContext,
        requestTimeoutMs: config.requestTimeoutMs,
        logger,
      });
      server = createServer(repository);
      transport = createTransport({
        sessionIdGenerator: createSessionId,
        onsessioninitialized: (sessionId) => {
          registeredSessionId = sessionId;
          sessionRegistry.register(sessionId, { transport, server, context: authContext });
          sessionRecord = sessionRegistry.get(sessionId);
        },
      });
      transport.onclose = () => {
        const sessionId = transport.sessionId ?? registeredSessionId;
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
      return jsonRpcSessionError(res);
    }
  });

  app.use((error, _req, res, _next) => {
    logger.error?.({ event: 'http_error', code: 'INTERNAL_ERROR' });
    if (!res.headersSent) publicHttpError(res, error);
  });

  const cleanupTimer = setInterval(() => {
    rateLimiter.cleanup();
    void sessionRegistry.cleanupExpired();
  }, Math.min(config.rateLimitWindowMs, 60_000));
  cleanupTimer.unref?.();

  return {
    app,
    async close() {
      clearInterval(cleanupTimer);
      await sessionRegistry.closeAll();
    },
  };
}
