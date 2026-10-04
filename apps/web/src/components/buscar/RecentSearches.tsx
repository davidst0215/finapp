import { History } from 'lucide-react';

interface RecentSearchesProps {
  id: string;
  items: readonly string[];
  onPick: (query: string) => void;
  onClear: () => void;
}

/** Panel de búsquedas recientes (máx. 8, las guarda el hook en localStorage). */
export function RecentSearches({ id, items, onPick, onClear }: RecentSearchesProps) {
  return (
    <section id={id} aria-label="Búsquedas recientes" className="card py-1">
      {items.length === 0 ? (
        <p className="py-3 text-[14px] text-slate-400">Aún no hay búsquedas recientes.</p>
      ) : (
        <>
          <ul className="divide-y divide-slate-700">
            {items.map((query) => (
              <li key={query}>
                <button
                  type="button"
                  onClick={() => onPick(query)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-lg text-left text-[15px] text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300"
                >
                  <History aria-hidden="true" size={16} className="shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate">{query}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-700">
            <button
              type="button"
              onClick={onClear}
              className="min-h-11 rounded-lg text-[14px] font-semibold text-slate-400 underline decoration-slate-600 underline-offset-4 transition-colors [@media(hover:hover)]:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
            >
              Borrar historial
            </button>
          </div>
        </>
      )}
    </section>
  );
}
