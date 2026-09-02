const createObjectiveReview = () => ({
  progress: 0,
  krReviews: [],
  lessonsLearned: '',
  methodology: '',
  nextSteps: '',
});

const createKrReview = () => ({
  comment: '',
  progress: 0,
  status: 'on-track',
});

const MAX_KR_INDEX = 100;
const SLOT_PATTERN = /^(.+)-kr-([0-9]+)$/;

export const getTaskReviewSlot = (task) => {
  const alignedKrId = task?.alignedKrId ?? task?.aligned_kr_id;
  if (alignedKrId === null || alignedKrId === undefined || alignedKrId === '') {
    return {
      state: 'unaligned',
      reviewKey: `__task__:${task?.id || 'unknown'}`,
      krIndex: 0,
    };
  }

  if (typeof alignedKrId !== 'string' || alignedKrId.length > 128) {
    return { state: 'invalid', reason: 'ALIGNED_KR_ID_INVALID', reviewKey: null, krIndex: null };
  }
  const match = SLOT_PATTERN.exec(alignedKrId);
  if (!match || match[1].trim().length === 0) {
    return { state: 'invalid', reason: 'ALIGNED_KR_ID_INVALID', reviewKey: null, krIndex: null };
  }
  if (match[2].length > 3) {
    return { state: 'invalid', reason: 'KR_INDEX_OUT_OF_RANGE', reviewKey: null, krIndex: null };
  }
  const krIndex = Number(match[2]);
  if (!Number.isSafeInteger(krIndex) || krIndex < 0 || krIndex > MAX_KR_INDEX) {
    return { state: 'invalid', reason: 'KR_INDEX_OUT_OF_RANGE', reviewKey: null, krIndex: null };
  }
  return { state: 'valid', reviewKey: match[1], krIndex };
};

export const readTaskReviewState = (okrReviews, task) => {
  const slot = getTaskReviewSlot(task);
  if (slot.state === 'invalid') {
    return {
      ...slot,
      currentReview: createObjectiveReview(),
      krReview: createKrReview(),
      evaluation: '',
      score: 0,
    };
  }
  if (okrReviews !== undefined && (!okrReviews || typeof okrReviews !== 'object' || Array.isArray(okrReviews))) {
    return {
      ...slot,
      state: 'invalid',
      reason: 'REVIEW_ROOT_NOT_OBJECT',
      currentReview: createObjectiveReview(),
      krReview: createKrReview(),
      evaluation: '',
      score: 0,
    };
  }
  const rawReview = okrReviews?.[slot.reviewKey];
  if (rawReview !== undefined && (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview))) {
    return {
      ...slot,
      state: 'invalid',
      reason: 'REVIEW_ENTRY_NOT_OBJECT',
      currentReview: createObjectiveReview(),
      krReview: createKrReview(),
      evaluation: '',
      score: 0,
    };
  }
  const currentReview = rawReview || createObjectiveReview();
  if (currentReview.krReviews !== undefined && !Array.isArray(currentReview.krReviews)) {
    return {
      ...slot,
      state: 'invalid',
      reason: 'KR_REVIEWS_NOT_ARRAY',
      currentReview: createObjectiveReview(),
      krReview: createKrReview(),
      evaluation: '',
      score: 0,
    };
  }
  const krReview = currentReview.krReviews?.[slot.krIndex] || createKrReview();
  if (currentReview.krReviews?.[slot.krIndex] !== undefined
    && (!currentReview.krReviews[slot.krIndex]
      || typeof currentReview.krReviews[slot.krIndex] !== 'object'
      || Array.isArray(currentReview.krReviews[slot.krIndex]))) {
    return {
      ...slot,
      state: 'invalid',
      reason: 'KR_REVIEW_NOT_OBJECT',
      currentReview: createObjectiveReview(),
      krReview: createKrReview(),
      evaluation: '',
      score: 0,
    };
  }
  for (const [field, reason] of [['taskEvaluations', 'TASK_EVALUATIONS_NOT_OBJECT'], ['taskScores', 'TASK_SCORES_NOT_OBJECT']]) {
    if (krReview[field] !== undefined
      && (!krReview[field] || typeof krReview[field] !== 'object' || Array.isArray(krReview[field]))) {
      return {
        ...slot,
        state: 'invalid',
        reason,
        currentReview: createObjectiveReview(),
        krReview: createKrReview(),
        evaluation: '',
        score: 0,
      };
    }
  }

  return {
    ...slot,
    currentReview,
    krReview,
    evaluation: krReview.taskEvaluations?.[task.id] || '',
    score: krReview.taskScores?.[task.id] || 0,
  };
};

export const updateTaskReviewState = (okrReviews, task, updates) => {
  const state = readTaskReviewState(okrReviews, task);
  if (state.state === 'invalid') {
    throw new Error(`复盘数据格式错误（${state.reason}），请先修复该任务的历史数据。`);
  }
  const { reviewKey, krIndex, currentReview } = state;
  const targetLength = Math.max(currentReview.krReviews?.length || 0, krIndex + 1);
  const newKrReviews = Array.from({ length: targetLength }, (_, index) => ({
    ...createKrReview(),
    ...(currentReview.krReviews?.[index] || {}),
  }));

  const currentKrReview = {
    ...createKrReview(),
    ...newKrReviews[krIndex],
  };

  let nextKrReview = currentKrReview;

  if (updates.evaluation !== undefined) {
    nextKrReview = {
      ...nextKrReview,
      taskEvaluations: {
        ...(nextKrReview.taskEvaluations || {}),
        [task.id]: updates.evaluation,
      },
    };
  }

  if (updates.score !== undefined) {
    nextKrReview = {
      ...nextKrReview,
      taskScores: {
        ...(nextKrReview.taskScores || {}),
        [task.id]: updates.score,
      },
    };
  }

  newKrReviews[krIndex] = nextKrReview;

  return {
    ...okrReviews,
    [reviewKey]: {
      ...createObjectiveReview(),
      ...currentReview,
      krReviews: newKrReviews,
    },
  };
};
