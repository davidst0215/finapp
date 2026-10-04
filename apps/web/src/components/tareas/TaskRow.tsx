import { useId, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { safeHttpsUrl } from './format';
import { PriorityBars } from './PriorityBars';
import { StatusControl } from './StatusControl';
import { TaskMeta } from './TaskMeta';
import type { VaultTask } from './types';

interface TaskRowProps {
  task: VaultTask;
  busy: boolean;
  onToggle: (task: VaultTask) => void;
  onMove: (task: VaultTask) => void;
}

/** Fila de una tarea dentro de su grupo. Tocar el control completa; tocar el resto expande en línea. */
export function TaskRow({ task, busy, onToggle, onMove }: TaskRowProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const done = task.status === 'completed';
  const link = safeHttpsUrl(task.link);

  return (
    <li>
      <div className="flex items-start">
        <StatusControl task={task} busy={busy} onToggle={() => onToggle(task)} />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg py-3 pl-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300"
        >
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block text-[15.5px] font-semibold leading-snug',
                !open && 'line-clamp-2',
                done && 'text-slate-500 line-through',
              )}
            >
              {task.text}
            </span>
            <TaskMeta task={task} withNote={!open} wrap={open} />
          </span>
          <PriorityBars priority={task.priority} className="mt-1" />
        </button>
      </div>

      {open && (
        <div id={panelId} className="space-y-3 pb-3 pl-[37px] pr-1">
          {task.note && (
            <p className="whitespace-pre-line text-[14px] leading-relaxed text-slate-200">{task.note}</p>
          )}
          {(task.subtasks || link) && (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px] text-slate-400">
              {task.subtasks && (
                <span>
                  {task.subtasks.done}/{task.subtasks.total} subtareas
                </span>
              )}
              {link && (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md font-semibold text-slate-200 underline decoration-slate-500 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                >
                  {task.source === 'fathom' ? 'Ver grabación' : 'Abrir enlace'}
                  <ExternalLink aria-hidden="true" size={15} />
                </a>
              )}
            </p>
          )}
          <button
            type="button"
            onClick={() => onMove(task)}
            disabled={busy}
            className="btn-secondary min-h-11 px-4 py-2 text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
          >
            Mover a…
          </button>
        </div>
      )}
    </li>
  );
}
