import { supabase } from '@/lib/supabase';

// Contrato de la edge function `fathom` (solo el dueño de Wabid).
export interface Invitado { name: string; email: string; externo: boolean }
export interface ActionItem { texto: string; dueno: string | null; hecho: boolean; url: string | null }
export interface Reunion {
  recording_id: number;
  titulo: string;
  inicio: string;
  duracion_min: number | null;
  invitados: Invitado[];
  resumen: string;
  action_items: ActionItem[];
  share_url: string | null;
  creada_en: string;
}
export interface Espera {
  quien: string;
  texto: string;
  desde: string | null;
  dias: number | null;
  vencida: boolean;
  reunion: string | null;
  enlace: string | null;
  vence: string | null;
  clave: string;
}
export type EsperasRespuesta =
  | { ok: true; esperas: Espera[]; hoy: string; umbral: number }
  | { ok: false; motivo: 'sin_vault' | 'error'; mensaje: string };
export interface SyncRespuesta {
  ok: true; guardadas: number; nuevas: number; quedan: boolean; desde: string; antes: string | null; avisos: number;
}

// invoke devuelve un error genérico en 4xx/5xx; el mensaje útil viene en el cuerpo JSON de la respuesta.
async function llamar<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('fathom', { body });
  if (error) {
    let mensaje = 'No pude conectar con el servidor.';
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      const j = await ctx.json().catch(() => null) as { error?: string } | null;
      if (j?.error) mensaje = j.error;
    }
    throw new Error(mensaje);
  }
  return data as T;
}

export const listarReuniones = (limite = 30) =>
  llamar<{ ok: true; reuniones: Reunion[] }>({ action: 'list', limite }).then((r) => r.reuniones);

export const leerEsperas = () => llamar<EsperasRespuesta>({ action: 'esperas' });

/** Sincroniza con Fathom; si la corrida se corta por el tope, continúa hacia atrás hasta completar (máx. 6 vueltas). */
export async function sincronizar(): Promise<{ nuevas: number; avisos: number }> {
  let nuevas = 0;
  let avisos = 0;
  let cont: { desde: string; antes: string } | null = null;
  for (let i = 0; i < 6; i++) {
    const r: SyncRespuesta = await llamar<SyncRespuesta>({ action: 'sync', ...(cont ?? {}) });
    nuevas += r.nuevas;
    avisos += r.avisos;
    if (!r.quedan || !r.antes) break;
    cont = { desde: r.desde, antes: r.antes };
  }
  return { nuevas, avisos };
}
