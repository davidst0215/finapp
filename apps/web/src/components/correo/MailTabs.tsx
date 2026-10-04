import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { focusRing } from '../google/ui';
import type { TabId } from './mailModel';

const TABS: { id: TabId; label: string }[] = [
  { id: 'importantes', label: 'Importantes' },
  { id: 'borradores', label: 'Borradores' },
  { id: 'resto', label: 'Resto' },
];

type Props = {
  value: TabId;
  onChange: (tab: TabId) => void;
  /** Contador de cada pestaña (null mientras carga) */
  counts: Record<TabId, string | null>;
};

/** Segmentos Importantes / Borradores / Resto. El contador va debajo del nombre para que quepa en pantallas angostas. */
export function MailTabs({ value, onChange, counts }: Props) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const move = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -index : e.key === 'End' ? TABS.length - 1 - index : 0;
    if (!move) return;
    e.preventDefault();
    const next = TABS[(index + move + TABS.length) % TABS.length];
    if (next) {
      onChange(next.id);
      refs.current[next.id]?.focus();
    }
  };

  return (
    <div role="tablist" aria-label="Bandeja" className="flex gap-1 rounded-xl border border-slate-700 bg-slate-800 p-1">
      {TABS.map((tab, i) => {
        const on = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[tab.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={on}
            aria-controls={`panel-${tab.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'flex min-h-[52px] flex-1 flex-col items-center justify-center rounded-lg px-1 transition-colors',
              focusRing,
              on ? 'bg-slate-100 text-slate-950' : 'text-slate-400 active:bg-slate-700',
            )}
          >
            <span className="text-sm font-semibold leading-tight">{tab.label}</span>
            <span className="text-sm font-bold leading-tight tabular-nums">{counts[tab.id] ?? '–'}</span>
          </button>
        );
      })}
    </div>
  );
}
