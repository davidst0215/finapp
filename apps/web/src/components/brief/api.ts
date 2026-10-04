// Cliente de la edge function `brief`. El JWT del usuario viaja solo; el servidor valida que sea el dueño.
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Brief } from './types';

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

async function call<T>(action: 'latest' | 'generate'): Promise<T> {
  const { data, error } = await supabase.functions.invoke('brief', { body: { action } });
  if (error) throw new Error(await readError(error));
  return data as T;
}

export const briefApi = {
  /** Último brief guardado (puede ser de un día anterior) y la fecha de hoy en Lima. */
  latest: () => call<{ brief: Brief | null; hoy: string }>('latest'),
  /** Arma el de hoy; si ya existía, devuelve ese. */
  generate: () => call<{ brief: Brief; creado: boolean }>('generate'),
};
