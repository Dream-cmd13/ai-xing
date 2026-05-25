import React, { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';

const UNSAVED_CHANGES_MESSAGE = '当前页面有未保存的修改，确定要离开吗？';

export const UnsavedChangesGuard: React.FC = () => {
  const isDirty = useAppStore(state => state.isDirty);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!useAppStore.getState().isDirty) return;
      event.preventDefault();
      event.returnValue = UNSAVED_CHANGES_MESSAGE;
    };

    const handleDocumentClick = (event: MouseEvent) => {
      if (!useAppStore.getState().isDirty) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;

      const nextUrl = new URL(anchor.href, window.location.href);
      const currentUrl = new URL(window.location.href);
      const isSamePage = nextUrl.pathname === currentUrl.pathname
        && nextUrl.search === currentUrl.search
        && nextUrl.hash === currentUrl.hash;

      if (nextUrl.origin !== currentUrl.origin || isSamePage) return;

      const shouldLeave = window.confirm(UNSAVED_CHANGES_MESSAGE);
      if (!shouldLeave) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleDocumentClick, true);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, []);

  useEffect(() => {
    if (!isDirty) return;

    const handlePopState = () => {
      if (!useAppStore.getState().isDirty) return;
      const shouldLeave = window.confirm(UNSAVED_CHANGES_MESSAGE);
      if (!shouldLeave) {
        window.history.go(1);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isDirty]);

  return null;
};
