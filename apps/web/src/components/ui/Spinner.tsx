import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  text?: string;
  className?: string;
}

export function Spinner({ text = 'Cargando...', className }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-10 text-slate-500', className)}>
      <Loader2 size={24} className="animate-spin mb-2 text-primary-500" />
      <p className="text-sm">{text}</p>
    </div>
  );
}
