import type { CalEvent } from '../google/types';
import { shortHM } from '../google/lima';
import type { TimelineRow } from './agendaModel';
import { EventRow } from './EventRow';

type Props = {
  rows: TimelineRow[];
  openId: string | null;
  onToggle: (id: string) => void;
  onMoved: (event: CalEvent) => void;
  onNeedsConnection: () => void;
};

/** La línea de tiempo del día en una sola superficie. La marca "ahora" separa lo que ya empezó de lo que falta. */
export function Timeline({ rows, openId, onToggle, onMoved, onNeedsConnection }: Props) {
  return (
    <ul className="card !py-1" aria-label="Eventos del día">
      {rows.map((row) =>
        row.kind === 'now' ? (
          <li key="now" aria-label={`Ahora, ${shortHM(row.hm)}`} className="flex items-center gap-2 py-1.5 text-sm font-bold text-slate-100">
            <span className="tabular-nums">{shortHM(row.hm)} ahora</span>
            <span aria-hidden="true" className="h-px flex-1 bg-slate-100" />
          </li>
        ) : (
          <EventRow
            key={row.event.id}
            event={row.event}
            open={openId === row.event.id}
            onToggle={() => onToggle(row.event.id)}
            onMoved={onMoved}
            onNeedsConnection={onNeedsConnection}
          />
        ),
      )}
    </ul>
  );
}
