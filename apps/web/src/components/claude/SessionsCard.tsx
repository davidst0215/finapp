import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError, claudeApi } from './api';
import { describeSession, eventWord, limaClock, type SessionTone } from './format';
import { SessionMessageBox } from './SessionMessageBox';
import type { ApprovalView, EventView, MessageView, SessionView } from './types';

interface Props {
  sessions: SessionView[];
  pendingBySession: Map<string, ApprovalView>;
  /** Date.now() para los textos relativos. */
  now: number;
  messages: MessageView[];
  onSend: (sessionId: string, text: string) => Promise<boolean>;
}

// El estado se lee por forma y por texto, nunca solo por color: punto lleno = trabajando, anillo = te espera,
// hueco = terminó, rojo (único color) = falló.
function StateDot({ tone }: { tone: SessionTone }) {
  const shape: Record<SessionTone, string> = {
    active: 'bg-slate-100',
    asking: 'bg-slate-100 ring-4 ring-slate-100/25',
    waiting: 'border-2 border-slate-100',
    done: 'border border-slate-400',
    stale: 'border border-dashed border-slate-400',
    error: 'bg-expense',
  };
  return <span aria-hidden="true" className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', shape[tone])} />;
}

export function SessionsCard({ sessions, pendingBySession, now, messages, onSend }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section className="card divide-y divide-slate-700 p-0" aria-labelledby="claude-sessions-title">
      <h2 id="claude-sessions-title" className="px-4 py-3 text-base font-bold text-slate-100">
        Sesiones
      </h2>
      {sessions.length === 0 ? (
        <p className="px-4 py-5 text-sm text-slate-400">
          Todavía no hay sesiones. Abre Claude Code en tu laptop y aparecerá aquí.
        </p>
      ) : (
        <ul className="divide-y divide-slate-700">
          {sessions.map((s) => {
            const line = describeSession(s, pendingBySession.get(s.id), now);
            const open = openId === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : s.id)}
                  className="flex min-h-[60px] w-full items-center gap-3 px-4 py-3 text-left active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                >
                  <StateDot tone={line.tone} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-semibold text-slate-100">{s.project || 'Sesión de Claude Code'}</span>
                    <span className={cn('block text-[13px]', line.tone === 'error' ? 'text-expense' : 'text-slate-400')}>{line.text}</span>
                  </span>
                  <ChevronDown
                    size={18}
                    strokeWidth={1.7}
                    aria-hidden="true"
                    className={cn('flex-shrink-0 text-slate-400 transition-transform motion-reduce:transition-none', open && 'rotate-180')}
                  />
                </button>
                {open && <SessionDetail session={s} messages={messages.filter((m) => m.session_id === s.id)} now={now} onSend={onSend} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SessionDetail({ session, messages, now, onSend }: { session: SessionView; messages: MessageView[]; now: number; onSend: Props['onSend'] }) {
  const [events, setEvents] = useState<EventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    claudeApi
      .sessionEvents(session.id, controller.signal)
      .then((r) => setEvents(r.events))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof ApiError ? e.message : 'No se pudo cargar el detalle.');
      });
    return () => controller.abort();
  }, [session.id]);

  return (
    <div className="space-y-3 bg-slate-950/40 px-4 pb-4 pt-1">
      {session.cwd && <p className="break-all font-mono text-[13px] text-slate-400">{session.cwd}</p>}
      {session.summary && <p className="text-sm text-slate-200">{session.summary}</p>}
      {error ? (
        <p role="alert" className="text-sm text-expense">{error}</p>
      ) : events === null ? (
        <p className="text-sm text-slate-400">Cargando…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-slate-400">Sin eventos.</p>
      ) : (
        <ol className="space-y-2">
          {events.slice(0, 10).map((e) => (
            <li key={e.id} className="flex gap-3 text-sm">
              <time dateTime={e.created_at} className="w-11 flex-shrink-0 pt-px text-[13px] tabular-nums text-slate-400">
                {limaClock(e.created_at)}
              </time>
              <p className="min-w-0 flex-1 text-slate-200">
                <span className={cn('font-semibold', e.kind === 'stop_failure' ? 'text-expense' : 'text-slate-100')}>{eventWord(e.kind)}</span>
                {' · '}
                {e.summary}
              </p>
            </li>
          ))}
        </ol>
      )}
      <SessionMessageBox session={session} messages={messages} now={now} onSend={onSend} />
    </div>
  );
}
