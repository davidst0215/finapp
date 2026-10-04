import { useId } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { canToggle, deviceText, type DeviceBusy, type DevicePhase } from './logic';

type Props = {
  phase: DevicePhase;
  busy: DeviceBusy;
  error: string | null;
  onToggle: () => void;
};

// Interruptor de los avisos en este dispositivo. Es un checkbox real con role="switch": la fila entera es la
// etiqueta (objetivo táctil grande), se opera con teclado y un lector de pantalla anuncia nombre y estado.
export function PushSwitch({ phase, busy, error, onToggle }: Props) {
  const id = useId();
  const enabled = canToggle(phase, busy);

  return (
    <div className="p-4">
      <label htmlFor={`${id}-switch`} className={cn('flex items-start gap-4', enabled ? 'cursor-pointer' : 'cursor-default')}>
        <span className="min-w-0 flex-1">
          <span id={`${id}-title`} className="block text-base font-bold text-slate-100">
            Avisos en este dispositivo
          </span>
          <span id={`${id}-desc`} className="mt-1 block text-base leading-snug text-slate-300">
            {deviceText(phase, busy)}
          </span>
        </span>

        <span className="relative mt-0.5 inline-flex flex-shrink-0">
          <input
            id={`${id}-switch`}
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={phase === 'on'}
            disabled={!enabled}
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-desc`}
            onChange={onToggle}
          />
          <span
            aria-hidden="true"
            className={cn(
              'h-8 w-14 rounded-full border border-slate-500 bg-slate-800',
              'transition-colors duration-200 motion-reduce:transition-none',
              'peer-checked:border-primary-600 peer-checked:bg-primary-600',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900',
              'peer-disabled:opacity-50',
            )}
          />
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute left-1 top-1 h-6 w-6 rounded-full bg-slate-400',
              'transition-transform duration-200 motion-reduce:transition-none',
              'peer-checked:translate-x-6 peer-checked:bg-slate-950',
              'peer-disabled:opacity-50',
            )}
          />
        </span>
      </label>

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-base text-expense">
          <AlertCircle size={18} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
