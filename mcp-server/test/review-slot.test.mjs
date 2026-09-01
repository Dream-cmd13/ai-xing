import test from 'node:test';
import assert from 'node:assert/strict';

import { parseReviewSlot } from '../src/review-slot.mjs';

test('accepts an unaligned task as its synthetic slot', () => {
  assert.deepEqual(parseReviewSlot(null, 'task-1'), {
    ok: true, reviewKey: '__task__:task-1', krIndex: 0, aligned: false,
  });
});

test('accepts only a bounded non-negative decimal KR index', () => {
  assert.deepEqual(parseReviewSlot('okr-1-kr-2', 'task-1'), {
    ok: true, reviewKey: 'okr-1', krIndex: 2, aligned: true,
  });
  for (const value of ['okr-1-kr--1', 'okr-1-kr-1.5', 'okr-1-kr-1e2', 'okr-1-kr-😀', 'okr-1-kr-101']) {
    assert.equal(parseReviewSlot(value, 'task-1').ok, false, value);
  }
  assert.deepEqual(parseReviewSlot('okr-1-kr-100', 'task-1'), {
    ok: true, reviewKey: 'okr-1', krIndex: 100, aligned: true,
  });
});

test('rejects an index that is unsafe before numeric conversion', () => {
  const result = parseReviewSlot(`okr-1-kr-${'9'.repeat(40)}`, 'task-1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'KR_INDEX_OUT_OF_RANGE');
});
