const getErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object' || !('message' in error)) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
};

export const isSupabaseNetworkError = (error: unknown): boolean => {
  const message = getErrorMessage(error).trim().toLowerCase();
  return [
    'failed to fetch',
    'fetch failed',
    'network error',
    'networkerror',
    'network request failed',
    'load failed',
  ].some((fragment) => message.includes(fragment));
};
