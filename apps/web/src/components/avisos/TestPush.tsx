import { AlertCircle, CheckCircle2, Info, Loader2, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DevicePhase, TestOutcome } from './logic';

type Props = {
  phase: DevicePhase;
  testing: boolean;
  outcome: TestOutcome | null;
  onTest: () => void;
};

const TONE = {
  ok: { icon: CheckCircle2, color: 'text-slate-200' },
  warn: { icon: Info, color: 'text-slate-300' },
  error: { icon: AlertCircle, color: 'text-expense' }, // el rojo es solo para fallos reales
} as const;

// Botón de "aviso de prueba" y el resultado, en una región de estado que los lectores de pantalla anuncian.
export function TestPush({ phase, testing, outcome, onTest }: Props) {
  const ready = phase === 'on';
  const hint = !ready && phase === 'off' ? 'Activa los avisos en este dispositivo para probarlos.' : null;
  const tone = outcome ? TONE[outcome.tone] : null;
  const Icon = tone?.icon;

  return (
    <div className="p-4">
      <button
        type="button"
        className="btn-primary flex min-h-[48px] w-full items-center justify-center gap-2"
        disabled={!ready || testing}
        onClick={onTest}
      >
        {testing ? (
          <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Send size={18} strokeWidth={1.8} aria-hidden="true" />
        )}
        {testing ? 'Enviando…' : 'Enviarme un aviso de prueba'}
      </button>

      <p role="status" aria-live="polite" className={cn('flex items-start gap-2 text-base', (outcome || hint) && 'mt-3', tone?.color ?? 'text-slate-400')}>
        {outcome && Icon ? (
          <>
            <Icon size={18} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{outcome.message}</span>
          </>
        ) : (
          hint
        )}
      </p>
    </div>
  );
}
