import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedItem<Id extends string> {
  id: Id;
  label: string;
  /** Se escribe como "Etiqueta · N"; con 0 o sin valor se omite. */
  count?: number;
}

interface SegmentedProps<Id extends string> {
  items: readonly SegmentedItem<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  label: string;
  /** Id del panel que controla; cada pestaña es `${idBase}-tab-${id}`. */
  idBase: string;
}

/** Control segmentado como pestañas (tablist): flechas, Inicio y Fin cambian de vista. */
export function Segmented<Id extends string>({ items, value, onChange, label, idBase }: SegmentedProps<Id>) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = items.findIndex((item) => item.id === value);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    const target = items[next];
    if (!target) return;
    onChange(target.id);
    document.getElementById(`${idBase}-tab-${target.id}`)?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className="flex rounded-xl border border-slate-700 bg-slate-800 p-0.5">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${idBase}-tab-${item.id}`}
            aria-selected={active}
            aria-controls={`${idBase}-panel`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={onKeyDown}
            className={cn(
              'min-h-11 flex-1 rounded-[10px] px-3 text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
              active ? 'bg-primary-600 text-slate-950' : 'text-slate-400 hover:text-slate-100',
            )}
          >
            {item.label}
            {item.count ? ` · ${item.count}` : ''}
          </button>
        );
      })}
    </div>
  );
}
