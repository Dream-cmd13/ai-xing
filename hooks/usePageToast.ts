import { useCallback, useEffect, useRef, useState } from 'react';

export type PageToastType = 'success' | 'info' | 'error' | 'warning';

export interface PageToastState {
  message: string;
  type: PageToastType;
}

const DEFAULT_DURATION = 3000;

export const usePageToast = (duration = DEFAULT_DURATION) => {
  const [toastState, setToastState] = useState<PageToastState | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearToast = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToastState(null);
  }, []);

  const showToast = useCallback((message: string, type: PageToastType = 'success') => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }

    setToastState({ message, type });
    timerRef.current = window.setTimeout(() => {
      setToastState(null);
      timerRef.current = null;
    }, duration);
  }, [duration]);

  useEffect(() => clearToast, [clearToast]);

  return {
    toastState,
    showToast,
    clearToast
  };
};
