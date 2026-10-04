import { useEffect, useId, useState } from 'react';
import { ExternalLink, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { googleCall, GoogleUiError, needsConnection } from '../google/googleApi';
import type { DraftItem } from '../google/types';
import { btnPrimary, btnSecondary } from '../google/ui';
import { canSend, gmailDraftsUrl } from './mailModel';

type Mode = 'view' | 'edit' | 'confirm' | 'sending';

type Props = {
  draft: DraftItem;
  account: string;
  canCompose: boolean;
  onChanged: (draft: DraftItem) => void;
  onSent: (draft: DraftItem) => void;
  /** El borrador cambió o desapareció en Gmail: hay que recargar la lista. */
  onStale: () => void;
  onNeedsConnection: () => void;
};

const SEND_ARM_MS = 700; // el botón de confirmar no responde a un doble toque sobre "Enviar"

/**
 * Borrador para aprobar. Enviar es un paso en dos tiempos: "Enviar" muestra a quién y pide confirmar;
 * solo "Enviar ahora" manda el correo, y solo si el borrador sigue siendo el mismo que estás viendo.
 */
export function DraftCard({ draft, account, canCompose, onChanged, onSent, onStale, onNeedsConnection }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const uid = useId();
  const [mode, setMode] = useState<Mode>('view');
  const [text, setText] = useState(draft.body);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode !== 'confirm') return;
    const timer = setTimeout(() => setArmed(true), SEND_ARM_MS);
    return () => {
      clearTimeout(timer);
      setArmed(false);
    };
  }, [mode]);

  const fail = (e: unknown, fallback: string) => {
    if (needsConnection(e)) onNeedsConnection();
    return e instanceof GoogleUiError ? e.message : fallback;
  };

  const save = async () => {
    if (saving || !text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { draft: updated } = await googleCall<{ draft: DraftItem }>('draft.update', { draft_id: draft.draft_id, body: text.trim() });
      onChanged(updated);
      setMode('view');
    } catch (e) {
      if (e instanceof GoogleUiError && e.code === 'no_encontrado') onStale();
      setError(fail(e, 'No pude guardar los cambios. Intenta de nuevo.'));
    }
    setSaving(false);
  };

  const send = async () => {
    setMode('sending');
    setError(null);
    try {
      await googleCall('draft.send', { draft_id: draft.draft_id, expected_message_id: draft.message_id, confirm: true });
      addToast(`Correo enviado a ${draft.to || draft.to_email}.`, 'success');
      onSent(draft);
    } catch (e) {
      const message = fail(e, 'No pude enviar el correo. Revisa tu conexión: el borrador sigue guardado.');
      if (e instanceof GoogleUiError && (e.code === 'cambio' || e.code === 'no_encontrado')) {
        // Otro cambio o ya se envió: se recarga la lista para ver el estado real antes de decidir.
        setError(message);
        setMode('view');
        onStale();
        return;
      }
      setError(message);
      setMode('confirm');
    }
  };

  const recipient = draft.to || 'Sin destinatario';
  const sendable = canSend(draft);

  return (
    <article className="card space-y-3" aria-labelledby={`${uid}-head`}>
      <p id={`${uid}-head`} className="break-words text-sm text-slate-400">
        Para {recipient} · {draft.subject}
      </p>

      {mode === 'edit' ? (
        <label className="block">
          <span className="sr-only">Texto del borrador</span>
          <textarea
            autoFocus
            rows={8}
            maxLength={8000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="input min-h-[10rem] resize-y text-base leading-relaxed"
          />
        </label>
      ) : (
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-base leading-relaxed text-slate-100">{draft.body || '(vacío)'}</p>
      )}

      {error && <p role="alert" className="text-sm text-expense">{error}</p>}

      {mode === 'view' && (
        <>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setText(draft.body);
                setError(null);
                setMode('edit');
              }}
              disabled={!canCompose || !draft.editable}
              className={cn(btnSecondary, 'flex-1')}
            >
              Editar
            </button>
            <button type="button" onClick={() => { setError(null); setMode('confirm'); }} disabled={!canCompose || !sendable} className={cn(btnPrimary, 'flex-1')}>
              <Send size={18} strokeWidth={1.8} aria-hidden="true" /> Enviar
            </button>
          </div>
          {!draft.editable && (
            <p className="text-sm text-slate-400">
              Tiene adjuntos: edítalo en{' '}
              <a href={gmailDraftsUrl(account)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1 px-1 font-semibold text-slate-200 underline underline-offset-4">
                Gmail <ExternalLink size={14} aria-hidden="true" />
                <span className="sr-only">(se abre en otra pestaña)</span>
              </a>{' '}
              para no perderlos.
            </p>
          )}
          {draft.editable && !sendable && <p className="text-sm text-slate-400">{draft.send_blocked || 'Falta el destinatario. Complétalo en Gmail antes de enviar.'}</p>}
          {!canCompose && <p className="text-sm text-slate-400">Falta el permiso de borradores. Reconecta Google en Agenda.</p>}
        </>
      )}

      {mode === 'edit' && (
        <div className="flex gap-2">
          <button type="button" onClick={() => setMode('view')} disabled={saving} className={cn(btnSecondary, 'flex-1')}>
            Cancelar
          </button>
          <button type="button" onClick={save} disabled={saving || !text.trim() || text.trim() === draft.body.trim()} className={cn(btnPrimary, 'flex-1')}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      )}

      {(mode === 'confirm' || mode === 'sending') && (
        <div role="group" aria-labelledby={`${uid}-confirm`} className="space-y-3 rounded-xl border border-slate-500 p-3">
          <p id={`${uid}-confirm`} className="text-base text-slate-100">
            Se enviará a <strong className="break-all font-bold">{draft.to_email}</strong>
            {draft.cc && <> · Cc <strong className="break-all font-bold">{draft.cc}</strong></>}
            {draft.bcc && <> · Cco <strong className="break-all font-bold">{draft.bcc}</strong></>} con el texto de arriba. No se puede deshacer.
          </p>
          <div className="flex gap-2">
            <button type="button" autoFocus onClick={() => setMode('view')} disabled={mode === 'sending'} className={cn(btnSecondary, 'flex-1')}>
              Cancelar
            </button>
            <button type="button" onClick={send} disabled={!armed || mode === 'sending'} className={cn(btnPrimary, 'flex-1')}>
              <Send size={18} strokeWidth={1.8} aria-hidden="true" /> {mode === 'sending' ? 'Enviando…' : 'Enviar ahora'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
