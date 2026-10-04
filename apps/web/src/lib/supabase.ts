import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Faltan variables de entorno VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY');
}

// Las edge functions corren por defecto en la región más cercana a David, pero la base vive en
// us-west-2: cada consulta cruzaba el continente (~0.7 s por pedido). Fijarlas junto a la base
// deja auth y consultas en ~0.1 s. Solo el query param: un header propio exigiría tocar el CORS.
const REGION = 'us-west-2';
const ORIGEN = new URL(supabaseUrl).origin;

// Solo las edge functions de este proyecto: el texto '/functions/v1/' dentro de un filtro de
// PostgREST no debe recibir el parámetro (PostgREST lo tomaría como columna y daría 400).
function conRegion(url: string): string {
  const u = new URL(url);
  if (u.origin !== ORIGEN || !u.pathname.startsWith('/functions/v1/')) return url;
  u.searchParams.set('forceFunctionRegion', REGION);
  return u.toString();
}

/** URL de una edge function, en la región de la base. Para los fetch directos (voz, chat en streaming). */
export const functionUrl = (name: string) => conRegion(`${supabaseUrl}/functions/v1/${name}`);

// supabase-js llama con string; un Request (con su cuerpo en stream) pasa tal cual.
const fetchRegional: typeof fetch = (input, init) => {
  if (typeof input === 'string') return fetch(conRegion(input), init);
  if (input instanceof URL) return fetch(conRegion(input.href), init);
  return fetch(input, init);
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, { global: { fetch: fetchRegional } });

// Despierta las funciones (y la conexión TLS) mientras David habla: el preflight CORS no
// necesita sesión ni cuesta créditos. Como mucho una vez por minuto por función.
const calentadas = new Map<string, number>();
export function calentarFunciones(...names: string[]) {
  const ahora = Date.now();
  for (const name of names) {
    if (ahora - (calentadas.get(name) ?? 0) < 60_000) continue;
    calentadas.set(name, ahora);
    fetch(functionUrl(name), { method: 'OPTIONS' }).catch(() => calentadas.delete(name));
  }
}
