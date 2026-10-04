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
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'VaultApiError';
    this.status = status;
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
    if (error instanceof FunctionsHttpError) {
      status = error.context.status;
      try {
        const payload = (await error.context.json()) as { error?: unknown };
        if (payload?.error) message = String(payload.error);
      } catch {
        /* el cuerpo no era JSON: queda el mensaje genérico */
      }
    }
    throw new VaultApiError(message, status);
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new VaultApiError(String((data as { error: unknown }).error));
  }
  return data as T;
}

export const vaultApi = {
  /** Trae el índice de tareas ya agrupado. `refresh` pide sincronizar con GitHub antes si pasó más de un minuto. */
  tasks: (opts: { refresh?: boolean } = {}) =>
    call<TasksResponse>({ action: 'tasks', refresh: opts.refresh ?? false }),

  /** Sincroniza el índice con GitHub ahora mismo. */
  sync: () => call<{ ok: true; changed: number; syncedAt: string }>({ action: 'sync', force: true }),

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
