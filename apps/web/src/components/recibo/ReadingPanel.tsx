import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PreparedImage } from './prepareImage.ts';
import { PhotoThumb } from './PhotoThumb';
import { readingMessage } from './reciboLogic.ts';

type StepState = 'done' | 'current' | 'pending';

interface Props {
  stage: 'preparing' | 'reading';
  photo: PreparedImage | null;
  /** Instante (ms) en que empezó la lectura; null mientras se prepara la foto. */
  startedAt: number | null;
  onCancel: () => void;
}

function useElapsedSeconds(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return elapsed;
}

// Cada estado se distingue por forma (check, anillo con punto, círculo vacío), no por animación ni color.
function StepMark({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-600 text-slate-950">
        <Check size={12} strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-slate-100">
        <span className="h-2 w-2 rounded-full bg-slate-100 motion-safe:animate-pulse" />
      </span>
    );
  }
  return <span className="h-5 w-5 shrink-0 rounded-full border border-slate-600" />;
}

/** Espera de la lectura: pasos con texto que avanza y un esqueleto de lo que viene. */
export function ReadingPanel({ stage, photo, startedAt, onCancel }: Props) {
  const elapsed = useElapsedSeconds(startedAt);
  const message = readingMessage(elapsed);
  const preparing = stage === 'preparing';

  const steps: { label: string; state: StepState }[] = [
    { label: preparing ? 'Preparando la foto…' : 'Foto lista', state: preparing ? 'current' : 'done' },
    { label: preparing ? 'Leer total, fecha y comercio' : message.text, state: preparing ? 'pending' : 'current' },
    { label: 'Revisar y registrar', state: 'pending' },
  ];

  return (
    <section aria-label="Leyendo la boleta" className="space-y-4">
      <div className="card space-y-4">
        <div className="flex items-start gap-4">
          {photo ? (
            <PhotoThumb photo={photo} />
          ) : (
            <div aria-hidden="true" className="h-[72px] w-14 shrink-0 rounded-lg bg-slate-800 motion-safe:animate-pulse" />
          )}
          <ol className="min-w-0 flex-1 space-y-3 pt-0.5">
            {steps.map((step, i) => (
              <li
                key={i}
                aria-current={step.state === 'current' ? 'step' : undefined}
                className="flex items-center gap-3 text-[15px] leading-snug"
              >
                <StepMark state={step.state} />
                <span
                  className={cn(
                    'min-w-0 flex-1',
                    step.state === 'current' && 'font-semibold text-slate-100',
                    step.state === 'done' && 'text-slate-300',
                    step.state === 'pending' && 'text-slate-400',
                  )}
                >
                  {step.label}
                </span>
                {step.state === 'current' && !preparing && elapsed >= 3 && (
                  <span className="text-sm tabular-nums text-slate-400">{elapsed} s</span>
                )}
              </li>
            ))}
          </ol>
        </div>
        {!preparing && message.slow && (
          <p className="text-base leading-relaxed text-slate-300">
            Puedes seguir esperando o cancelar y probar con otra foto.
          </p>
        )}
      </div>

      <div aria-hidden="true" className="card space-y-4 motion-safe:animate-pulse">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-16 rounded bg-slate-800" />
            <div className="h-12 rounded-xl bg-slate-800" />
          </div>
        ))}
      </div>

      <button type="button" onClick={onCancel} className="btn-secondary w-full">
        Cancelar
      </button>
    </section>
  );
}
