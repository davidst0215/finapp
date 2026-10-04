import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { DayChips } from '@/components/agenda/DayChips';
import { NewEventForm } from '@/components/agenda/NewEventForm';
import { Timeline } from '@/components/agenda/Timeline';
import { defaultStart, timelineRows } from '@/components/agenda/agendaModel';
import { ConnectGoogle } from '@/components/google/ConnectGoogle';
import { ErrorCard, RowsSkeleton } from '@/components/google/Feedback';
import { GoogleAccountFooter } from '@/components/google/GoogleAccountFooter';
import { googleCall, GoogleUiError, motivoMessage, needsConnection } from '@/components/google/googleApi';
import { addDays, dayHeading, dayKeys, limaDateKey, limaHM } from '@/components/google/lima';
import type { CalEvent } from '@/components/google/types';
import { iconButtonPrimary } from '@/components/google/ui';
import { useGoogleStatus } from '@/components/google/useGoogleStatus';

const WINDOW_DAYS = 9; // ayer, hoy y una semana por delante: un solo pedido y el cambio de día es instantáneo
const STALE_MS = 2 * 60_000;

export function AgendaPage() {
  const addToast = useToastStore((s) => s.addToast);
  const [params, setParams] = useSearchParams();
  const { loading, status, error: statusError, reload: reloadStatus } = useGoogleStatus();

  const [today, setToday] = useState(() => limaDateKey());
  const [nowHM, setNowHM] = useState(() => limaHM());
  const [selected, setSelected] = useState(today);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Al volver de la pantalla de consentimiento de Google (?google=conectado | error&motivo=…).
  const returned = useRef(false);
  useEffect(() => {
    const result = params.get('google');
    if (!result || returned.current) return;
    returned.current = true;
    if (result === 'conectado') addToast('Google conectado.', 'success');
    else setNotice(motivoMessage(params.get('motivo')));
    setParams({}, { replace: true });
  }, [params, setParams, addToast]);

  // El reloj de Lima: mueve la marca "ahora" y cambia el día a medianoche.
  const loadedAt = useRef(0);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const tick = () => {
      setToday(limaDateKey());
      setNowHM(limaHM());
    };
    const timer = setInterval(tick, 30_000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      tick();
      if (Date.now() - loadedAt.current > STALE_MS) refresh.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const connected = status?.connected === true;
  const canCalendar = connected && status?.account?.capabilities.calendar === true;
  const from = addDays(today, -1);
  const days = useMemo(() => dayKeys(from, WINDOW_DAYS), [from]);

  const latest = useRef(0);
  const load = useCallback(async () => {
    const id = ++latest.current;
    try {
      const res = await googleCall<{ events: CalEvent[] }>('events', { from, days: WINDOW_DAYS });
      if (id !== latest.current) return; // llegó una respuesta más nueva
      loadedAt.current = Date.now();
      setEvents(res.events);
      setLoadError(null);
    } catch (e) {
      if (id !== latest.current) return;
      if (needsConnection(e)) {
        void reloadStatus();
        return;
      }
      setLoadError(e instanceof GoogleUiError ? e.message : 'No pude cargar tu agenda.');
    }
  }, [from, reloadStatus]);

  useEffect(() => {
    refresh.current = () => void load();
  }, [load]);

  useEffect(() => {
    if (canCalendar) void load();
  }, [canCalendar, load]);

  const rows = useMemo(() => (events ? timelineRows(events, selected, today, nowHM) : []), [events, selected, today, nowHM]);

  const onCreated = (event: CalEvent, overlaps: string[]) => {
    setCreating(false);
    if (days.includes(event.day_key)) setSelected(event.day_key);
    const where = days.includes(event.day_key) ? '' : ` para el ${dayHeading(event.day_key, today).toLowerCase()}`;
    addToast(
      overlaps.length ? `Evento creado${where}. Ojo: se cruza con «${overlaps[0]}».` : `Evento creado${where}.`,
      overlaps.length ? 'warning' : 'success',
    );
    void load();
  };

  const onMoved = (event: CalEvent) => {
    setOpenId(null);
    if (days.includes(event.day_key)) setSelected(event.day_key);
    void load();
  };

  const toggleCreate = () => {
    setOpenId(null);
    setCreating((v) => !v);
  };

  let body: React.ReactNode;
  if (loading) {
    body = <RowsSkeleton rows={4} label="Cargando tu agenda" />;
  } else if (statusError) {
    body = <ErrorCard message={statusError} onRetry={() => void reloadStatus()} />;
  } else if (!connected) {
    body = <ConnectGoogle variant={status?.reauth ? 'reauth' : 'connect'} email={status?.account?.email} notice={notice} />;
  } else if (!canCalendar) {
    body = <ConnectGoogle variant="permission" need="agenda" />;
  } else {
    body = (
      <>
        <DayChips days={days} selected={selected} today={today} onSelect={(key) => { setSelected(key); setOpenId(null); }} />

        {creating && (
          <NewEventForm
            initialDate={selected}
            initialStart={defaultStart(selected, today, nowHM)}
            onCreated={onCreated}
            onCancel={() => setCreating(false)}
            onNeedsConnection={() => void reloadStatus()}
          />
        )}

        {loadError ? (
          <ErrorCard message={loadError} onRetry={() => void load()} />
        ) : events === null ? (
          <RowsSkeleton rows={4} label="Cargando eventos" />
        ) : rows.length === 0 ? (
          <div className="card space-y-2 py-8 text-center">
            <p className="text-lg font-bold text-slate-100">Sin eventos este día</p>
            <p className="mx-auto max-w-[32ch] text-base text-slate-400">
              Dile a Wabid «agéndame una reunión mañana a las 4» o toca + para crearla tú.
            </p>
          </div>
        ) : (
          <Timeline
            rows={rows}
            openId={openId}
            onToggle={(id) => setOpenId((cur) => (cur === id ? null : id))}
            onMoved={onMoved}
            onNeedsConnection={() => void reloadStatus()}
          />
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex min-h-[44px] items-center justify-between gap-3">
        <h1 className="min-w-0 text-2xl font-bold text-slate-100">{canCalendar ? dayHeading(selected, today) : 'Agenda'}</h1>
        {canCalendar && (
          <button type="button" onClick={toggleCreate} aria-expanded={creating} aria-label={creating ? 'Cancelar evento nuevo' : 'Nuevo evento'} className={iconButtonPrimary}>
            <Plus size={20} strokeWidth={2} aria-hidden="true" className={cn(creating && 'rotate-45')} />
          </button>
        )}
      </header>

      {body}

      {connected && status?.account && (
        <GoogleAccountFooter
          email={status.account.email}
          onDisconnected={() => {
            setEvents(null);
            setCreating(false);
            void reloadStatus();
          }}
        />
      )}
    </div>
  );
}
