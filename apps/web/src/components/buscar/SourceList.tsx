import type { SearchSource } from '../tareas/types';
import { SourceDetail } from './SourceDetail';

interface SourceListProps {
  sources: readonly SearchSource[];
  /** Por qué no hay respuesta redactada, si el servidor o la llamada lo explicaron. */
  answerError: string | null;
}

/** Sin respuesta redactada: las fuentes con su fragmento van directo a la vista, sin pedir un toque. */
export function SourceList({ sources, answerError }: SourceListProps) {
  return (
    <section className="card" aria-label="Fuentes">
      {answerError && (
        <p className="mb-3 break-words border-b border-slate-700 pb-3 text-[14px] leading-snug text-slate-400">
          <span className="font-semibold text-slate-200">Sin respuesta redactada.</span> {answerError}
        </p>
      )}
      <ul className="divide-y divide-slate-700">
        {sources.map((source) => (
          <li key={source.n} className="py-3 first:pt-0 last:pb-0">
            <SourceDetail source={source} showSlug />
          </li>
        ))}
      </ul>
    </section>
  );
}
