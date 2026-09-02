import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import express from 'express';

import { loadEnvironmentFiles, startHttpServer, toSafeErrorLog } from '../src/index.mjs';

test('startup error diagnostics keep useful fields but redact credential-like values', () => {
  const details = toSafeErrorLog(Object.assign(new Error('connect failed password=example&token=example Bearer eyJheader.payload.signature'), {
    code: 'EADDRINUSE',
    syscall: 'listen',
    address: '127.0.0.1',
    port: 8787,
  }));

  assert.deepEqual(details, {
    errorName: 'Error',
    errorCode: 'EADDRINUSE',
    syscall: 'listen',
    address: '127.0.0.1',
    port: 8787,
    errorMessage: 'connect failed password=<redacted>&token=<redacted> Bearer <redacted>',
  });
});

test('listen failures are logged with the effective host and port', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const blockedPort = blocker.address().port;
  const events = [];

  await assert.rejects(
    startHttpServer({
      app: express(),
      config: { host: '127.0.0.1', port: blockedPort },
      logger: { error: (event) => events.push(event) },
    }),
    (error) => error?.code === 'EADDRINUSE',
  );

  await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  assert.equal(events[0].event, 'mcp_server_listen_failed');
  assert.equal(events[0].host, '127.0.0.1');
  assert.equal(events[0].port, blockedPort);
  assert.equal(events[0].errorCode, 'EADDRINUSE');
});

test('loads only the MCP-local env file and never the project root env file', () => {
  const serverRoot = path.resolve('isolated-mcp-server');
  const calls = [];

  loadEnvironmentFiles({
    serverRoot,
    loader: (options) => calls.push(options),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, path.join(serverRoot, '.env'));
  assert.equal(calls[0].override, false);
  assert.equal(calls[0].quiet, true);
  assert.notEqual(calls[0].path, path.join(path.dirname(serverRoot), '.env'));
});

test('starts on the configured interface and shuts down cleanly', async () => {
  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  const events = [];
  const runtime = await startHttpServer({
    app,
    config: { host: '127.0.0.1', port: 0 },
    logger: { info: (event) => events.push(event) },
  });

  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/health`);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(events[0].event, 'mcp_server_started');

  await runtime.close();
  assert.equal(events.at(-1).event, 'mcp_server_stopped');
});
