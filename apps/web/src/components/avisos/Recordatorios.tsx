import { Clock, X } from 'lucide-react';
import { formatCuando } from './logic';
import type { ProgramadosStatus, Recordatorio } from './useProgramados';

type Props = {
  items: Recordatorio[];
  status: ProgramadosStatus;
  error: string | null;
  onRetry: () => void;
  onCancel: (id: string) => void;
};

// Los recordatorios que David le pidió a Wabid ("recuérdame llamar a Marco a las 5"), del más próximo al más lejano. Cada uno se
// puede cancelar con un toque; para crearlos se le habla a Wabid (aquí no hay formulario a propósito).
export function Recordatorios({ items, status, error, onRetry, onCancel }: Props) {
  const now = new Date();

  return (
    <section aria-labelledby="avisos-recordatorios">
      <div className="mb-2 flex min-h-[44px] items-center">
        <h2 id="avisos-recordatorios" className="text-lg font-bold text-slate-100">
          Recordatorios próximos
        </h2>
      </div>

      {status === 'loading' && (
        <>
          <ul aria-hidden="true" className="card divide-y divide-slate-700 p-0">
            {[0, 1].map((i) => (
              <li key={i} className="space-y-2.5 px-4 py-4">
                <div className="h-4 w-2/3 rounded bg-slate-800 motion-safe:animate-pulse" />
                <div className="h-4 w-1/3 rounded bg-slate-800 motion-safe:animate-pulse" />
              </li>
            ))}
          </ul>
          <p role="status" className="sr-only">
            Cargando recordatorios…
          </p>
        </>
      )}

      {status === 'error' && (
        <div className="card flex flex-col items-start gap-3">
          <p className="text-base font-semibold text-slate-100">No pude cargar los recordatorios</p>
          <p className="text-base text-slate-300">{error}</p>
          <button type="button" className="btn-secondary min-h-[44px]" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}

      {status === 'ready' && items.length === 0 && (
        <div className="card">
          <p className="text-base font-semibold text-slate-100">Sin recordatorios pendientes</p>
          <p className="mt-1 text-base text-slate-300">Dile a Wabid «recuérdame llamar a Marco a las 5» y aparecerá aquí.</p>
        </div>
      )}

      {status === 'ready' && items.length > 0 && (
        <ul className="card divide-y divide-slate-700 overflow-hidden p-0">
          {items.map((r) => (
            <li key={r.id} className="flex items-stretch">
              <div className="min-w-0 flex-1 px-4 py-3.5">
                <p className="break-words text-base font-bold text-slate-100">{r.titulo}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-base tabular-nums text-slate-300">
                  <Clock size={16} strokeWidth={1.8} className="flex-shrink-0" aria-hidden="true" />
                  <time dateTime={r.cuando}>{formatCuando(r.cuando, now)}</time>
                </p>
              </div>
              <button
                type="button"
                aria-label={`Cancelar recordatorio: ${r.titulo}`}
                onClick={() => onCancel(r.id)}
                className="flex w-12 flex-shrink-0 items-center justify-center text-slate-400 active:bg-slate-800 active:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
              >
                <X size={20} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
