import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry, createSessionId } from '../src/session-registry.mjs';

function closable() {
  return {
    calls: 0,
    async close() {
      this.calls += 1;
    },
  };
}

const context = (overrides = {}) => ({
  userId: 'user-1',
  role: 'Employee',
  departmentId: 'dept-1',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  tokenExpiresAt: 10_000,
  ...overrides,
});

test('creates high-entropy session identifiers', () => {
  const first = createSessionId();
  const second = createSessionId();

  assert.match(first, /^[0-9a-f-]{36}$/i);
  assert.notEqual(first, second);
});

test('registers and reads a session without storing credentials', async () => {
  const registry = new SessionRegistry({ ttlMs: 1000, refreshWindowMs: 50, now: () => 100 });
  const record = { transport: closable(), server: closable(), context: context() };
  registry.register('session-1', record);

  const stored = await registry.ensureReady('session-1');
  assert.equal(stored.context.userId, 'user-1');
  assert.equal(JSON.stringify(stored).includes('password'), false);
  assert.equal(registry.size, 1);
});

test('expires a fixed-TTL session and closes its resources', async () => {
  let now = 100;
  const transport = closable();
  const server = closable();
  const registry = new SessionRegistry({ ttlMs: 1000, refreshWindowMs: 50, now: () => now });
  registry.register('session-1', { transport, server, context: context() });

  now = 1101;
  await assert.rejects(registry.ensureReady('session-1'), (error) => error.code === 'SESSION_EXPIRED');
  assert.equal(registry.size, 0);
  assert.equal(transport.calls, 1);
  assert.equal(server.calls, 1);
});

test('refreshes the user token inside the refresh window', async () => {
  const authProvider = {
    calls: 0,
    async refresh(previous) {
      this.calls += 1;
      return { ...previous, accessToken: 'access-2', tokenExpiresAt: 5000 };
    },
  };
  const registry = new SessionRegistry({
    ttlMs: 1000,
    refreshWindowMs: 100,
    authProvider,
    now: () => 950,
  });
  registry.register('session-1', {
    transport: closable(), server: closable(), context: context({ tokenExpiresAt: 1000 }),
  });

  const record = await registry.ensureReady('session-1');
  assert.equal(authProvider.calls, 1);
  assert.equal(record.context.accessToken, 'access-2');
});

test('removes and closes a session when token refresh fails', async () => {
  const transport = closable();
  const server = closable();
  const authProvider = { async refresh() { throw Object.assign(new Error('expired'), { code: 'SESSION_EXPIRED' }); } };
  const registry = new SessionRegistry({
    ttlMs: 1000, refreshWindowMs: 100, authProvider, now: () => 950,
  });
  registry.register('session-1', {
    transport, server, context: context({ tokenExpiresAt: 1000 }),
  });

  await assert.rejects(registry.ensureReady('session-1'), (error) => error.code === 'SESSION_EXPIRED');
  assert.equal(registry.size, 0);
  assert.equal(transport.calls, 1);
  assert.equal(server.calls, 1);
});

test('supports explicit deletion and transport-driven cleanup without a close loop', async () => {
  const transport = closable();
  const server = closable();
  const registry = new SessionRegistry({ ttlMs: 1000, refreshWindowMs: 50, now: () => 100 });
  registry.register('session-1', { transport, server, context: context() });

  assert.equal(await registry.remove('session-1'), true);
  assert.equal(transport.calls, 1);
  assert.equal(server.calls, 1);

  registry.register('session-2', { transport, server, context: context() });
  assert.equal(registry.handleTransportClosed('session-2'), true);
  assert.equal(transport.calls, 1);
  assert.equal(server.calls, 1);
});

test('closes every active session during shutdown', async () => {
  const first = { transport: closable(), server: closable(), context: context() };
  const second = { transport: closable(), server: closable(), context: context() };
  const registry = new SessionRegistry({ ttlMs: 1000, refreshWindowMs: 50, now: () => 100 });
  registry.register('session-1', first);
  registry.register('session-2', second);

  await registry.closeAll();

  assert.equal(registry.size, 0);
  assert.equal(first.transport.calls, 1);
  assert.equal(second.server.calls, 1);
});
