import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NoticeState } from './useNotice';

interface NoticeProps {
  notice: NoticeState | null;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}

/**
 * Aviso inferior sobre la TabBar ("Completada · Deshacer", "Movida a…").
 * El contenedor vive siempre en el DOM: así los lectores de pantalla anuncian el texto cuando cambia.
 */
export function Notice({ notice, onDismiss, onPause, onResume }: NoticeProps) {
  const isError = notice?.tone === 'error';
  const action = notice?.action;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4"
    >
      {notice && (
        <div
          key={notice.id}
          role={isError ? 'alert' : undefined}
          onMouseEnter={onPause}
          onMouseLeave={onResume}
          onFocus={onPause}
          onBlur={onResume}
          className={cn(
            'pointer-events-auto flex w-full max-w-sm items-center gap-1 rounded-xl border bg-slate-800 pl-4 pr-1 motion-safe:animate-slide-up',
            isError ? 'border-expense/50' : 'border-slate-600',
          )}
        >
          <p
            className={cn(
              'min-w-0 flex-1 break-words py-3 text-[14.5px] font-semibold leading-snug',
              isError ? 'text-expense' : 'text-slate-100',
            )}
          >
            {notice.message}
          </p>
          {action && (
            <button
              type="button"
              onClick={() => {
                onDismiss();
                action.run();
              }}
              className="min-h-11 shrink-0 rounded-lg px-3 text-[14.5px] font-bold text-slate-100 underline decoration-slate-500 underline-offset-4 transition-colors [@media(hover:hover)]:hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            >
              {action.label}
            </button>
          )}
          {isError && (
            <button
              type="button"
              aria-label="Cerrar aviso"
              onClick={onDismiss}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            >
              <X aria-hidden="true" size={18} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
