import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VaultTask } from './types';

interface StatusControlProps {
  task: VaultTask;
  busy: boolean;
  onToggle: () => void;
}

/**
 * Control de estado: círculo visible de 22 px dentro de un botón de 44 px.
 * Pendiente = círculo hueco · en curso = punto relleno · necesita ayuda = discontinuo ·
 * vencida = anillo rojo · completada = check relleno. Cada estado se distingue por forma, no solo por color.
 * Tocarlo completa la tarea; en una completada la reabre.
 */
export function StatusControl({ task, busy, onToggle }: StatusControlProps) {
  const done = task.status === 'completed';
  const alarm = task.overdue && !done;
  const ring = alarm ? 'border-expense' : 'border-slate-400';

  return (
    // aria-disabled en vez de disabled: un botón con foco que se deshabilita lo pierde, y con teclado
    // el foco volvería al inicio de la página en cada tarea completada.
    <button
      type="button"
      onClick={busy ? undefined : onToggle}
      aria-disabled={busy || undefined}
      aria-label={`${done ? 'Reabrir' : 'Completar'}: ${task.text}`}
      className={cn(
        '-ml-[11px] grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors [@media(hover:hover)]:hover:bg-slate-800 active:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        busy && 'opacity-60',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid h-[22px] w-[22px] place-items-center rounded-full',
          done
            ? 'bg-slate-500 text-slate-950'
            : task.status === 'need-help'
              ? cn('border-2 border-dashed', ring)
              : cn('border-[1.5px]', ring),
        )}
      >
        {done && <Check size={14} strokeWidth={3} />}
        {!done && task.status === 'in-progress' && (
          <span className={cn('h-2.5 w-2.5 rounded-full', alarm ? 'bg-expense' : 'bg-slate-100')} />
        )}
        {!done && task.status === 'failed' && <X size={12} strokeWidth={3} className="text-slate-400" />}
      </span>
    </button>
  );
}
