import { useId } from 'react';
import { TaskRow } from './TaskRow';
import type { TaskGroup, VaultTask } from './types';

interface TaskGroupCardProps {
  group: TaskGroup;
  /** Tareas con una acción en curso: su control queda inactivo hasta que responda el servidor. */
  busy: ReadonlySet<string>;
  onToggle: (task: VaultTask) => void;
  onMove: (task: VaultTask) => void;
}

/** Una tarjeta por grupo (proyecto › frente). El servidor ya ordenó las filas. */
export function TaskGroupCard({ group, busy, onToggle, onMove }: TaskGroupCardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="card pb-1.5 pt-3.5">
      <h2 id={titleId} className="text-[15px] font-bold text-slate-200">
        {group.label}
      </h2>
      <ul className="mt-0.5 divide-y divide-slate-700">
        {group.tasks.map((task) => (
          <TaskRow key={task.id} task={task} busy={busy.has(task.id)} onToggle={onToggle} onMove={onMove} />
        ))}
      </ul>
    </section>
  );
}
