import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { syncedLabel } from './format';

interface SyncLineProps {
  syncedAt: string | null;
  /** Reloj de la pantalla (useNow): hace que "hace 3 min" avance solo. */
  now: number;
  fetching: boolean;
  onRefresh: () => void;
}

/**
 * "Sincronizado hace N min" y el botón de refrescar. Mientras sincroniza el texto lo dice con palabras:
 * el giro del icono es un extra, no la señal (David trabaja con las animaciones del sistema apagadas).
 */
export function SyncLine({ syncedAt, now, fetching, onRefresh }: SyncLineProps) {
  return (
    <div className="flex items-center text-[13px] text-slate-400">
      <span>{fetching ? 'Sincronizando…' : syncedLabel(syncedAt, now)}</span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={fetching}
        aria-label="Sincronizar ahora"
        className="-my-3 grid h-11 w-11 place-items-center rounded-full transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-60"
      >
        <RefreshCw aria-hidden="true" size={16} className={cn(fetching && 'motion-safe:animate-spin')} />
      </button>
    </div>
  );
}
