import { Loader2, Square, Volume2 } from 'lucide-react';
import { focusRing } from '@/components/google/ui';
import { cn } from '@/lib/utils';
import { useBriefVoice } from './useBriefVoice';

/** El texto que Wabid dice a las 7:00, con el botón para escucharlo. */
export function SpokenCard({ text }: { text: string }) {
  const { state, toggle } = useBriefVoice(text);
  const busy = state === 'loading' || state === 'playing';

  return (
    <section className="card space-y-3" aria-label="Lo que dice Wabid">
      <p className="text-lg leading-relaxed text-slate-100">{text}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void toggle()}
          aria-pressed={busy}
          className={cn('btn-primary inline-flex min-h-[44px] items-center justify-center gap-2', focusRing)}
        >
          {state === 'loading' ? (
            <Loader2 size={18} aria-hidden="true" className="motion-safe:animate-spin" />
          ) : state === 'playing' ? (
            <Square size={18} aria-hidden="true" />
          ) : (
            <Volume2 size={18} aria-hidden="true" />
          )}
          {state === 'loading' ? 'Cargando voz' : state === 'playing' ? 'Detener' : 'Escuchar'}
        </button>
        <p role="status" className="text-sm text-slate-400">
          {state === 'error' ? 'No pude reproducir la voz. Intenta de nuevo.' : ''}
        </p>
      </div>
    </section>
  );
}
