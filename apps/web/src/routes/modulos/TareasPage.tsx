import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { AddTaskSheet } from '@/components/tareas/AddTaskSheet';
import { ErrorNotice } from '@/components/tareas/ErrorNotice';
import { FilterChips, type ScopeFilter } from '@/components/tareas/FilterChips';
import { InboxView } from '@/components/tareas/InboxView';
import { MoveSheet } from '@/components/tareas/MoveSheet';
import { Notice } from '@/components/tareas/Notice';
import { PageHeader } from '@/components/tareas/PageHeader';
import { Segmented } from '@/components/tareas/Segmented';
import { SyncLine } from '@/components/tareas/SyncLine';
import { TaskGroupCard } from '@/components/tareas/TaskGroupCard';
import type { CreateTaskInput, Destination, VaultTask } from '@/components/tareas/types';
import { useNotice } from '@/components/tareas/useNotice';
import { useNow } from '@/components/tareas/useNow';
import { useTasks } from '@/components/tareas/useTasks';

type View = 'lista' | 'cajon';

const ID_BASE = 'tareas';
/** Referencia estable mientras no hay datos: evita invalidar los memos de la hoja "Mover a…" en cada render. */
const NO_DESTINATIONS: readonly Destination[] = [];

/** Tareas del vault (Norte): lista por grupos, cajón por triagear, y captura rápida. */
export function TareasPage() {
  const { data, fetching, error, busy, reload, syncNow, complete, restore, move, create } = useTasks();
  const { notice, show, dismiss, pause, resume } = useNotice();
  const now = useNow();

  const [view, setView] = useState<View>('lista');
  const [scopes, setScopes] = useState<ScopeFilter>({ trabajo: true, personal: true });
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<VaultTask | null>(null);

  // Si el servidor ya no reporta vencidas, el filtro "solo vencidas" no tiene sentido y se apaga solo.
  // Se ajusta durante el render (no en un efecto) para no pintar ni un cuadro con el filtro viejo.
  if (overdueOnly && data && data.counts.overdue === 0) setOverdueOnly(false);

  // Lo completado queda tachado en su sitio hasta la siguiente carga: los contadores lo descuentan al instante.
  const counts = useMemo(() => {
    if (!data) return { overdue: 0, inbox: 0 };
    let overdueDone = 0;
    for (const group of data.groups) {
      for (const task of group.tasks) if (task.overdue && task.status === 'completed') overdueDone += 1;
    }
    const inboxDone = data.inbox.filter((t) => t.status === 'completed').length;
    return {
      overdue: Math.max(0, data.counts.overdue - overdueDone),
      inbox: Math.max(0, data.counts.inbox - inboxDone),
    };
  }, [data]);

  // El filtrado es del cliente sobre los grupos que ya llegaron; no se pide nada.
  const visibleGroups = useMemo(() => {
    if (!data) return [];
    return data.groups
      .filter((group) => scopes[group.scope])
      .map((group) => (overdueOnly ? { ...group, tasks: group.tasks.filter((t) => t.overdue) } : group))
      .filter((group) => group.tasks.length > 0);
  }, [data, scopes, overdueOnly]);

  const toggleScope = (scope: keyof ScopeFilter) => {
    setScopes((current) => {
      const other = scope === 'trabajo' ? 'personal' : 'trabajo';
      if (current[scope] && !current[other]) return current; // al menos uno queda encendido
      return { ...current, [scope]: !current[scope] };
    });
  };

  const clearFilters = () => {
    setScopes({ trabajo: true, personal: true });
    setOverdueOnly(false);
  };

  const undo = async (id: string) => {
    const result = await restore(id);
    show(result.ok ? { message: 'Tarea restaurada', duration: 3000 } : { message: result.message, tone: 'error' });
  };

  const toggleDone = async (task: VaultTask) => {
    if (task.status === 'completed') {
      await undo(task.id);
      return;
    }
    const result = await complete(task);
    show(
      result.ok
        ? { message: 'Completada', action: { label: 'Deshacer', run: () => void undo(task.id) } }
        : { message: result.message, tone: 'error' },
    );
  };

  const moveTo = async (task: VaultTask, folder: string, label: string) => {
    const result = await move(task, folder);
    show(result.ok ? { message: `Movida a ${label}` } : { message: result.message, tone: 'error' });
  };

  const createTask = async (input: CreateTaskInput, label: string) => {
    const result = await create(input);
    if (result.ok) show({ message: `Agregada a ${label}` });
    return result;
  };

  const loadingFirst = !data && !error;

  return (
    <div className="space-y-4 selection:bg-slate-600 selection:text-slate-100">
      <PageHeader
        title="Tareas"
        sub={
          data && <SyncLine syncedAt={data.syncedAt} now={now} fetching={fetching} onRefresh={() => void syncNow()} />
        }
        action={
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={!data}
            aria-label="Agregar tarea"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-600 text-slate-950 transition-colors active:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-50"
          >
            <Plus aria-hidden="true" size={22} strokeWidth={2.2} />
          </button>
        }
      />

      {error && (
        <ErrorNotice
          message={error}
          onRetry={() => void reload()}
          retrying={fetching}
        />
      )}

      {loadingFirst && <Spinner text="Cargando tareas…" />}

      {data && (
        <>
          <Segmented
            label="Vista de tareas"
            idBase={ID_BASE}
            value={view}
            onChange={setView}
            items={[
              { id: 'lista', label: 'Lista' },
              { id: 'cajon', label: 'Cajón', count: counts.inbox },
            ]}
          />

          <div
            role="tabpanel"
            id={`${ID_BASE}-panel`}
            aria-labelledby={`${ID_BASE}-tab-${view}`}
            className="space-y-4"
          >
            {view === 'lista' ? (
              <>
                <FilterChips
                  scopes={scopes}
                  onToggleScope={toggleScope}
                  overdueOnly={overdueOnly}
                  overdueCount={counts.overdue}
                  onToggleOverdue={() => setOverdueOnly((v) => !v)}
                />
                {visibleGroups.length > 0 ? (
                  visibleGroups.map((group) => (
                    <TaskGroupCard
                      key={group.key}
                      group={group}
                      busy={busy}
                      onToggle={(task) => void toggleDone(task)}
                      onMove={setMoving}
                    />
                  ))
                ) : data.groups.length === 0 ? (
                  <div className="card text-center">
                    <p className="text-[15.5px] font-semibold text-slate-200">Sin pendientes.</p>
                    <p className="mt-1 text-[14px] leading-relaxed text-slate-400">Raro, pero no me quejo.</p>
                  </div>
                ) : (
                  <div className="card text-center">
                    <p className="text-[15.5px] font-semibold text-slate-200">Nada con estos filtros.</p>
                    <button type="button" onClick={clearFilters} className="btn-secondary mt-3 min-h-11 px-4 py-2 text-[14px]">
                      Quitar filtros
                    </button>
                  </div>
                )}
              </>
            ) : (
              <InboxView
                tasks={data.inbox}
                busy={busy}
                onToggle={(task) => void toggleDone(task)}
                onAccept={(task) => {
                  if (task.suggest) void moveTo(task, task.suggest, task.suggestLabel ?? 'el destino sugerido');
                }}
                onMove={setMoving}
              />
            )}
          </div>
        </>
      )}

      <MoveSheet
        task={moving}
        destinations={data?.destinations ?? NO_DESTINATIONS}
        onClose={() => setMoving(null)}
        onPick={(task, destination) => {
          setMoving(null);
          void moveTo(task, destination.folder, destination.label);
        }}
      />

      {data && (
        <AddTaskSheet
          open={adding}
          onOpenChange={setAdding}
          destinations={data.destinations}
          hoy={data.hoy}
          onCreate={createTask}
        />
      )}

      <Notice notice={notice} onDismiss={dismiss} onPause={pause} onResume={resume} />
    </div>
  );
}
