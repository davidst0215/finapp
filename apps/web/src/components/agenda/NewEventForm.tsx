import { useRef, useState, type FormEvent } from 'react';
import { cn } from '@/lib/utils';
import { googleCall, GoogleUiError, needsConnection } from '../google/googleApi';
import { durationLabel } from '../google/lima';
import type { CalEvent } from '../google/types';
import { btnPrimary, btnSecondary, focusRing } from '../google/ui';

const DURATIONS = [30, 60, 90, 120] as const;

type Props = {
  initialDate: string;
  initialStart: string;
  onCreated: (event: CalEvent, overlaps: string[]) => void;
  onCancel: () => void;
  onNeedsConnection: () => void;
};

/** Formulario en línea para un evento nuevo. El evento queda solo en tu calendario: sin invitados ni avisos. */
export function NewEventForm({ initialDate, initialStart, onCreated, onCancel, onNeedsConnection }: Props) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(initialDate);
  const [start, setStart] = useState(initialStart);
  const [duration, setDuration] = useState<number>(60);
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un id por formulario abierto: si el toque se repite o la red reintenta, Calendar no crea un duplicado.
  const requestId = useRef(crypto.randomUUID());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { event, overlaps } = await googleCall<{ event: CalEvent; overlaps: string[] }>('event.create', {
        title: title.trim(),
        date,
        start_time: start,
        duration_min: duration,
        location: location.trim(),
        request_id: requestId.current,
      });
      onCreated(event, overlaps);
    } catch (err) {
      if (needsConnection(err)) onNeedsConnection();
      setError(err instanceof GoogleUiError ? err.message : 'No pude crear el evento. Intenta de nuevo.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-4" aria-labelledby="nuevo-evento">
      <h2 id="nuevo-evento" className="text-lg font-bold text-slate-100">Nuevo evento</h2>

      <label className="block space-y-1.5">
        <span className="text-sm text-slate-400">Título</span>
        <input
          autoFocus
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Reunión con Daniel"
          className="input min-h-[48px]"
        />
      </label>

      <div className="grid grid-cols-[3fr_2fr] gap-2">
        <label className="space-y-1.5">
          <span className="text-sm text-slate-400">Día</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="input min-h-[48px]" />
        </label>
        <label className="space-y-1.5">
          <span className="text-sm text-slate-400">Inicio</span>
          <input type="time" required value={start} onChange={(e) => setStart(e.target.value)} className="input min-h-[48px]" />
        </label>
      </div>

      <div className="space-y-1.5">
        <span id="duracion" className="text-sm text-slate-400">Duración</span>
        <div role="radiogroup" aria-labelledby="duracion" className="flex flex-wrap gap-2">
          {DURATIONS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={duration === m}
              onClick={() => setDuration(m)}
              className={cn(
                'inline-flex h-11 items-center rounded-full border px-4 text-sm font-semibold transition-colors',
                focusRing,
                duration === m ? 'border-slate-100 bg-slate-100 text-slate-950' : 'border-slate-700 bg-slate-800 text-slate-200 active:bg-slate-700',
              )}
            >
              {durationLabel(m)}
            </button>
          ))}
        </div>
      </div>

      <label className="block space-y-1.5">
        <span className="text-sm text-slate-400">Lugar (opcional)</span>
        <input maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} className="input min-h-[48px]" />
      </label>

      <p className="text-sm text-slate-400">Queda solo en tu calendario: no se invita a nadie ni se manda ningún aviso.</p>

      {error && <p role="alert" className="text-sm text-expense">{error}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={cn(btnSecondary, 'flex-1')}>
          Cancelar
        </button>
        <button type="submit" disabled={busy || !title.trim()} className={cn(btnPrimary, 'flex-1')}>
          {busy ? 'Creando…' : 'Crear evento'}
        </button>
      </div>
    </form>
  );
}
