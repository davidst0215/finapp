import { cn } from '@/lib/utils';

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

// Interruptor de 52×44 (objetivo táctil ≥ 44px). Encendido/apagado se distingue por posición y relleno, no por color.
export function Switch({ checked, onChange, label, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative flex h-11 w-[52px] flex-shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
    >
      <span className={cn('block h-7 w-12 rounded-full transition-colors', checked ? 'bg-primary-600' : 'bg-slate-600')} />
      <span
        className={cn(
          'absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full transition-all',
          checked ? 'right-[8px] bg-slate-950' : 'left-[8px] bg-slate-400',
        )}
      />
    </button>
  );
}
