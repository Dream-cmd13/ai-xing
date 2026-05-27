import { PADEntry, ObjectiveReview } from '../types';
import { readTaskReviewState } from './reviewTaskState.js';

export const syncTaskReviewsToTasks = (
  tasks: PADEntry[],
  okrReviews: Record<string, ObjectiveReview>
): PADEntry[] => {
  return tasks.map((task) => {
    const { evaluation, score } = readTaskReviewState(okrReviews, task);

    return {
      ...task,
      taskReview: evaluation || '',
      taskReviewScore: score || 0
    };
  });
};
