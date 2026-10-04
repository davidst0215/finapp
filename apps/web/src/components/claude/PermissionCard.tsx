import { useId, useState } from 'react';
import { Check, Loader2, ShieldQuestion, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { countdown, toolLabel } from './format';
import type { ApprovalView, Decision } from './types';
import { useRemaining } from './useTick';

interface Props {
  approval: ApprovalView;
  /** performance.now() de la consulta que trajo `expires_in_ms`. */
  fetchedAt: number;
  onDecide: (approvalId: string, decision: Decision) => Promise<void>;
}

// Lo único que pide atención en esta pantalla: el comando exacto, de qué proyecto viene y cuánto falta para que venza.
export function PermissionCard({ approval, fetchedAt, onDecide }: Props) {
  const detailId = useId();
  const [busy, setBusy] = useState<Decision | null>(null);
  const remaining = useRemaining(approval.expires_in_ms, fetchedAt);
  const expired = remaining <= 0;

  const send = async (decision: Decision) => {
    if (busy || expired) return;
    setBusy(decision);
    try {
      await onDecide(approval.id, decision);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="card border-slate-500 space-y-3.5" aria-labelledby={`${detailId}-title`}>
      <header className="flex items-start gap-3">
        <ShieldQuestion size={22} strokeWidth={1.7} className="mt-0.5 flex-shrink-0 text-slate-200" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id={`${detailId}-title`} className="text-base font-bold leading-snug text-slate-100">
            Claude pide permiso
          </h2>
          <p className="truncate text-sm text-slate-400">{approval.project || 'Sesión de Claude Code'}</p>
        </div>
        <span role="timer" aria-live="off" className="whitespace-nowrap pt-0.5 text-sm font-bold tabular-nums text-slate-100">
          {expired ? 'Venció' : `Vence en ${countdown(remaining)}`}
        </span>
      </header>

      <div className="space-y-2">
        <p className="text-sm text-slate-300">{toolLabel(approval.tool_name)}:</p>
        <pre
          id={detailId}
          tabIndex={0}
          aria-label="Lo que Claude quiere hacer"
          className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-700 bg-slate-800 p-3 font-mono text-sm leading-relaxed text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          {approval.preview}
        </pre>
        {approval.truncated && (
          <p className="text-[13px] text-slate-300">Es largo: se muestran el inicio y el final. Lo del medio no se ve.</p>
        )}
        {approval.description && (
          <p className="text-[13px] text-slate-400">Claude dice que es para: {approval.description}</p>
        )}
      </div>

      {approval.truncated ? (
        <p className="text-sm text-slate-300">Es demasiado largo para aprobarlo a ciegas. Resuélvelo en la terminal.</p>
      ) : expired ? (
        <p className="text-sm text-slate-300">Venció. Claude Code lo preguntará en la terminal.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => send('denegar')}
            disabled={busy !== null}
            aria-describedby={detailId}
            className="btn-secondary flex min-h-[48px] items-center justify-center gap-2 disabled:opacity-50"
          >
            {busy === 'denegar' ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <X size={18} strokeWidth={2} aria-hidden="true" />}
            {busy === 'denegar' ? 'Rechazando…' : 'Rechazar'}
          </button>
          <button
            type="button"
            onClick={() => send('aprobar')}
            disabled={busy !== null}
            aria-describedby={detailId}
            className={cn('btn-primary flex min-h-[48px] items-center justify-center gap-2')}
          >
            {busy === 'aprobar' ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check size={18} strokeWidth={2} aria-hidden="true" />}
            {busy === 'aprobar' ? 'Aprobando…' : 'Aprobar'}
          </button>
        </div>
      )}
    </article>
  );
}
