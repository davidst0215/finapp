import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  /** Estado visual relleno. Quien lo usa declara también aria-pressed o aria-expanded según el caso. */
  on?: boolean;
  /** `alert` es el único uso del rojo: cosas vencidas o en falla. */
  tone?: 'neutral' | 'alert';
  icon?: ReactNode;
}

const TONES = {
  neutral: {
    on: 'border-primary-600 bg-primary-600 text-slate-950',
    off: 'border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-500',
  },
  alert: {
    on: 'border-expense bg-expense text-slate-950',
    off: 'border-expense/50 bg-transparent text-expense hover:border-expense',
  },
} as const;

/**
 * Píldora de 32 px con zona táctil de 44 px: el `before` amplía el área sin mover el diseño
 * (7 px por lado medidos desde el borde interno; el borde de 1 px completa los 44).
 * Las filas de chips dejan al menos 12 px entre líneas para que esas zonas no se pisen.
 */
export function Chip({ children, on = false, tone = 'neutral', icon, className, type = 'button', ...rest }: ChipProps) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        'relative inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[14px] font-semibold transition-colors',
        'before:absolute before:inset-x-0 before:-inset-y-[7px]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50',
        on ? TONES[tone].on : TONES[tone].off,
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}
