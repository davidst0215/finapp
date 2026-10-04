import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { chipLabel } from '../google/lima';
import { focusRing } from '../google/ui';

type Props = { days: string[]; selected: string; today: string; onSelect: (key: string) => void };

/** Selector de día en una fila que se desliza. El día de hoy lleva un punto; el elegido va relleno. */
export function DayChips({ days, selected, today, onSelect }: Props) {
  const row = useRef<HTMLDivElement>(null);

  // Mantiene visible el día elegido sin mover la página.
  useEffect(() => {
    row.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [selected]);

  return (
    <div ref={row} role="group" aria-label="Día" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
      {days.map((key) => {
        const on = key === selected;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            aria-current={key === today ? 'date' : undefined}
            onClick={() => onSelect(key)}
            className={cn(
              'inline-flex h-11 flex-none items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm font-semibold transition-colors',
              focusRing,
              on ? 'border-slate-100 bg-slate-100 text-slate-950' : 'border-slate-700 bg-slate-800 text-slate-200 active:bg-slate-700',
            )}
          >
            {chipLabel(key)}
            {key === today && (
              <>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                <span className="sr-only">(hoy)</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
