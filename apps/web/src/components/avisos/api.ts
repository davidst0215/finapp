// Cliente de la edge function `push` (supabase/functions/push). El JWT del usuario viaja solo.
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { TestResponse } from './logic';

export type Notice = {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
  readAt: string | null;
};

// El servidor responde { error } en español; se muestra tal cual. Cualquier otra falla cae en un mensaje general.
async function readError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await (error.context as Response).json();
      if (typeof body?.error === 'string') return body.error;
    } catch {
      // respuesta sin cuerpo JSON
    }
  }
  return 'No pude contactar al servidor. Revisa tu conexión e inténtalo de nuevo.';
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('push', { body });
  if (error) throw new Error(await readError(error));
  return data as T;
}

export const pushApi = {
  vapidKey: () => call<{ publicKey: string }>({ action: 'vapid-key' }).then((r) => r.publicKey),
  subscribe: (subscription: PushSubscriptionJSON) => call<{ ok: true }>({ action: 'subscribe', subscription }),
  unsubscribe: (endpoint: string) => call<{ ok: true }>({ action: 'unsubscribe', endpoint }),
  test: () => call<TestResponse & { ok: true; id: string }>({ action: 'test' }),
  inbox: () => call<{ items: Notice[]; unread: number }>({ action: 'inbox' }),
  markRead: (ids: string[]) => call<{ ok: true; updated: number }>({ action: 'read', ids }),
  markAllRead: () => call<{ ok: true; updated: number }>({ action: 'read', all: true }),
};
