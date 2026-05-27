const TASK_REVIEW_FIELD_NAMES = ['task_review', 'task_review_score'];

export const stripTaskReviewFieldsFromSelect = (selectFields: string): string =>
  selectFields
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0 && !TASK_REVIEW_FIELD_NAMES.includes(field))
    .join(',');

export const omitTaskReviewColumns = <T extends Record<string, any>>(payload: T): Omit<T, 'task_review' | 'task_review_score'> => {
  const { task_review, task_review_score, ...rest } = payload;
  return rest;
};

export const isMissingTaskReviewColumnError = (error: any): boolean => {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('column tasks.task_review does not exist')
    || message.includes('column tasks.task_review_score does not exist')
  );
};
