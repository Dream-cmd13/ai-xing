import { ObjectiveReview } from '../types';

export type ReviewDraftSnapshot = {
  content: string;
  score: number;
  okrReviews: Record<string, ObjectiveReview>;
};

const normalizeKrReview = (review: any = {}) => ({
  comment: review.comment || '',
  progress: review.progress || 0,
  status: review.status || 'on-track',
  taskEvaluations: Object.fromEntries(
    Object.entries(review.taskEvaluations || {})
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, typeof value === 'string' ? value : ''])
  ),
  taskScores: Object.fromEntries(
    Object.entries(review.taskScores || {})
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, Number(value || 0)])
  )
});

const normalizeObjectiveReview = (review: (ObjectiveReview & {
  evaluation?: string;
  score?: number;
}) | undefined) => ({
  progress: review?.progress || 0,
  lessonsLearned: review?.lessonsLearned || '',
  methodology: review?.methodology || '',
  nextSteps: review?.nextSteps || '',
  evaluation: review?.evaluation || '',
  score: review?.score || 0,
  krReviews: (review?.krReviews || []).map(normalizeKrReview)
});

export const createReviewDraftSnapshot = (
  snapshot?: Partial<ReviewDraftSnapshot>
): ReviewDraftSnapshot => {
  const okrReviews = snapshot?.okrReviews || {};
  const normalizedOkrReviews = Object.fromEntries(
    Object.keys(okrReviews)
      .sort()
      .map((key) => [key, normalizeObjectiveReview(okrReviews[key])])
  );

  return {
    content: snapshot?.content || '',
    score: snapshot?.score || 0,
    okrReviews: normalizedOkrReviews
  };
};

export const hasReviewDraftChanges = (
  baseline: ReviewDraftSnapshot,
  current: ReviewDraftSnapshot
): boolean => {
  return JSON.stringify(createReviewDraftSnapshot(baseline)) !== JSON.stringify(createReviewDraftSnapshot(current));
};
