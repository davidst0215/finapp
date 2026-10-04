import { ChevronRight } from 'lucide-react';
import { ErrorNotice } from '../tareas/ErrorNotice';

/** Preguntas de ejemplo: tocar una la lanza. Genéricas a propósito (este código es público). */
export const EXAMPLE_QUESTIONS = [
  '¿Cómo está armado Wabid?',
  '¿Qué decidimos sobre el diseño de la app?',
  '¿Qué trampas conocidas tiene Norte?',
] as const;

interface SearchIntroProps {
  /** Documentos indexados; `null` mientras no llega (o si falló, y entonces `bootError` lo explica). */
  indexed: number | null;
  bootError: string | null;
  onPick: (question: string) => void;
  onRetry: () => void;
}

/** Estado inicial: qué hace esta pantalla, cuánto sabe y tres preguntas para empezar con un toque. */
export function SearchIntro({ indexed, bootError, onPick, onRetry }: SearchIntroProps) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[15.5px] leading-relaxed text-slate-200">
          Pregunta por cualquier proyecto; respondo con la ficha como fuente.
        </p>
        {indexed !== null && (
          <p className="mt-1 text-[14px] text-slate-400">
            {indexed.toLocaleString('es-PE')} {indexed === 1 ? 'ficha o nota indexada' : 'fichas y notas indexadas'}
          </p>
        )}
      </div>

      {bootError && <ErrorNotice message={bootError} onRetry={onRetry} />}

      <ul className="card divide-y divide-slate-700 py-0">
        {EXAMPLE_QUESTIONS.map((question) => (
          <li key={question}>
            <button
              type="button"
              onClick={() => onPick(question)}
              className="flex min-h-14 w-full items-center gap-3 rounded-lg py-3 text-left text-[15px] font-semibold text-slate-100 transition-colors [@media(hover:hover)]:hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300"
            >
              <span className="min-w-0 flex-1">{question}</span>
              <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-slate-400" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
