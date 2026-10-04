import { useId, useState, type FormEvent } from 'react';
import { ChevronDown, Clock, ExternalLink, MapPin, Users, Video } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { googleCall, GoogleUiError, needsConnection } from '../google/googleApi';
import { durationLabel, shortHM } from '../google/lima';
import type { CalEvent } from '../google/types';
import { btnPrimary, btnSecondary, focusRing } from '../google/ui';
import { durationMinutes, eventMeta, guestSummary } from './agendaModel';

type Props = {
  event: CalEvent;
  open: boolean;
  onToggle: () => void;
  onMoved: (event: CalEvent) => void;
  onNeedsConnection: () => void;
};

/** Una fila de la línea de tiempo. Al tocarla se abre en el mismo lugar: detalle, Meet y mover. */
export function EventRow({ event, open, onToggle, onMoved, onNeedsConnection }: Props) {
  const panelId = useId();
  const [moving, setMoving] = useState(false);
  const declined = event.my_response === 'declined';
  const meta = eventMeta(event);

  return (
    <li className="border-t border-slate-700 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (open) setMoving(false);
          onToggle();
        }}
        className={cn('grid w-full grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg py-3 text-left', focusRing)}
      >
        <span className="pt-0.5 text-sm font-bold leading-tight tabular-nums text-slate-200">
          {event.all_day ? <>Todo<br />el día</> : shortHM(event.start_hm)}
        </span>
        <span className="min-w-0">
          <span className={cn('block text-base font-semibold', open ? 'break-words' : 'truncate', declined ? 'text-slate-400 line-through' : 'text-slate-100')}>
            {event.title}
          </span>
          {meta && <span className={cn('mt-0.5 block text-sm text-slate-400', !open && 'truncate')}>{meta}</span>}
        </span>
        <ChevronDown size={18} strokeWidth={1.8} aria-hidden="true" className={cn('mt-1 flex-none text-slate-400', open && 'rotate-180')} />
      </button>

      {open && (
        <div id={panelId} className="space-y-3 pb-4 pl-[4.25rem]">
          <dl className="space-y-2 text-base text-slate-200">
            {!event.all_day && (
              <div className="flex items-start gap-2.5">
                <dt className="sr-only">Horario</dt>
                <Clock size={18} strokeWidth={1.7} aria-hidden="true" className="mt-0.5 flex-none text-slate-400" />
                <dd className="tabular-nums">
                  {shortHM(event.start_hm)} – {shortHM(event.end_hm)} <span className="text-slate-400">· {durationLabel(durationMinutes(event))}</span>
                </dd>
              </div>
            )}
            {event.location && (
              <div className="flex items-start gap-2.5">
                <dt className="sr-only">Lugar</dt>
                <MapPin size={18} strokeWidth={1.7} aria-hidden="true" className="mt-0.5 flex-none text-slate-400" />
                <dd className="min-w-0 break-words">{event.location}</dd>
              </div>
            )}
            {event.guests > 0 && (
              <div className="flex items-start gap-2.5">
                <dt className="sr-only">Invitados</dt>
                <Users size={18} strokeWidth={1.7} aria-hidden="true" className="mt-0.5 flex-none text-slate-400" />
                <dd className="min-w-0 break-words">{guestSummary(event)}</dd>
              </div>
            )}
          </dl>

          {!moving && (
            <div className="flex flex-wrap gap-2">
              {event.meet_url && (
                <a href={event.meet_url} target="_blank" rel="noopener noreferrer" className={btnPrimary}>
                  <Video size={18} strokeWidth={1.8} aria-hidden="true" /> Unirse a Meet
                </a>
              )}
              {!event.all_day && (
                <button type="button" onClick={() => setMoving(true)} className={btnSecondary}>
                  Mover
                </button>
              )}
              {event.link && (
                <a href={event.link} target="_blank" rel="noopener noreferrer" className={btnSecondary}>
                  Calendar <ExternalLink size={16} strokeWidth={1.8} aria-hidden="true" />
                  <span className="sr-only">(se abre en otra pestaña)</span>
                </a>
              )}
            </div>
          )}

          {moving && (
            <MoveForm
              event={event}
              onCancel={() => setMoving(false)}
              onDone={(moved) => {
                setMoving(false);
                onMoved(moved);
              }}
              onNeedsConnection={onNeedsConnection}
            />
          )}
        </div>
      )}
    </li>
  );
}

function MoveForm({ event, onCancel, onDone, onNeedsConnection }: {
  event: CalEvent;
  onCancel: () => void;
  onDone: (event: CalEvent) => void;
  onNeedsConnection: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const [date, setDate] = useState(event.day_key);
  const [time, setTime] = useState(event.start_hm);
  const [confirmGuests, setConfirmGuests] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasGuests = event.guests > 0;
  const unchanged = date === event.day_key && time === event.start_hm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !date || !time) return;
    setBusy(true);
    setError(null);
    try {
      const { event: moved } = await googleCall<{ event: CalEvent }>('event.move', {
        event_id: event.id,
        date,
        start_time: time,
        confirm_guests: hasGuests && confirmGuests,
      });
      addToast(hasGuests ? 'Evento movido. No se avisó a los invitados.' : 'Evento movido.', 'success');
      onDone(moved);
    } catch (err) {
      if (needsConnection(err)) onNeedsConnection();
      setError(err instanceof GoogleUiError ? err.message : 'No pude mover el evento. Intenta de nuevo.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`Mover «${event.title}»`}>
      <div className="grid grid-cols-[3fr_2fr] gap-2">
        <label className="space-y-1 text-sm text-slate-400">
          <span>Día</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="input min-h-[48px]" />
        </label>
        <label className="space-y-1 text-sm text-slate-400">
          <span>Hora</span>
          <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} className="input min-h-[48px]" />
        </label>
      </div>
      <p className="text-sm text-slate-400">Mantiene la duración ({durationLabel(durationMinutes(event))}). Es solo tu calendario: no se manda ningún aviso.</p>

      {hasGuests && (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-700 p-3">
          <input type="checkbox" checked={confirmGuests} onChange={(e) => setConfirmGuests(e.target.checked)} className="mt-0.5 h-5 w-5 flex-none accent-primary-600" />
          <span className="text-base text-slate-200">
            Tiene {event.guests} {event.guests === 1 ? 'invitado' : 'invitados'}. Se moverá también en su calendario y no se les avisa.
          </span>
        </label>
      )}

      {error && <p role="alert" className="text-sm text-expense">{error}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={cn(btnSecondary, 'flex-1')}>
          Cancelar
        </button>
        <button type="submit" disabled={busy || unchanged || (hasGuests && !confirmGuests)} className={cn(btnPrimary, 'flex-1')}>
          {busy ? 'Moviendo…' : 'Mover evento'}
        </button>
      </div>
    </form>
  );
}
