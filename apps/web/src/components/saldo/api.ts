// Cliente de la edge function `saldo`. El JWT del usuario viaja solo; el servidor valida que sea el dueño.
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Saldo } from './types';

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

export async function cargarSaldo(): Promise<Saldo> {
  const { data, error } = await supabase.functions.invoke('saldo', { timeout: 15_000 });
  if (error) throw new Error(await readError(error));
  return data as Saldo;
}
