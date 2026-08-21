import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpApp } from '../src/app.mjs';
import { FixedWindowRateLimiter } from '../src/rate-limiter.mjs';
import { SessionRegistry } from '../src/session-registry.mjs';

const basic = `Basic ${Buffer.from('zhangsan:secret', 'utf8').toString('base64')}`;

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('official MCP client initializes, lists five read tools, calls one and terminates the session', async (t) => {
  const authProvider = {
    calls: 0,
    async authenticate() {
      this.calls += 1;
      return {
        userId: 'user-1', role: 'Employee', departmentId: 'dept-1',
        accessToken: 'access-1', refreshToken: 'refresh-1', tokenExpiresAt: Date.now() + 60_000,
      };
    },
    async refresh(context) { return context; },
    createUserClient() { throw new Error('integration test must not call Supabase'); },
  };
  const registry = new SessionRegistry({
    ttlMs: 60_000, refreshWindowMs: 1000, authProvider, now: Date.now,
  });
  const repository = {
    getOrganizationInfo: async () => ({ strategy: null, departments: [], businesses: [] }),
    getDepartmentWeeklyPad: async (args) => ({ ...args, tasks: [] }),
    searchPadTasks: async (args) => ({ ...args, tasks: [], total: 0, hasMore: false }),
    getPersonalWorkbench: async ({ limit }) => ({ userId: 'user-1', limit, tasks: [] }),
    getProcessSipoc: async ({ limit }) => ({ limit, processes: [] }),
  };
  const application = createMcpHttpApp({
    config: {
      host: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'], requireHttps: false,
      requestTimeoutMs: 1000, rateLimitWindowMs: 60_000, rateLimitMax: 30,
    },
    authProvider,
    sessionRegistry: registry,
    rateLimiter: new FixedWindowRateLimiter({ windowMs: 60_000, max: 30 }),
    createRepository: () => repository,
    logger: { info() {}, error() {} },
  });
  const http = await listen(application.app);
  const transport = new StreamableHTTPClientTransport(new URL(http.url), {
    requestInit: { headers: { Authorization: basic } },
  });
  const client = new Client({ name: 'phase-one-test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await http.close();
    await application.close();
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'get_organization_info',
    'get_department_weekly_pad',
    'search_pad_tasks',
    'get_personal_workbench',
    'get_process_sipoc',
  ]);
  assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);

  const result = await client.callTool({ name: 'get_personal_workbench', arguments: { limit: 5 } });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { userId: 'user-1', limit: 5, tasks: [] });
  assert.equal(authProvider.calls, 1);
  assert.equal(registry.size, 1);

  await transport.terminateSession();
  await client.close();
  assert.equal(registry.size, 0);
});
