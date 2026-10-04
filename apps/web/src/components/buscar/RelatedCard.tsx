import { useId } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import type { SearchRelated } from '../tareas/types';

interface RelatedCardProps {
  items: readonly SearchRelated[];
  /** Lanza una búsqueda nueva con el título de la ficha. */
  onPick: (item: SearchRelated) => void;
}

/** Fichas cercanas a lo que se buscó: tocar una pregunta por ella. */
export function RelatedCard({ items, onPick }: RelatedCardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="card pb-1.5 pt-3.5">
      <h2 id={titleId} className="text-[15px] font-bold text-slate-200">
        Relacionado
      </h2>
      <ul className="mt-1 divide-y divide-slate-700">
        {items.map((item) => (
          <li key={item.path}>
            <button
              type="button"
              onClick={() => onPick(item)}
              className="flex min-h-14 w-full items-center gap-3 rounded-lg py-2.5 text-left transition-colors [@media(hover:hover)]:hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-slate-800 text-slate-200">
                <Folder aria-hidden="true" size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-slate-100">{item.title}</span>
                <span className="block truncate text-[13px] text-slate-400">
                  {item.slug}
                  {item.proyecto ? ` · ${item.proyecto}` : ''}
                </span>
              </span>
              <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-slate-400" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
