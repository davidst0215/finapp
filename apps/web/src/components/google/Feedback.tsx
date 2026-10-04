import { AlertTriangle } from 'lucide-react';

/** Esqueleto de filas mientras carga (en lugar de un spinner en medio del contenido). */
export function RowsSkeleton({ rows = 3, label = 'Cargando' }: { rows?: number; label?: string }) {
  return (
    <div className="card space-y-4" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-5 w-12 flex-none rounded bg-slate-800 motion-safe:animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-3/4 rounded bg-slate-800 motion-safe:animate-pulse" />
            <div className="h-3.5 w-1/2 rounded bg-slate-800 motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Error de carga con salida: nombra el problema y deja reintentar. El rojo es para errores y alarmas. */
export function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="card flex items-start gap-3 border-expense/50">
      <AlertTriangle size={20} strokeWidth={1.8} className="mt-0.5 flex-none text-expense" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-3">
        <p className="text-base text-slate-100">{message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="btn-secondary min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-100">
            Reintentar
          </button>
        )}
      </div>
    </div>
  );
}
