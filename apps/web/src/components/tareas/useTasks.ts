import { useCallback, useEffect, useRef, useState } from 'react';
import { vaultApi } from './api';
import { errorMessage } from './format';
import type { CreateTaskInput, TaskRef, TasksResponse, TaskStatus, VaultTask } from './types';

/** Pasado este tiempo sin recargar, volver a la pestaña vuelve a pedir los datos. */
const STALE_AFTER_MS = 60_000;

export type ActionResult = { ok: true } | { ok: false; message: string };

const OK: ActionResult = { ok: true };
const failure = (e: unknown): ActionResult => ({ ok: false, message: errorMessage(e) });

interface LoadOptions {
  /** Pide al servidor sincronizar con GitHub antes (él decide si pasó más de un minuto). */
  refresh: boolean;
  /** Sincroniza ya, sin esperar el minuto (botón de refrescar). */
  force?: boolean;
  /** Una recarga de fondo no avisa de errores si ya hay datos en pantalla. */
  silent?: boolean;
}

const refOf = (t: VaultTask): TaskRef => ({ path: t.path, line: t.line, raw: t.raw });

function mapTasks(data: TasksResponse, fn: (t: VaultTask) => VaultTask): TasksResponse {
  return {
    ...data,
    groups: data.groups.map((g) => ({ ...g, tasks: g.tasks.map(fn) })),
    inbox: data.inbox.map(fn),
  };
}

function findTask(data: TasksResponse | null, id: string): VaultTask | null {
  if (!data) return null;
  for (const g of data.groups) {
    const hit = g.tasks.find((t) => t.id === id);
    if (hit) return hit;
  }
  return data.inbox.find((t) => t.id === id) ?? null;
}

/**
 * Datos de la pantalla Tareas. El servidor da forma a todo; aquí solo se pide, se parchea lo optimista
 * (completar, deshacer) y se descartan las respuestas que llegan tarde.
 */
export function useTasks() {
  const [data, setData] = useState<TasksResponse | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  const dataRef = useRef<TasksResponse | null>(null);
  /** La última petición pedida es la única que vale; una mutación también invalida las que van en vuelo. */
  const seq = useRef(0);
  const inFlight = useRef(0);
  const loadedAt = useRef(0);
  /** Por tarea completada: la línea con su `raw` nuevo y el estado que tenía, para poder deshacer. */
  const completions = useRef(new Map<string, { ref: TaskRef; prev: TaskStatus }>());

  const commit = useCallback((next: TasksResponse | null) => {
    dataRef.current = next;
    setData(next);
  }, []);

  const patchTask = useCallback(
    (id: string, patch: Partial<VaultTask>) => {
      const current = dataRef.current;
      if (!current) return;
      commit(mapTasks(current, (t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    [commit],
  );

  const mark = useCallback((id: string, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const load = useCallback(
    async ({ refresh, force = false, silent = false }: LoadOptions) => {
      const mine = ++seq.current;
      inFlight.current += 1;
      setFetching(true);
      try {
        if (force) await vaultApi.sync();
        const res = await vaultApi.tasks({ refresh: force ? false : refresh });
        if (mine !== seq.current) return;
        commit(res);
        setError(null);
        loadedAt.current = Date.now();
      } catch (e) {
        if (mine !== seq.current) return;
        if (!silent || !dataRef.current) setError(errorMessage(e));
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) setFetching(false);
      }
    },
    [commit],
  );

  // Al abrir: pide sincronizar con GitHub.
  useEffect(() => {
    void load({ refresh: true });
  }, [load]);

  // Al volver a la pestaña después de más de un minuto: recarga de fondo, sin tapar lo que ya se ve.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > STALE_AFTER_MS) {
        void load({ refresh: true, silent: true });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const syncNow = useCallback(() => load({ refresh: false, force: true }), [load]);

  /** Completa en el sitio (queda tachada hasta la siguiente carga). */
  const complete = useCallback(
    async (task: VaultTask): Promise<ActionResult> => {
      seq.current += 1; // una carga en vuelo traería la tarea todavía abierta
      mark(task.id, true);
      patchTask(task.id, { status: 'completed' });
      try {
        const res = await vaultApi.setStatus(refOf(task), 'completed');
        // El archivo cambió de línea: hay que mandar el `raw` nuevo para poder deshacer.
        const raw = res.task?.raw ?? task.raw;
        patchTask(task.id, { status: 'completed', raw });
        completions.current.set(task.id, { ref: { path: task.path, line: task.line, raw }, prev: task.status });
        return OK;
      } catch (e) {
        patchTask(task.id, { status: task.status });
        void load({ refresh: false, silent: true }); // lo habitual: la línea cambió en el archivo
        return failure(e);
      } finally {
        mark(task.id, false);
      }
    },
    [load, mark, patchTask],
  );

  /** Deshace una tarea completada: vuelve al estado que tenía (normalmente pendiente). */
  const restore = useCallback(
    async (id: string): Promise<ActionResult> => {
      const local = findTask(dataRef.current, id);
      const saved = completions.current.get(id);
      const ref = local ? refOf(local) : saved?.ref;
      if (!ref) return { ok: false, message: 'La tarea ya no está en la lista.' };
      const next: TaskStatus = saved?.prev && saved.prev !== 'completed' ? saved.prev : 'pending';

      seq.current += 1;
      mark(id, true);
      patchTask(id, { status: next });
      try {
        const res = await vaultApi.setStatus(ref, next);
        patchTask(id, { status: next, raw: res.task?.raw ?? ref.raw });
        completions.current.delete(id);
        return OK;
      } catch (e) {
        patchTask(id, { status: 'completed' });
        void load({ refresh: false, silent: true });
        return failure(e);
      } finally {
        mark(id, false);
      }
    },
    [load, mark, patchTask],
  );

  const move = useCallback(
    async (task: VaultTask, folder: string): Promise<ActionResult> => {
      seq.current += 1;
      mark(task.id, true);
      try {
        await vaultApi.moveTask(refOf(task), folder);
        await load({ refresh: false }); // las líneas se desplazan: se pide de nuevo
        return OK;
      } catch (e) {
        void load({ refresh: false, silent: true });
        return failure(e);
      } finally {
        mark(task.id, false);
      }
    },
    [load, mark],
  );

  const create = useCallback(
    async (input: CreateTaskInput): Promise<ActionResult> => {
      seq.current += 1;
      try {
        await vaultApi.createTask(input);
        await load({ refresh: false });
        return OK;
      } catch (e) {
        return failure(e);
      }
    },
    [load],
  );

  return { data, fetching, error, busy, reload: load, syncNow, complete, restore, move, create };
}
