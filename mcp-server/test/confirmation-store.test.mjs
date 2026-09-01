import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfirmationStore, computeArgsDigest } from '../src/confirmation-store.mjs';

function issuedStore(now = 1_000) {
  return new ConfirmationStore({ ttlMs: 600_000, now: () => now });
}

function issue(store, overrides = {}) {
  return store.issue({
    userId: 'user-1',
    sessionId: 'session-1',
    toolName: 'commit_create_pad_task',
    argsDigest: computeArgsDigest('commit_create_pad_task', {
      payload: { title: '测试任务', priority: 'medium' },
    }),
    metadata: { preview: { title: '测试任务' } },
    ...overrides,
  });
}

test('issues a base64url confirmation token in issued state', () => {
  const store = issuedStore();
  const result = issue(store);

  assert.match(result.token, /^[A-Za-z0-9_-]+$/);
  assert.equal(result.token.includes('='), false);
  assert.equal(result.expiresAt, 601_000);
  assert.equal(store.size, 1);
});

test('canonical argument digest is stable across object key order', () => {
  const first = computeArgsDigest('tool', { b: 2, a: { d: 4, c: 3 } });
  const second = computeArgsDigest('tool', { a: { c: 3, d: 4 }, b: 2 });
  const changed = computeArgsDigest('tool', { a: { c: 3, d: 5 }, b: 2 });

  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('begin validates all bindings and transitions issued to in_flight', () => {
  const store = issuedStore();
  const digest = computeArgsDigest('tool', { value: 1 });
  const { token } = issue(store, { toolName: 'tool', argsDigest: digest });

  const result = store.begin({
    userId: 'user-1',
    sessionId: 'session-1',
    toolName: 'tool',
    argsDigest: digest,
    token,
  });

  assert.deepEqual(result, { valid: true, metadata: { preview: { title: '测试任务' } } });
  assert.equal(store.size, 1);
});

test('rejects a second begin while the same token is in flight', () => {
  const store = issuedStore();
  const digest = computeArgsDigest('tool', { value: 1 });
  const { token } = issue(store, { toolName: 'tool', argsDigest: digest });
  const args = { userId: 'user-1', sessionId: 'session-1', toolName: 'tool', argsDigest: digest, token };

  assert.equal(store.begin(args).valid, true);
  assert.deepEqual(store.begin(args), { valid: false, reason: 'IN_FLIGHT' });
});

test('rejects mismatched user, session, tool, and digest without changing state', () => {
  const store = issuedStore();
  const digest = computeArgsDigest('tool', { value: 1 });
  const { token } = issue(store, { toolName: 'tool', argsDigest: digest });
  const base = { token, argsDigest: digest };

  assert.deepEqual(store.begin({ ...base, userId: 'user-2', sessionId: 'session-1', toolName: 'tool' }), { valid: false, reason: 'USER_MISMATCH' });
  assert.deepEqual(store.begin({ ...base, userId: 'user-1', sessionId: 'session-2', toolName: 'tool' }), { valid: false, reason: 'SESSION_MISMATCH' });
  assert.deepEqual(store.begin({ ...base, userId: 'user-1', sessionId: 'session-1', toolName: 'other' }), { valid: false, reason: 'TOOL_MISMATCH' });
  assert.deepEqual(store.begin({ ...base, userId: 'user-1', sessionId: 'session-1', toolName: 'tool', argsDigest: '0'.repeat(64) }), { valid: false, reason: 'ARGS_MISMATCH' });
  assert.equal(store.size, 1);
});

test('expired tokens are rejected and cleaned up', () => {
  let now = 1_000;
  const store = new ConfirmationStore({ ttlMs: 100, now: () => now });
  const { token } = issue(store);

  now = 1_101;
  assert.deepEqual(store.begin({
    userId: 'user-1',
    sessionId: 'session-1',
    toolName: 'commit_create_pad_task',
    argsDigest: computeArgsDigest('commit_create_pad_task', { payload: { title: '测试任务', priority: 'medium' } }),
    token,
  }), { valid: false, reason: 'EXPIRED' });
  assert.equal(store.cleanupExpired(), 0);
  assert.equal(store.size, 0);
});

test('rollback returns an in-flight token to issued for retry', () => {
  const store = issuedStore();
  const digest = computeArgsDigest('tool', { value: 1 });
  const { token } = issue(store, { toolName: 'tool', argsDigest: digest });
  const args = { userId: 'user-1', sessionId: 'session-1', toolName: 'tool', argsDigest: digest, token };

  assert.equal(store.begin(args).valid, true);
  assert.equal(store.rollback({ token }), true);
  assert.equal(store.begin(args).valid, true);
});

test('binds the first requestId and preserves that binding across retryable rollback', () => {
  const store = issuedStore();
  const digest = computeArgsDigest('tool', { value: 1 });
  const { token } = issue(store, { toolName: 'tool', argsDigest: digest });
  const args = { userId: 'user-1', sessionId: 'session-1', toolName: 'tool', argsDigest: digest, token };

  assert.deepEqual(store.begin({ ...args, requestId: 'request-original' }), { valid: true, metadata: { preview: { title: '测试任务' } } });
  assert.equal(store.rollback({ token }), true);
  assert.deepEqual(store.begin({ ...args, requestId: 'request-other' }), { valid: false, reason: 'REQUEST_ID_MISMATCH' });
  assert.deepEqual(store.begin({ ...args, requestId: 'request-original' }), { valid: true, metadata: { preview: { title: '测试任务' } } });
});

test('finalize deletes the token and marks future reuse as consumed', () => {
  const store = issuedStore();
  const digest = computeArgsDigest('tool', { value: 1 });
  const { token } = issue(store, { toolName: 'tool', argsDigest: digest });
  const args = { userId: 'user-1', sessionId: 'session-1', toolName: 'tool', argsDigest: digest, token };

  store.begin(args);
  assert.equal(store.finalize({ token }), true);
  assert.equal(store.size, 0);
  assert.deepEqual(store.begin(args), { valid: false, reason: 'CONSUMED' });
});

test('revokeSession removes every token for that session, including in-flight tokens', () => {
  const store = issuedStore();
  const firstDigest = computeArgsDigest('commit_create_pad_task', {
    payload: { title: '测试任务', priority: 'medium' },
  });
  const first = issue(store, { sessionId: 'session-1', argsDigest: firstDigest });
  const second = issue(store, { sessionId: 'session-1', toolName: 'submit_pad_task' });
  const secondDigest = computeArgsDigest('submit_pad_task', { taskId: 'task-1' });
  const third = issue(store, { sessionId: 'session-2', toolName: 'submit_pad_task', argsDigest: secondDigest });

  store.begin({
    userId: 'user-1', sessionId: 'session-1', toolName: 'submit_pad_task', argsDigest: secondDigest, token: second.token,
  });
  assert.equal(store.revokeSession('session-1'), 2);
  assert.equal(store.size, 1);
  assert.deepEqual(store.begin({
    userId: 'user-1', sessionId: 'session-1', toolName: 'commit_create_pad_task', argsDigest: firstDigest, token: first.token,
  }), { valid: false, reason: 'UNKNOWN' });
  assert.equal(third.token.length > 0, true);
});
