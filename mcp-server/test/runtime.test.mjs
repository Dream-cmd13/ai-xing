import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';

import { loadEnvironmentFiles, startHttpServer } from '../src/index.mjs';

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
