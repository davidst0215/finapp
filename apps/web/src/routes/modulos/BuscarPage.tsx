import { useId, useState } from 'react';
import { History } from 'lucide-react';
import { AnswerCard } from '@/components/buscar/AnswerCard';
import { ClienteChips } from '@/components/buscar/ClienteChips';
import { NoResults } from '@/components/buscar/NoResults';
import { RecentSearches } from '@/components/buscar/RecentSearches';
import { RelatedCard } from '@/components/buscar/RelatedCard';
import { SearchBar } from '@/components/buscar/SearchBar';
import { SearchIntro } from '@/components/buscar/SearchIntro';
import { SourceList } from '@/components/buscar/SourceList';
import { useSearch, type SearchOutcome, type SearchPhase } from '@/components/buscar/useSearch';
import { ErrorNotice } from '@/components/tareas/ErrorNotice';
import { PageHeader } from '@/components/tareas/PageHeader';
import { cn } from '@/lib/utils';

/** Lo que oye un lector de pantalla mientras la búsqueda avanza (la vista lo muestra con esqueleto y texto). */
function statusText(phase: SearchPhase, outcome: SearchOutcome | null): string {
  const count = outcome?.sources.length ?? 0;
  switch (phase) {
    case 'searching':
      return 'Buscando…';
    case 'answering':
      return `${count} ${count === 1 ? 'fuente encontrada' : 'fuentes encontradas'}. Redactando respuesta…`;
    case 'done':
      if (count === 0) return 'Sin resultados.';
      return outcome?.answer ? 'Respuesta lista.' : 'Fuentes listas, sin respuesta redactada.';
    default:
      return '';
  }
}

/** Pregunta a la memoria: fuentes con fragmento primero, respuesta redactada después. */
export function BuscarPage() {
  const {
    query,
    setQuery,
    cliente,
    clientes,
    indexed,
    bootError,
    boot,
    phase,
    outcome,
    error,
    recents,
    submit,
    selectCliente,
    clear,
    forgetRecents,
  } = useSearch();
  const [showRecents, setShowRecents] = useState(false);
  const recentsId = useId();

  const ask = (question: string) => {
    setShowRecents(false);
    window.scrollTo({ top: 0 });
    void submit(question);
  };

  return (
    <div className="space-y-3 selection:bg-slate-600 selection:text-slate-100">
      <PageHeader
        title="Buscar"
        action={
          <button
            type="button"
            onClick={() => setShowRecents((v) => !v)}
            aria-label="Búsquedas recientes"
            aria-expanded={showRecents}
            aria-controls={recentsId}
            className={cn(
              'grid h-11 w-11 shrink-0 place-items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
              showRecents
                ? 'border-primary-600 bg-primary-600 text-slate-950'
                : 'border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-500',
            )}
          >
            <History aria-hidden="true" size={20} />
          </button>
        }
      />

      <SearchBar value={query} onChange={setQuery} onSubmit={() => void submit()} onClear={clear} />

      {showRecents && <RecentSearches id={recentsId} items={recents} onPick={ask} onClear={forgetRecents} />}

      <ClienteChips clientes={clientes} selected={cliente} onSelect={selectCliente} />

      <p role="status" className="sr-only">
        {statusText(phase, outcome)}
      </p>

      <div className="space-y-4 pt-1">
        {phase === 'idle' && (
          <SearchIntro indexed={indexed} bootError={bootError} onPick={ask} onRetry={() => void boot()} />
        )}

        {phase === 'error' && error && <ErrorNotice message={error} onRetry={() => void submit(query)} />}

        {phase === 'searching' && (
          <AnswerCard key="pending" answer={null} waiting waitingLabel="Buscando en tus fichas…" sources={[]} />
        )}

        {outcome && outcome.sources.length === 0 && (
          <NoResults cliente={cliente} onClearCliente={() => selectCliente(null)} />
        )}

        {outcome && outcome.sources.length > 0 && (
          <>
            {outcome.answer || phase === 'answering' ? (
              <AnswerCard
                key={outcome.q}
                answer={outcome.answer}
                waiting={phase === 'answering'}
                waitingLabel="Redactando respuesta…"
                sources={outcome.sources}
              />
            ) : (
              <SourceList sources={outcome.sources} answerError={outcome.answerError} />
            )}
          </>
        )}

        {outcome && outcome.related.length > 0 && (
          <RelatedCard items={outcome.related} onPick={(item) => ask(item.title)} />
        )}
      </div>
    </div>
  );
}
