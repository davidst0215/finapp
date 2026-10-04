import { useState } from 'react';
import { FileText } from 'lucide-react';
import { Chip } from '../tareas/Chip';
import type { SearchSource } from '../tareas/types';
import { SourceDetail } from './SourceDetail';

interface AnswerCardProps {
  /** Texto redactado; mientras es `null` y `waiting` es true, se dibuja el esqueleto. */
  answer: string | null;
  waiting: boolean;
  /** Qué se está esperando, con palabras: el esqueleto pulsa solo si el sistema permite animaciones. */
  waitingLabel: string;
  sources: readonly SearchSource[];
}

function AnswerSkeleton({ label }: { label: string }) {
  return (
    <div>
      <div aria-hidden="true" className="space-y-2.5 pt-1">
        <div className="h-3.5 w-full rounded bg-slate-700 motion-safe:animate-pulse" />
        <div className="h-3.5 w-[92%] rounded bg-slate-700 motion-safe:animate-pulse" />
        <div className="h-3.5 w-[64%] rounded bg-slate-700 motion-safe:animate-pulse" />
      </div>
      <p className="mt-3 text-[13px] text-slate-400">{label}</p>
    </div>
  );
}

/**
 * La respuesta arriba; debajo, una píldora por fuente (numerada como la cita la respuesta).
 * Tocar una píldora abre o cierra el fragmento de esa fuente. Las fuentes llegan antes que el texto:
 * se pueden leer mientras la respuesta se redacta.
 */
export function AnswerCard({ answer, waiting, waitingLabel, sources }: AnswerCardProps) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());

  const toggle = (n: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <section className="card" aria-label="Respuesta" aria-busy={waiting}>
      {answer ? (
        <p className="whitespace-pre-line text-[15.5px] leading-relaxed text-slate-100">{answer}</p>
      ) : (
        <AnswerSkeleton label={waitingLabel} />
      )}

      {sources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-2 gap-y-3">
          {sources.map((source) => (
            <Chip
              key={source.n}
              on={open.has(source.n)}
              aria-expanded={open.has(source.n)}
              aria-controls={`fuente-${source.n}`}
              aria-label={`Fuente ${source.n} ${source.slug}`}
              icon={<FileText aria-hidden="true" size={14} />}
              onClick={() => toggle(source.n)}
              className="max-w-full text-[13px]"
            >
              <span className="font-bold">{source.n}</span>
              <span className="min-w-0 truncate">{source.slug}</span>
            </Chip>
          ))}
        </div>
      )}

      {sources
        .filter((source) => open.has(source.n))
        .map((source) => (
          <div key={source.n} id={`fuente-${source.n}`} className="mt-3 border-t border-slate-700 pt-3">
            <SourceDetail source={source} />
          </div>
        ))}
    </section>
  );
}
