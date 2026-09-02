import test from 'node:test';
import assert from 'node:assert/strict';

import { FixedWindowRateLimiter } from '../src/rate-limiter.mjs';

test('rejects requests beyond the configured fixed-window limit', () => {
  const limiter = new FixedWindowRateLimiter({ windowMs: 1000, max: 2, now: () => 100 });

  assert.deepEqual(limiter.consume('ip:alice'), { allowed: true, remaining: 1, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume('ip:alice'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume('ip:alice'), { allowed: false, remaining: 0, retryAfterMs: 1000 });
});

test('uses independent counters for different keys', () => {
  const limiter = new FixedWindowRateLimiter({ windowMs: 1000, max: 1, now: () => 100 });

  assert.equal(limiter.consume('ip:a').allowed, true);
  assert.equal(limiter.consume('ip:b').allowed, true);
});

test('starts a new window after the previous window expires', () => {
  let now = 100;
  const limiter = new FixedWindowRateLimiter({ windowMs: 1000, max: 1, now: () => now });
  limiter.consume('ip:a');
  assert.equal(limiter.consume('ip:a').allowed, false);

  now = 1101;
  assert.deepEqual(limiter.consume('ip:a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
});

test('removes expired buckets during cleanup', () => {
  let now = 100;
  const limiter = new FixedWindowRateLimiter({ windowMs: 1000, max: 1, now: () => now });
  limiter.consume('ip:a');
  assert.equal(limiter.size, 1);

  now = 1101;
  limiter.cleanup();
  assert.equal(limiter.size, 0);
});
