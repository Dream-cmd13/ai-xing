import React from 'react';
import { AlertCircle, CheckCircle, Info, TriangleAlert } from 'lucide-react';
import { PageToastType } from '@/hooks/usePageToast';

interface PageToastProps {
  visible: boolean;
  message: string;
  type?: PageToastType;
  onClose?: () => void;
}

const styleMap: Record<PageToastType, { container: string; icon: React.ReactNode }> = {
  success: {
    container: 'border-emerald-100 bg-emerald-50 text-emerald-700',
    icon: <CheckCircle size={18} className="text-emerald-500" />
  },
  info: {
    container: 'border-sky-100 bg-sky-50 text-sky-700',
    icon: <Info size={18} className="text-sky-500" />
  },
  error: {
    container: 'border-red-100 bg-red-50 text-red-700',
    icon: <AlertCircle size={18} className="text-red-500" />
  },
  warning: {
    container: 'border-amber-100 bg-amber-50 text-amber-700',
    icon: <TriangleAlert size={18} className="text-amber-500" />
  }
};

const PageToast: React.FC<PageToastProps> = ({
  visible,
  message,
  type = 'success',
  onClose
}) => {
  if (!visible) return null;

  const currentStyle = styleMap[type];

  return (
    <div className="fixed left-1/2 top-20 z-[1100] w-full max-w-[calc(100vw-2rem)] -translate-x-1/2 animate-in fade-in slide-in-from-top-2 duration-200 px-4">
      <div className={`mx-auto min-w-[280px] max-w-[520px] rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-sm ${currentStyle.container}`}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">{currentStyle.icon}</div>
          <div className="flex-1 text-sm font-bold leading-6">{message}</div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-lg px-2 py-1 text-[10px] font-black uppercase text-slate-400 transition-colors hover:bg-white/70 hover:text-slate-600"
            >
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PageToast;
