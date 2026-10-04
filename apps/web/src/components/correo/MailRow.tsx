import { useId, useState, type FormEvent } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { googleCall, GoogleUiError, needsConnection } from '../google/googleApi';
import { whenLabel } from '../google/lima';
import type { DraftItem, MailItem } from '../google/types';
import { btnPrimary, btnSecondary, focusRing } from '../google/ui';
import { DOT_LABEL, dotKind, gmailThreadUrl, rowTitle } from './mailModel';

type Props = {
  item: MailItem;
  account: string; // correo de la cuenta conectada
  open: boolean;
  canCompose: boolean;
  onToggle: () => void;
  onDraft: (draft: DraftItem) => void;
  onNeedsConnection: () => void;
};

/** Una fila de la bandeja. Al tocarla se abre en el mismo lugar: resumen, responder con borrador y abrir en Gmail. */
export function MailRow({ item, account, open, canCompose, onToggle, onDraft, onNeedsConnection }: Props) {
  const panelId = useId();
  const [replying, setReplying] = useState(false);
  const kind = dotKind(item);

  return (
    <li className="border-t border-slate-700 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (open) setReplying(false);
          onToggle();
        }}
        className={cn('grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg py-3 text-left', focusRing)}
      >
        <span className="mt-[0.45rem] flex justify-center">
          <span
            aria-hidden="true"
            className={cn('h-2.5 w-2.5 rounded-full', kind === 'alarm' && 'bg-expense', kind === 'unread' && 'bg-slate-100', kind === 'read' && 'border-[1.5px] border-slate-400')}
          />
          <span className="sr-only">{DOT_LABEL[kind]}</span>
        </span>
        <span className="min-w-0">
          <span className={cn('block text-base font-semibold text-slate-100', open ? 'break-words' : 'truncate')}>{rowTitle(item)}</span>
          {item.snippet && <span className={cn('mt-0.5 block text-sm text-slate-400', !open && 'line-clamp-2')}>{item.snippet}</span>}
        </span>
        <span className="flex flex-col items-end gap-1.5 pt-0.5">
          <span className="whitespace-nowrap text-[13px] text-slate-400">{whenLabel(item.received_at)}</span>
          {kind === 'alarm' ? (
            <span className="rounded-full border border-expense/60 px-2 py-0.5 text-xs font-bold text-expense">Alerta</span>
          ) : (
            <ChevronDown size={16} strokeWidth={1.8} aria-hidden="true" className={cn('text-slate-400', open && 'rotate-180')} />
          )}
        </span>
      </button>

      {open && (
        <div id={panelId} className="space-y-3 pb-4 pl-7">
          <p className="break-all text-sm text-slate-400">
            De {item.from_name ? `${item.from_name} · ` : ''}
            {item.from_email}
          </p>

          {!replying && (
            <div className="flex flex-wrap gap-2">
              {canCompose && (
                <button type="button" onClick={() => setReplying(true)} className={btnPrimary}>
                  Responder
                </button>
              )}
              <a href={gmailThreadUrl(account, item.thread_id)} target="_blank" rel="noopener noreferrer" className={btnSecondary}>
                Abrir en Gmail <ExternalLink size={16} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">(se abre en otra pestaña)</span>
              </a>
            </div>
          )}
          {!canCompose && !replying && <p className="text-sm text-slate-400">Para responder desde aquí falta el permiso de borradores. Reconecta Google en Agenda.</p>}

          {replying && (
            <ReplyComposer
              item={item}
              onCancel={() => setReplying(false)}
              onSaved={(draft) => {
                setReplying(false);
                onDraft(draft);
              }}
              onNeedsConnection={onNeedsConnection}
            />
          )}
        </div>
      )}
    </li>
  );
}

function ReplyComposer({ item, onCancel, onSaved, onNeedsConnection }: {
  item: MailItem;
  onCancel: () => void;
  onSaved: (draft: DraftItem) => void;
  onNeedsConnection: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { draft } = await googleCall<{ draft: DraftItem }>('draft.create', { thread_id: item.thread_id, message_id: item.id, body: text.trim(), use_reply_to: true });
      onSaved(draft);
    } catch (err) {
      if (needsConnection(err)) onNeedsConnection();
      setError(err instanceof GoogleUiError ? err.message : 'No pude guardar el borrador. Intenta de nuevo.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Responder con un borrador">
      <label className="block space-y-1.5">
        <span className="text-sm text-slate-400">Tu respuesta a {item.from_name || item.from_email}</span>
        <textarea
          autoFocus
          required
          rows={5}
          maxLength={8000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="input min-h-[8rem] resize-y text-base leading-relaxed"
        />
      </label>
      <p className="text-sm text-slate-400">Se guarda como borrador en el mismo hilo. No se envía hasta que toques «Enviar» en Borradores.</p>
      {error && <p role="alert" className="text-sm text-expense">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={cn(btnSecondary, 'flex-1')}>
          Cancelar
        </button>
        <button type="submit" disabled={busy || !text.trim()} className={cn(btnPrimary, 'flex-1')}>
          {busy ? 'Guardando…' : 'Guardar borrador'}
        </button>
      </div>
    </form>
  );
}
