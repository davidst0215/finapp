import { useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isTaskActive, taskDuration, taskStatusLabel } from './format';
import type { DeviceView, TaskView } from './types';

const MAX = 4000;

interface Props {
  devices: DeviceView[];
  tasks: TaskView[];
  now: number;
  onCreate: (project: string, prompt: string) => Promise<boolean>;
  onCancel: (taskId: string) => void;
}

// "Nueva tarea": lanza `claude -p` en la laptop dentro de un proyecto de su lista local. La app solo ve nombres.
export function NewTaskCard({ devices, tasks, now, onCreate, onCancel }: Props) {
  const online = useMemo(() => [...new Set(devices.filter((d) => d.runner.online).flatMap((d) => d.runner.projects))].sort(), [devices]);
  const everReported = devices.some((d) => d.runner.projects.length > 0);
  const [project, setProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const chosen = online.includes(project) ? project : (online[0] ?? '');
  const trimmed = prompt.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || !trimmed || !chosen) return;
    setSending(true);
    try {
      if (await onCreate(chosen, trimmed)) setPrompt('');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="card space-y-4" aria-labelledby="claude-newtask-title">
      <div className="space-y-1">
        <h2 id="claude-newtask-title" className="text-base font-bold text-slate-100">
          Nueva tarea
        </h2>
        <p className="text-sm text-slate-300">
          Claude Code trabaja en tu laptop dentro del proyecto que elijas. Lo que pida permiso te llega aquí si «Aprobar desde el celular»
          está activo; si no, se deniega.
        </p>
      </div>

      {online.length === 0 ? (
        <p role="status" className="rounded-xl border border-slate-700 bg-slate-800 p-3 text-sm text-slate-300">
          {everReported
            ? 'El runner de tu laptop no da señal. Revisa que la laptop esté encendida y el runner corriendo.'
            : 'Aún no hay runner. En la laptop: node tools/claude-hooks/wabid-runner.mjs add <nombre> <ruta> y luego node tools/claude-hooks/instalar-runner.mjs.'}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="claude-task-project" className="text-sm font-bold text-slate-100">
              Proyecto
            </label>
            <select id="claude-task-project" className="input min-h-[48px]" value={chosen} onChange={(e) => setProject(e.target.value)}>
              {online.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="claude-task-prompt" className="text-sm font-bold text-slate-100">
              Qué debe hacer
            </label>
            <textarea
              id="claude-task-prompt"
              className="input min-h-[120px] resize-y text-base"
              value={prompt}
              maxLength={MAX}
              rows={4}
              placeholder="Describe la tarea con el contexto que necesita"
              onChange={(e) => setPrompt(e.target.value)}
            />
            <p className="text-right text-[13px] tabular-nums text-slate-400">
              {prompt.length}/{MAX}
            </p>
          </div>
          <button type="submit" disabled={sending || !trimmed} className="btn-primary flex min-h-[48px] w-full items-center justify-center gap-2">
            <Play size={16} strokeWidth={2} aria-hidden="true" />
            {sending ? 'Enviando…' : 'Lanzar tarea'}
          </button>
        </form>
      )}

      {tasks.length > 0 && (
        <ul className="divide-y divide-slate-700 border-t border-slate-700" aria-label="Tareas">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} now={now} onCancel={onCancel} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskRow({ task, now, onCancel }: { task: TaskView; now: number; onCancel: (id: string) => void }) {
  const active = isTaskActive(task.status);
  const bad = task.status === 'fallida' || task.status === 'rechazada';
  const duration = taskDuration(task, now);
  const detail = task.status === 'terminada' ? task.result : bad ? task.error || task.result : task.status === 'ejecutando' ? task.progress : null;

  return (
    <li className="space-y-1.5 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-slate-100">{task.project}</p>
          <p className={cn('text-[13px]', bad ? 'text-expense' : 'text-slate-400')}>
            {task.cancel_requested && active ? 'Cancelando…' : taskStatusLabel(task.status)}
            {duration && ` · ${duration}`}
          </p>
        </div>
        {active && !task.cancel_requested && (
          <button
            type="button"
            onClick={() => onCancel(task.id)}
            aria-label={`Cancelar la tarea de ${task.project}`}
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-slate-300 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <X size={18} strokeWidth={1.7} aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="line-clamp-2 text-sm text-slate-300">{task.prompt}</p>
      {detail && (
        <p className={cn('max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-700 bg-slate-800 p-3 text-sm', bad ? 'text-expense' : 'text-slate-100')}>
          {detail}
        </p>
      )}
    </li>
  );
}
