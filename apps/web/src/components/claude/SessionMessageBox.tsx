import { useState } from 'react';
import { Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { limaDayClock, messageStatusLabel } from './format';
import type { MessageView, SessionView } from './types';

const MAX = 2000;

interface Props {
  session: SessionView;
  /** Mensajes recientes de ESTA sesión (sin texto: el servidor lo borra al entregar). */
  messages: MessageView[];
  now: number;
  onSend: (sessionId: string, text: string) => Promise<boolean>;
}

// "Escríbele": el mensaje queda en cola y el hook Stop de la laptop lo entrega cuando Claude termina su turno.
export function SessionMessageBox({ session, messages, now, onSend }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ended = session.status === 'terminada';
  const fieldId = `claude-msg-${session.id}`;
  const trimmed = text.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || !trimmed) return;
    setSending(true);
    try {
      if (await onSend(session.id, trimmed)) setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2 border-t border-slate-700 pt-3">
      <label htmlFor={fieldId} className="text-sm font-bold text-slate-100">
        Escríbele
      </label>
      {ended ? (
        <p className="text-sm text-slate-400">Esta sesión ya terminó. Para seguir, abre una conversación nueva o lanza una tarea.</p>
      ) : (
        <>
          <textarea
            id={fieldId}
            className="input min-h-[96px] resize-y text-base"
            value={text}
            maxLength={MAX}
            rows={3}
            placeholder="Qué quieres que haga a continuación"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-[13px] text-slate-400">
              Se entrega cuando Claude termine su turno. Con «Aprobar desde el celular» activo, la laptop espera tu mensaje unos 2 min.
            </p>
            <span className="text-[13px] tabular-nums text-slate-400" aria-hidden="true">
              {text.length}/{MAX}
            </span>
          </div>
          <button type="submit" disabled={sending || !trimmed} className="btn-primary flex min-h-[48px] w-full items-center justify-center gap-2">
            <Send size={16} strokeWidth={2} aria-hidden="true" />
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </>
      )}
      {messages.length > 0 && (
        <ul className="space-y-1" aria-label="Estado de tus mensajes">
          {messages.slice(0, 3).map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-sm text-slate-300">
              <span
                aria-hidden="true"
                className={cn(
                  'h-2 w-2 flex-shrink-0 rounded-full',
                  m.status === 'en_cola' && 'border-2 border-slate-100',
                  m.status === 'entregando' && 'border-2 border-slate-100 bg-slate-500',
                  m.status === 'entregado' && 'bg-slate-100',
                  m.status === 'vencido' && 'border border-dashed border-slate-400',
                )}
              />
              <span className="font-semibold text-slate-100">{messageStatusLabel(m.status)}</span>
              <span className="text-slate-400">· {limaDayClock(m.delivered_at ?? m.created_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
