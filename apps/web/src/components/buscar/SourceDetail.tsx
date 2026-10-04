import { FileText } from 'lucide-react';
import type { SearchSource, SnippetPart } from '../tareas/types';

/** Fragmento con las coincidencias en negrita. El texto del servidor se pinta como texto de React, nunca como HTML. */
function Snippet({ parts }: { parts: readonly SnippetPart[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} className="bg-transparent font-bold text-slate-100">
            {part.t}
          </mark>
        ) : (
          <span key={i}>{part.t}</span>
        ),
      )}
    </>
  );
}

interface SourceDetailProps {
  source: SearchSource;
  /** Con `true` repite el número y el slug sobre el título (cuando no hay chips que los muestren). */
  showSlug?: boolean;
}

/** Una fuente: título, de qué proyecto o cliente es y el fragmento donde aparece lo buscado. */
export function SourceDetail({ source, showSlug = false }: SourceDetailProps) {
  const where = [source.kind === 'nota' ? 'Nota' : 'Ficha', source.proyecto, source.cliente]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <article aria-label={`Fuente ${source.n}: ${source.title}`}>
      {showSlug && (
        <p className="mb-1 flex items-center gap-1.5 text-[13px] text-slate-400">
          <FileText aria-hidden="true" size={14} className="shrink-0" />
          <span className="font-bold text-slate-200">{source.n}</span>
          <span className="min-w-0 truncate">{source.slug}</span>
        </p>
      )}
      <h3 className="text-[15px] font-semibold leading-snug text-slate-100">
        {!showSlug && <span className="mr-2 font-bold text-slate-400">{source.n}</span>}
        {source.title}
      </h3>
      <p className="mt-0.5 text-[13px] text-slate-400">{where}</p>
      <p className="mt-2 text-[14px] leading-relaxed text-slate-300">
        <Snippet parts={source.snippet} />
      </p>
    </article>
  );
}
