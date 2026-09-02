import test from 'node:test';
import assert from 'node:assert/strict';

import { createReadinessGate } from '../src/readiness-gate.mjs';

test('deduplicates concurrent readiness checks and caches the result for the TTL', async () => {
  let calls = 0;
  let resolveCheck;
  let currentTime = 100;
  const gate = createReadinessGate({
    now: () => currentTime,
    ttlMs: 50,
    timeoutMs: 1000,
    check: async () => {
      calls += 1;
      await new Promise((resolve) => { resolveCheck = resolve; });
      return { status: 'ready', releaseId: 'test' };
    },
  });

  const pending = Promise.all([gate.status(), gate.status(), gate.requireReady()]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveCheck();
  const results = await pending;
  assert.equal(results.every((value) => value.status === 'ready'), true);
  await gate.status();
  assert.equal(calls, 1);
  currentTime = 151;
  const next = gate.status();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  resolveCheck();
  await next;
});

test('fails closed on degraded and timeout responses and recovers after invalidation', async () => {
  let mode = 'degraded';
  const gate = createReadinessGate({
    ttlMs: 60_000,
    timeoutMs: 20,
    check: async () => {
      if (mode === 'timeout') return new Promise(() => {});
      return { status: mode, reason: 'RELEASE_CONTRACT_MISMATCH' };
    },
  });

  await assert.rejects(gate.requireReady(), (error) => error?.code === 'SERVICE_NOT_READY' && error?.status === 503);
  mode = 'timeout';
  gate.invalidate();
  assert.equal((await gate.status()).reason, 'READINESS_CHECK_FAILED');
  mode = 'ready';
  gate.invalidate();
  assert.equal((await gate.requireReady()).status, 'ready');
});
