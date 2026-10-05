import { useId, useState } from 'react';
import { Check, Clock, Loader2, ShieldQuestion, X } from 'lucide-react';
import { countdown, toolLabel } from './format';
import type { ApprovalView, Decision } from './types';
import { useRemaining } from './useTick';

interface Props {
  approval: ApprovalView;
  /** performance.now() de la consulta que trajo `expires_in_ms`. */
  fetchedAt: number;
  onDecide: (approvalId: string, decision: Decision) => Promise<boolean>;
}

// Lo único que pide atención dentro del chat: el comando exacto y cuánto falta para que venza.
export function PermissionMessage({ approval, fetchedAt, onDecide }: Props) {
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
    <article className="w-full max-w-[94%] space-y-3 rounded-2xl rounded-bl-md border border-slate-500 bg-slate-900 p-3.5" aria-labelledby={`${detailId}-title`}>
      <header className="flex items-start gap-2.5">
        <ShieldQuestion size={20} strokeWidth={1.8} className="mt-0.5 flex-shrink-0 text-slate-100" aria-hidden="true" />
        <h2 id={`${detailId}-title`} className="min-w-0 flex-1 text-base font-bold leading-snug text-slate-100">
          Claude te necesita: aprueba o rechaza
        </h2>
      </header>

      <div className="space-y-1.5">
        <p className="text-[13px] text-slate-300">
          {toolLabel(approval.tool_name)}
          {approval.description ? ` · ${approval.description}` : ''}
        </p>
        <pre
          id={detailId}
          tabIndex={0}
          aria-label="Lo que Claude quiere hacer"
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-700 bg-slate-800 p-3 font-mono text-[14px] leading-relaxed text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          {approval.preview}
        </pre>
        {approval.truncated && <p className="text-[13px] text-slate-300">Es largo: se muestran el inicio y el final. Lo del medio no se ve.</p>}
      </div>

      {approval.truncated ? (
        <p className="text-sm text-slate-300">Es demasiado largo para aprobarlo a ciegas. Resuélvelo en la terminal.</p>
      ) : expired ? (
        <p className="flex items-center gap-2 text-sm text-slate-300">
          <Clock size={16} aria-hidden="true" /> Venció. Claude Code lo preguntará en la terminal.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
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
              className="btn-primary flex min-h-[48px] items-center justify-center gap-2"
            >
              {busy === 'aprobar' ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check size={18} strokeWidth={2} aria-hidden="true" />}
              {busy === 'aprobar' ? 'Aprobando…' : 'Aprobar'}
            </button>
          </div>
          <p role="timer" aria-live="off" className="text-center text-[13px] tabular-nums text-slate-300">
            Vence en {countdown(remaining)}. Sin respuesta, Claude Code pregunta en la terminal.
          </p>
        </>
      )}
    </article>
  );
}
