import { cn } from '@/lib/utils';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: 'default' | 'accent' | 'alert';
  className?: string;
}

// Superficie plana: el borde marca la variante; solo "alert" usa el rojo.
export function GlassCard({ children, variant = 'default', className, ...props }: GlassCardProps) {
  return (
    <div
      {...props}
      className={cn(
        'relative rounded-2xl p-4 border bg-slate-900',
        variant === 'default' && 'border-slate-700',
        variant === 'accent' && 'border-slate-500',
        variant === 'alert' && 'border-expense/50',
        className,
      )}
    >
      {children}
    </div>
  );
}
