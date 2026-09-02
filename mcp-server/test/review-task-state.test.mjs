import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getTaskReviewSlot,
  readTaskReviewState,
  updateTaskReviewState,
} from '../../utils/reviewTaskState.js';

test('classifies malformed task slots without falling back to a synthetic slot', () => {
  for (const alignedKrId of ['okr-1-kr--1', 'okr-1-kr-1.5', 'okr-1-kr-text', 'okr-1-kr-101']) {
    const slot = getTaskReviewSlot({ id: 'task-1', alignedKrId });
    assert.equal(slot.state, 'invalid', alignedKrId);
    assert.equal(slot.reviewKey, null);
  }
});

test('rejects malformed review maps before a browser-side update', () => {
  const task = { id: 'task-1', alignedKrId: 'okr-1-kr-0' };
  const state = readTaskReviewState({
    'okr-1': { krReviews: [{ taskEvaluations: [] }] },
  }, task);

  assert.equal(state.state, 'invalid');
  assert.equal(state.reason, 'TASK_EVALUATIONS_NOT_OBJECT');
  assert.throws(
    () => updateTaskReviewState({ 'okr-1': { krReviews: 'bad' } }, task, { evaluation: '结果' }),
    /复盘数据格式错误/,
  );
});

test('initializes only the finite range needed by a validated KR slot', () => {
  const updated = updateTaskReviewState({}, {
    id: 'task-1', alignedKrId: 'okr-1-kr-2',
  }, { evaluation: '完成', score: 90 });

  assert.equal(updated['okr-1'].krReviews.length, 3);
  assert.equal(updated['okr-1'].krReviews[2].taskEvaluations['task-1'], '完成');
  assert.equal(updated['okr-1'].krReviews[2].taskScores['task-1'], 90);
});

test('supports the inclusive maximum KR index without exceeding 101 slots', () => {
  const updated = updateTaskReviewState({}, {
    id: 'task-100', alignedKrId: 'okr-1-kr-100',
  }, { evaluation: '完成' });

  assert.equal(updated['okr-1'].krReviews.length, 101);
  assert.equal(updated['okr-1'].krReviews[100].taskEvaluations['task-100'], '完成');
});
