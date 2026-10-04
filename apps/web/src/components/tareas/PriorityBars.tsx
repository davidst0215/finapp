import { cn } from '@/lib/utils';
import type { Priority } from './types';

const LABELS = ['Sin prioridad', 'Prioridad baja', 'Prioridad media', 'Prioridad alta'] as const;
const HEIGHTS = ['h-1.5', 'h-2.5', 'h-3.5'] as const; // 6 · 10 · 14 px, como la maqueta

interface PriorityBarsProps {
  priority: Priority;
  /** `inline` hereda el color del texto (para dentro de botones rellenos); `row` usa los grises de la fila. */
  variant?: 'row' | 'inline';
  className?: string;
}

/** Tres barritas: las activas en texto 1, las demás apagadas. Con prioridad 0 todas apagadas. */
export function PriorityBars({ priority, variant = 'row', className }: PriorityBarsProps) {
  const label = LABELS[priority];
  return (
    <span
      role={priority > 0 ? 'img' : undefined}
      aria-label={priority > 0 ? label : undefined}
      aria-hidden={priority === 0 ? true : undefined}
      className={cn('flex h-3.5 shrink-0 items-end gap-0.5', className)}
    >
      {HEIGHTS.map((height, i) => (
        <i
          key={height}
          className={cn(
            'w-[3px] rounded-sm',
            height,
            variant === 'inline'
              ? cn('bg-current', i >= priority && 'opacity-30')
              : i < priority
                ? 'bg-slate-100'
                : 'bg-slate-600',
          )}
        />
      ))}
    </span>
  );
}
