import { cn } from '@/lib/utils';
import type { ConversationTone } from './conversations';

// El estado se lee por forma y por texto, nunca solo por color (DESIGN.md): punto lleno = trabajando, punto con halo = te
// necesita, anillo = te espera, anillo discontinuo = en cola o sin actividad, hueco fino = terminó, rojo (único color) = falló.
const SHAPE: Record<ConversationTone, string> = {
  active: 'bg-slate-100',
  asking: 'bg-slate-100 ring-[3px] ring-slate-100/30',
  waiting: 'border-2 border-slate-100',
  queued: 'border-2 border-dashed border-slate-300',
  done: 'border border-slate-400',
  stale: 'border border-dashed border-slate-400',
  error: 'bg-expense',
};

export function StateDot({ tone, className }: { tone: ConversationTone; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full', SHAPE[tone], className)} />;
}
