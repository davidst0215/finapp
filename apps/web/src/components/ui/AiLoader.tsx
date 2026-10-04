import { cn } from '@/lib/utils';

interface AiLoaderProps {
  text?: string;
  className?: string;
}

export function AiLoader({ text = 'Procesando', className }: AiLoaderProps) {
  const letters = text.split('');

  return (
    <div className={cn('flex flex-col items-center gap-4', className)}>
      <div className="flex items-center gap-0.5">
        {letters.map((letter, i) => (
          <span
            key={i}
            className="loader-letter text-lg font-semibold text-slate-300"
            style={{ animationDelay: `${i * 0.1}s` }}
          >
            {letter === ' ' ? '\u00A0' : letter}
          </span>
        ))}
      </div>
      <div className="ai-loader-orb" />
    </div>
  );
}
