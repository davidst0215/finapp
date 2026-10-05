import { useMemo } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { ChatScreen } from './ChatScreen';
import { buildRows, taskTimeline } from './chatModel';
import { Composer } from './Composer';
import { sessionStatus, taskConversationStatus } from './conversations';
import { isTaskActive, timeAgo } from './format';
import type { ClaudeOverviewApi } from './useClaudeOverview';
import type { Decision } from './types';
import { useNow } from './useTick';
import { useTimeline } from './useTimeline';

const MAX_MESSAGE = 2000;
// Una laptop sin señal por tanto tiempo probablemente está apagada o dormida: el mensaje espera hasta que vuelva.
const LAPTOP_QUIET_MS = 10 * 60_000;

// Atrás: si se llegó desde la lista, vuelve ahí (la pila del navegador); si se abrió el enlace directo, va a la lista.
function useBack() {
  const navigate = useNavigate();
  return () => (window.history.state && window.history.state.idx > 0 ? navigate(-1) : navigate('/claude', { replace: true }));
}

function Missing({ what }: { what: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-8 py-20 text-center">
      <h2 className="text-base font-bold text-slate-100">Esta {what} ya no está</h2>
      <p className="text-sm text-slate-300">Se borró por antigüedad o ya no pertenece a una laptop conectada.</p>
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center gap-2 px-8 py-20 text-center">
      <h2 className="text-base font-bold text-slate-100">Todavía no hay mensajes</h2>
      <p className="text-sm text-slate-300">Cuando escribas en la laptop o Claude responda, lo verás aquí.</p>
    </div>
  );
}

// --- Una sesión de Claude Code ---------------------------------------------------------------------------------------------

export function SessionChat({ sessionId, api }: { sessionId: string; api: ClaudeOverviewApi }) {
  const back = useBack();
  const now = useNow(30_000);
  const { overview, loading: overviewLoading } = api;
  const timeline = useTimeline(sessionId);

  const session = overview?.sessions.find((s) => s.id === sessionId);
  const device = overview?.devices.find((d) => d.id === session?.device_id);
  const pending = overview?.pending.filter((a) => a.session_id === sessionId).length ?? 0;
  const status = session ? sessionStatus(session, pending, now) : { tone: 'done' as const, label: '' };
  const rows = useMemo(() => buildRows(timeline.items, now), [timeline.items, now]);

  const onDecide = async (approvalId: string, decision: Decision) => {
    const ok = await api.decide(approvalId, decision);
    await timeline.refresh();
    return ok;
  };

  const onSend = async (text: string): Promise<string | null> => {
    const res = await api.sendMessage(sessionId, text);
    if ('error' in res) return res.error;
    timeline.addLocal({ id: `m:${res.message.id}`, at: res.message.created_at, type: 'user', source: 'phone', text, delivery: res.message.status });
    void timeline.refresh();
    return null;
  };

  const ended = session?.status === 'terminada' || session?.ended_at != null;
  const quiet = device?.last_seen_at ? now - Date.parse(device.last_seen_at) > LAPTOP_QUIET_MS : false;

  let disabledReason: React.ReactNode = null;
  let hint: React.ReactNode = null;
  if (overview && !session) {
    // La sesión se podó (o nunca fue de esta cuenta): no hay a quién escribirle.
    disabledReason = (
      <>
        Esta conversación ya no existe, así que no se le puede escribir.{' '}
        <Link to="/claude" replace className="font-semibold text-slate-100 underline underline-offset-2">
          Volver a las conversaciones
        </Link>
      </>
    );
  } else if (session && ended) {
    disabledReason = (
      <>
        Esta conversación terminó. Para seguir con el proyecto, lanza una tarea nueva.{' '}
        <Link to={`/claude/nueva?proyecto=${encodeURIComponent(session.project)}`} className="font-semibold text-slate-100 underline underline-offset-2">
          Nueva tarea en {session.project}
        </Link>
      </>
    );
  } else if (overview && session && !device) {
    disabledReason = (
      <>
        La laptop de esta conversación ya no está conectada.{' '}
        <Link to="/claude/ajustes" className="font-semibold text-slate-100 underline underline-offset-2">
          Revisar en ajustes
        </Link>
      </>
    );
  } else if (session && device) {
    if (quiet && device.last_seen_at) {
      hint = `Tu laptop no da señal ${timeAgo(device.last_seen_at, now).replace('hace', 'desde hace')}. El mensaje se entrega cuando vuelva.`;
    } else if (session.status === 'esperando' && !device.approvals_enabled) {
      hint = (
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1">Claude ya terminó su turno. Para que reciba mensajes desde aquí, activa el modo ausente.</span>
          <button
            type="button"
            onClick={() => void api.setApprovals(device.id, true)}
            className="min-h-[44px] flex-shrink-0 rounded-xl border border-slate-600 px-3 text-[14px] font-semibold text-slate-100 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            Activar
          </button>
        </span>
      );
    } else if (session.status === 'trabajando') {
      hint = 'Claude lo lee cuando termine su turno.';
    }
  }

  return (
    <ChatScreen
      title={session?.project || (overviewLoading ? 'Conversación' : 'Sesión de Claude Code')}
      subtitle={session ? `${status.label}${device ? ` · ${device.name}` : ''}` : 'Cargando…'}
      tone={status.tone}
      onBack={back}
      rows={rows}
      fetchedAt={timeline.fetchedAt}
      onDecide={onDecide}
      loading={timeline.loading}
      error={timeline.error}
      onRetry={() => void timeline.refresh()}
      hasMore={timeline.hasMore}
      onLoadOlder={timeline.loadOlder}
      working={status.tone === 'active'}
      empty={overview && !session ? <Missing what="conversación" /> : <EmptyChat />}
      footer={<Composer maxLength={MAX_MESSAGE} onSend={onSend} disabledReason={disabledReason} hint={hint} />}
    />
  );
}

// --- Una tarea lanzada desde el celular que todavía no abrió sesión -----------------------------------------------------------

export function TaskChat({ taskId, api }: { taskId: string; api: ClaudeOverviewApi }) {
  const back = useBack();
  const now = useNow(30_000);
  const { overview, fetchedAt } = api;
  const task = overview?.tasks.find((t) => t.id === taskId);
  const items = useMemo(() => (task ? taskTimeline(task) : []), [task]);
  const rows = useMemo(() => buildRows(items, now), [items, now]);

  // Cuando la tarea abre su sesión, la conversación es esa sesión (con todo el chat).
  if (task?.session_id && overview?.sessions.some((s) => s.id === task.session_id)) {
    return <Navigate to={`/claude/s/${encodeURIComponent(task.session_id)}`} replace />;
  }

  const status = task ? taskConversationStatus(task) : { tone: 'done' as const, label: '' };
  const active = task ? isTaskActive(task.status) && !task.cancel_requested : false;
  const device = overview?.devices.find((d) => d.runner.projects.includes(task?.project ?? ''));
  const started = task?.status === 'ejecutando';

  return (
    <ChatScreen
      title={task?.project ?? 'Tarea'}
      subtitle={task ? `${status.label}${device ? ` · ${device.name}` : ''}` : 'Cargando…'}
      tone={status.tone}
      onBack={back}
      headerRight={
        active && task ? (
          <button
            type="button"
            onClick={() => void api.cancelTask(task.id)}
            aria-label={`Cancelar la tarea de ${task.project}`}
            className="flex h-11 flex-shrink-0 items-center gap-1.5 rounded-full px-3 text-[14px] font-semibold text-slate-200 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <X size={18} strokeWidth={1.9} aria-hidden="true" />
            Cancelar
          </button>
        ) : null
      }
      rows={rows}
      fetchedAt={api.fetchedAt || fetchedAt}
      onDecide={async () => false}
      loading={api.loading}
      error={api.error}
      onRetry={() => void api.refresh()}
      working={started}
      empty={overview && !task ? <Missing what="tarea" /> : <EmptyChat />}
      footer={
        <Composer
          maxLength={MAX_MESSAGE}
          onSend={async () => null}
          disabledReason={
            task && !isTaskActive(task.status) ? (
              <>
                Esta tarea no llegó a abrir una conversación.{' '}
                <Link to={`/claude/nueva?proyecto=${encodeURIComponent(task.project)}`} className="font-semibold text-slate-100 underline underline-offset-2">
                  Lanzarla de nuevo
                </Link>
              </>
            ) : (
              'Cuando Claude empiece la tarea podrás escribirle aquí.'
            )
          }
        />
      }
    />
  );
}
