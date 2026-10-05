import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Composer } from './Composer';
import { ScreenShell } from './ScreenShell';
import type { ClaudeOverviewApi } from './useClaudeOverview';

const MAX_PROMPT = 4000;

// Nueva tarea = nuevo chat: eliges el proyecto de la lista que reporta tu laptop, escribes y envías. Claude trabaja en la
// laptop y la conversación aparece en la lista en cuanto empieza.
export function NewTaskScreen({ api }: { api: ClaudeOverviewApi }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const devices = api.overview?.devices ?? [];
  const online = useMemo(() => [...new Set(devices.filter((d) => d.runner.online).flatMap((d) => d.runner.projects))].sort(), [devices]);
  const everReported = devices.some((d) => d.runner.projects.length > 0);
  const asked = params.get('proyecto') ?? '';
  const [picked, setPicked] = useState(asked);
  const project = online.includes(picked) ? picked : online.includes(asked) ? asked : (online[0] ?? '');
  const back = () => (window.history.state && window.history.state.idx > 0 ? navigate(-1) : navigate('/claude', { replace: true }));

  const onSend = async (text: string): Promise<string | null> => {
    if (!project) return 'Elige un proyecto.';
    const res = await api.createTask(project, text);
    if ('error' in res) return res.error;
    navigate(`/claude/t/${encodeURIComponent(res.task.id)}`, { replace: true });
    return null;
  };

  const ready = online.length > 0;

  return (
    <ScreenShell
      title="Nueva tarea"
      subtitle="Claude trabaja en tu laptop"
      onBack={back}
      backLabel="Cancelar y volver"
      footer={
        <Composer
          label="Qué debe hacer Claude"
          placeholder={ready ? 'Cuéntale qué quieres que haga…' : ''}
          maxLength={MAX_PROMPT}
          onSend={onSend}
          autoFocus={ready}
          disabledReason={
            ready ? null : api.loading && !api.overview ? (
              'Buscando tu laptop…'
            ) : devices.length === 0 ? (
              <>
                Primero conecta tu laptop.{' '}
                <Link to="/claude/ajustes" className="font-semibold text-slate-100 underline underline-offset-2">
                  Conectar
                </Link>
              </>
            ) : (
              'Tu laptop no da señal. Revisa que esté encendida y con el lanzador de tareas corriendo.'
            )
          }
        />
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-5">
        {ready ? (
          <fieldset className="space-y-3">
            <legend className="text-base font-bold text-slate-100">¿En qué proyecto?</legend>
            <div role="radiogroup" aria-label="Proyecto" className="flex flex-wrap gap-2">
              {online.map((p) => {
                const on = p === project;
                return (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPicked(p)}
                    className={cn(
                      'flex min-h-[44px] items-center gap-2 rounded-full border px-4 text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                      on ? 'border-primary-600 bg-primary-600 text-slate-950' : 'border-slate-600 bg-slate-900 text-slate-200 active:bg-slate-800',
                    )}
                  >
                    <Folder size={16} strokeWidth={1.9} aria-hidden="true" />
                    {p}
                  </button>
                );
              })}
            </div>
            <p className="pt-2 text-[15px] leading-relaxed text-slate-300">
              Claude abre «{project}» en tu laptop y trabaja ahí. Lo que pida permiso te llega al chat si el modo ausente está activo; si no, se rechaza.
            </p>
          </fieldset>
        ) : api.loading && !api.overview ? null : (
          <div className="space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-4">
            <h2 className="text-base font-bold text-slate-100">{everReported ? 'Tu laptop no da señal' : 'Aún no hay proyectos para lanzar tareas'}</h2>
            {everReported ? (
              <p className="text-sm text-slate-300">Revisa que la laptop esté encendida y que el lanzador de tareas esté corriendo. Cuando vuelva, tus proyectos aparecen aquí.</p>
            ) : (
              <>
                <p className="text-sm text-slate-300">Primero eliges en tu laptop qué carpetas puede abrir Claude. Una sola vez:</p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-slate-700 bg-slate-800 p-3 font-mono text-[13px] leading-relaxed text-slate-100">
                  {'node tools/claude-hooks/wabid-runner.mjs add <nombre> <ruta>\nnode tools/claude-hooks/instalar-runner.mjs'}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    </ScreenShell>
  );
}
