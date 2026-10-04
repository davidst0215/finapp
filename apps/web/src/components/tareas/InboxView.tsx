import { InboxCard } from './InboxCard';
import type { VaultTask } from './types';

interface InboxViewProps {
  tasks: VaultTask[];
  busy: ReadonlySet<string>;
  onToggle: (task: VaultTask) => void;
  onAccept: (task: VaultTask) => void;
  onMove: (task: VaultTask) => void;
}

/** Cajón desastre: lo que entra solo (p. ej. de reuniones) y espera destino. */
export function InboxView({ tasks, busy, onToggle, onAccept, onMove }: InboxViewProps) {
  if (tasks.length === 0) {
    return (
      <div className="card text-center">
        <p className="text-[15.5px] font-semibold text-slate-200">Nada por triagear.</p>
        <p className="mx-auto mt-1 max-w-[32ch] text-[14px] leading-relaxed text-slate-400">
          Cada noche entra aquí lo que sale de tus reuniones de Fathom.
        </p>
      </div>
    );
  }

  const pending = tasks.filter((t) => t.status !== 'completed').length;

  return (
    <>
      <h2 className="text-[15px] font-bold text-slate-200">{pending} por triagear</h2>
      <ul className="space-y-3">
        {tasks.map((task) => (
          <InboxCard
            key={task.id}
            task={task}
            busy={busy.has(task.id)}
            onToggle={onToggle}
            onAccept={onAccept}
            onMove={onMove}
          />
        ))}
      </ul>
    </>
  );
}
