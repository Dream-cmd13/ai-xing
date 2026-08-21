import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { config as loadDotEnv } from 'dotenv';

import { createMcpHttpApp } from './app.mjs';
import { createSupabaseAuthProvider } from './auth-provider.mjs';
import { loadConfig } from './config.mjs';
import { FixedWindowRateLimiter } from './rate-limiter.mjs';
import { SessionRegistry } from './session-registry.mjs';

function writeLog(stream, event) {
  stream.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

export const safeLogger = Object.freeze({
  info: (event) => writeLog(process.stdout, event),
  error: (event) => writeLog(process.stderr, event),
});

export function startHttpServer({ app, config, logger = safeLogger }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host);
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      const address = server.address();
      logger.info?.({
        event: 'mcp_server_started',
        host: typeof address === 'object' && address ? address.address : config.host,
        port: typeof address === 'object' && address ? address.port : config.port,
      });
      let closed = false;
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
  const sessionRegistry = new SessionRegistry({
    ttlMs: config.sessionTtlMs,
    refreshWindowMs: config.refreshWindowMs,
    authProvider,
  });
  const rateLimiter = new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
  });
  const application = createMcpHttpApp({
    config,
    authProvider,
    sessionRegistry,
    rateLimiter,
    logger: safeLogger,
  });
  const runtime = await startHttpServer({ app: application.app, config, logger: safeLogger });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    safeLogger.info({ event: 'mcp_server_shutdown', signal });
    await application.close();
    await runtime.close();
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  return { ...runtime, application, stop };
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryUrl === import.meta.url) {
  main().catch(() => {
    safeLogger.error({ event: 'mcp_server_start_failed', code: 'INTERNAL_ERROR' });
    process.exitCode = 1;
  });
}
