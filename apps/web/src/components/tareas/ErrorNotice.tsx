import { AlertCircle } from 'lucide-react';

interface ErrorNoticeProps {
  /** Mensaje del servidor, tal cual. */
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}

/** Aviso de error discreto: el rojo marca el problema y el botón la salida. Nunca deja la pantalla en blanco. */
export function ErrorNotice({ message, onRetry, retrying = false }: ErrorNoticeProps) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-expense/50 bg-slate-900 py-2 pl-3 pr-2">
      <AlertCircle aria-hidden="true" size={18} className="mt-3 shrink-0 text-expense" />
      <p className="min-w-0 flex-1 break-words py-3 text-[14px] leading-snug text-expense">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="min-h-11 shrink-0 rounded-lg border border-slate-600 px-3 text-[14px] font-semibold text-slate-100 transition-colors hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50"
        >
          {retrying ? 'Reintentando…' : 'Reintentar'}
        </button>
      )}
    </div>
  );
}
