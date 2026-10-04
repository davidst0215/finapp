import { useState, type ReactNode } from 'react';
import { ArrowRight, ExternalLink, Video } from 'lucide-react';
import { cn } from '@/lib/utils';
import { safeHttpsUrl } from './format';
import { PriorityBars } from './PriorityBars';
import { StatusControl } from './StatusControl';
import { TaskMeta } from './TaskMeta';
import type { VaultTask } from './types';

interface InboxCardProps {
  task: VaultTask;
  busy: boolean;
  onToggle: (task: VaultTask) => void;
  /** Acepta el destino que propone la tarea (`#destino/…`). */
  onAccept: (task: VaultTask) => void;
  onMove: (task: VaultTask) => void;
}

/** Una tarea del cajón por triagear: se acepta la sugerencia, se elige otro destino o se completa. */
export function InboxCard({ task, busy, onToggle, onAccept, onMove }: InboxCardProps) {
  const [open, setOpen] = useState(false);
  const done = task.status === 'completed';
  const link = safeHttpsUrl(task.link);
  const hasSuggestion = Boolean(task.suggest && task.suggestLabel);
  const fromRecording = task.source === 'fathom';

  const body: ReactNode = (
    <>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-[15.5px] font-semibold leading-snug',
            !open && 'line-clamp-3',
            done && 'text-slate-500 line-through',
          )}
        >
          {task.text}
        </span>
        <TaskMeta task={task} wrap />
        {task.note && (
          <span className={cn('mt-1 block text-[14px] leading-snug text-slate-300', !open && 'line-clamp-2')}>
            {task.note}
          </span>
        )}
      </span>
      <PriorityBars priority={task.priority} className="mt-1" />
    </>
  );

  const bodyClass = 'flex min-w-0 flex-1 items-start gap-3 rounded-lg py-3 pl-1 text-left';

  return (
    <li className="card pb-3 pt-1">
      <div className="flex items-start">
        <StatusControl task={task} busy={busy} onToggle={() => onToggle(task)} />
        {task.note ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              bodyClass,
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300',
            )}
          >
            {body}
          </button>
        ) : (
          <div className={bodyClass}>{body}</div>
        )}
      </div>

      {/* Las píldoras se parten en dos líneas si hace falta; el icono de la grabación se queda arriba a la derecha. */}
      <div className="flex items-start justify-between gap-2 pl-[37px]">
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          {hasSuggestion && (
            <button
              type="button"
              onClick={() => onAccept(task)}
              disabled={busy || done}
              className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full bg-primary-600 px-3.5 text-[14px] font-bold text-slate-950 transition-colors active:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:opacity-50"
            >
              <ArrowRight aria-hidden="true" size={16} className="shrink-0" />
              <span className="truncate">{task.suggestLabel}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onMove(task)}
            disabled={busy || done}
            className="inline-flex min-h-11 items-center rounded-full border border-slate-600 bg-slate-800 px-3.5 text-[14px] font-semibold text-slate-200 transition-colors [@media(hover:hover)]:hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50"
          >
            {hasSuggestion ? 'Otro…' : 'Mover a…'}
          </button>
        </div>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={fromRecording ? 'Abrir grabación' : 'Abrir enlace'}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-300 transition-colors [@media(hover:hover)]:hover:bg-slate-800 [@media(hover:hover)]:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
          >
            {fromRecording ? <Video aria-hidden="true" size={19} /> : <ExternalLink aria-hidden="true" size={18} />}
          </a>
        )}
      </div>
    </li>
  );
}
