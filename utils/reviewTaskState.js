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

export const getTaskReviewSlot = (task) => {
  if (task?.alignedKrId) {
    const parts = task.alignedKrId.split('-kr-');
    const krIndex = Number(parts[1]);
    if (parts[0] && Number.isInteger(krIndex) && krIndex >= 0) {
      return {
        reviewKey: parts[0],
        krIndex,
      };
    }
  }

  return {
    reviewKey: `__task__:${task?.id || 'unknown'}`,
    krIndex: 0,
  };
};

export const readTaskReviewState = (okrReviews, task) => {
  const { reviewKey, krIndex } = getTaskReviewSlot(task);
  const currentReview = okrReviews?.[reviewKey] || createObjectiveReview();
  const krReview = currentReview.krReviews?.[krIndex] || createKrReview();

  return {
    reviewKey,
    krIndex,
    currentReview,
    krReview,
    evaluation: krReview.taskEvaluations?.[task.id] || '',
    score: krReview.taskScores?.[task.id] || 0,
  };
};

export const updateTaskReviewState = (okrReviews, task, updates) => {
  const { reviewKey, krIndex, currentReview } = readTaskReviewState(okrReviews, task);
  const newKrReviews = [...(currentReview.krReviews || [])];

  while (newKrReviews.length <= krIndex) {
    newKrReviews.push(createKrReview());
  }

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
