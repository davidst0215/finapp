import { useToastStore, type ToastType } from '@/stores/toastStore';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const iconMap: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const colorMap: Record<ToastType, string> = {
  success: 'bg-income/10 border-income/30 text-income',
  error: 'bg-expense/10 border-expense/30 text-expense',
  warning: 'bg-slate-800 border-slate-500 text-slate-100',
  info: 'bg-primary-400/10 border-primary-400/30 text-primary-400',
};

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-sm px-4">
      {toasts.map(toast => {
        const Icon = iconMap[toast.type];
        return (
          <div
            key={toast.id}
            className={cn(
              'flex items-center gap-2.5 px-4 py-3 rounded-xl border backdrop-blur-sm animate-slide-up',
              colorMap[toast.type]
            )}
          >
            <Icon size={18} className="flex-shrink-0" />
            <p className="text-sm flex-1">{toast.message}</p>
            <button onClick={() => removeToast(toast.id)} className="opacity-50 hover:opacity-100 flex-shrink-0">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
