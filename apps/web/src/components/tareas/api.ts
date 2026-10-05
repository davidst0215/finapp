import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type {
  CreateTaskInput,
  SearchResponse,
  TaskMutationResponse,
  TaskRef,
  TasksResponse,
  TaskStatus,
} from './types';

// Cliente de la edge function `vault`. El servidor valida al usuario; aquí solo se manda el JWT de la sesión.

export class VaultApiError extends Error {
  status: number;
  /** Mover: la tarea se copió al destino pero no se pudo quitar del origen (quedó duplicada). */
  partial: boolean;
  constructor(message: string, status = 0, partial = false) {
    super(message);
    this.name = 'VaultApiError';
    this.status = status;
    this.partial = partial;
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new VaultApiError('No hay sesión iniciada', 401);

  const { data, error } = await supabase.functions.invoke('vault', {
    body,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  if (error) {
    // Las respuestas no-2xx traen el motivo del servidor en el cuerpo: { error: "…" }.
    let message = error.message;
    let status = 0;
    let partial = false;
    if (error instanceof FunctionsHttpError) {
      status = error.context.status;
      try {
        const payload = (await error.context.json()) as { error?: unknown; partial?: unknown };
        if (payload?.error) message = String(payload.error);
        partial = payload?.partial === true;
      } catch {
        /* el cuerpo no era JSON: queda el mensaje genérico */
      }
    }
    throw new VaultApiError(message, status, partial);
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new VaultApiError(String((data as { error: unknown }).error));
  }
  return data as T;
}

export interface SyncResponse {
  ok: true;
  skipped: boolean;
  /** Quedan archivos por traer: volver a llamar para continuar (el vault es grande). */
  partial: boolean;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  docs: number;
  tasks: number;
  syncedAt: string;
}

export const vaultApi = {
  /** Trae el índice de tareas ya agrupado, tal como está en la base (sin esperar a GitHub). */
  tasks: () => call<TasksResponse>({ action: 'tasks' }),

  /** Reindexa todo el vault desde GitHub ahora mismo. */
  sync: () => call<SyncResponse>({ action: 'sync', force: true }),

  /** Trae solo lo que cambió en GitHub; si el árbol no cambió, una sola consulta y nada más. */
  syncChanges: () => call<SyncResponse>({ action: 'sync' }),

  createTask: (input: CreateTaskInput) =>
    call<TaskMutationResponse>({ action: 'task.create', ...input }),

  setStatus: (ref: TaskRef, status: TaskStatus) =>
    call<TaskMutationResponse>({ action: 'task.status', ...ref, status }),

  moveTask: (ref: TaskRef, folder: string) =>
    call<TaskMutationResponse>({ action: 'task.move', ...ref, folder }),

  /** `answer: true` agrega la respuesta redactada por el modelo (tarda ~2 s más). */
  search: (q: string, opts: { cliente?: string | null; answer?: boolean } = {}) =>
    call<SearchResponse>({ action: 'search', q, cliente: opts.cliente ?? undefined, answer: opts.answer ?? false }),
};
