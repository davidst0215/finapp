import { useState } from 'react';
import { Check, ChevronDown, Clock, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { limaDayClock, toolLabel } from './format';
import type { ApprovalStatus, ApprovalView } from './types';

interface Props {
  approvals: ApprovalView[];
  /** Date.now() para decidir si el día se muestra. */
  now: number;
}

const OUTCOME: Record<Exclude<ApprovalStatus, 'pendiente'>, { word: string; Icon: typeof Check }> = {
  aprobada: { word: 'Aprobada', Icon: Check },
  denegada: { word: 'Rechazada', Icon: X },
  vencida: { word: 'Venció', Icon: Clock },
};

// Registro de lo que se aprobó o rechazó desde el celular (las últimas 24 h). Cerrado por defecto: es consulta, no alerta.
export function RecentApprovals({ approvals, now }: Props) {
  const [open, setOpen] = useState(false);
  if (approvals.length === 0) return null;

  return (
    <section className="divide-y divide-slate-700 rounded-2xl border border-slate-700 bg-slate-800/40 p-0" aria-label="Permisos recientes">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[52px] w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
      >
        <span className="flex-1 text-base font-bold text-slate-100">Permisos recientes</span>
        <span className="text-[13px] tabular-nums text-slate-400">{approvals.length}</span>
        <ChevronDown
          size={18}
          strokeWidth={1.7}
          aria-hidden="true"
          className={cn('flex-shrink-0 text-slate-400 transition-transform motion-reduce:transition-none', open && 'rotate-180')}
        />
      </button>
      {open && (
        <ul className="divide-y divide-slate-700">
          {approvals.map((a) => {
            if (a.status === 'pendiente') return null;
            const { word, Icon } = OUTCOME[a.status];
            return (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                <Icon size={16} strokeWidth={2} aria-hidden="true" className="mt-1 flex-shrink-0 text-slate-300" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[13px] text-slate-100">{a.preview.split('\n')[0]}</p>
                  <p className="text-[13px] text-slate-400">
                    {word} · {toolLabel(a.tool_name)} · {a.project || 'Sesión'} · {limaDayClock(a.decided_at ?? a.created_at, now)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
