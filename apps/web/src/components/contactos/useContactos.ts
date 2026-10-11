import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { MAX_CONTACTOS, ordenar, type Contacto, type Valores } from '@/lib/contactos';

export type Estado = 'loading' | 'ready' | 'error';
export type Resultado = { ok: true } | { ok: false; message: string };

const COLUMNAS = 'contacto_id, nombre, alias, telefono, relacion';
const LLENO = `Llegaste al tope de ${MAX_CONTACTOS} contactos. Elimina alguno para agregar otro.`;
// 23505 = unique_violation: el índice (usuario, teléfono) de la migración 018.
const REPETIDO = 'Ya tienes ese número guardado con otro nombre.';
const FALLO = 'No pude guardar ahora. Inténtalo de nuevo.';
const mensajeDe = (e: { code?: string }) => (e.code === '23505' ? REPETIDO : FALLO);

/**
 * La agenda de Wabid. La lee y la escribe con la sesión de David: la política RLS de `contactos` (user_id = auth.uid()) es la
 * única barrera, así que aquí no se manda ni se filtra por usuario.
 */
export function useContactos() {
  const [items, setItems] = useState<Contacto[]>([]);
  const [estado, setEstado] = useState<Estado>('loading');
  const [error, setError] = useState<string | null>(null);
  const vivo = useRef(true);
  const cuantos = useRef(0); // cuántos hay guardados, para el tope sin volver a crear los callbacks

  const cargar = useCallback(async () => {
    setEstado((e) => (e === 'ready' ? e : 'loading'));
    // El mismo orden y el mismo tope que lee Wabid por voz (agent/tools/contactos.ts): lo que se ve aquí es lo que ella conoce.
    const { data, error: e } = await supabase.from('contactos').select(COLUMNAS).order('nombre', { ascending: true }).limit(MAX_CONTACTOS);
    if (!vivo.current) return;
    if (e) {
      setError('No pude leer tus contactos. Revisa la conexión e inténtalo de nuevo.');
      setEstado('error');
      return;
    }
    cuantos.current = data?.length ?? 0;
    setItems(ordenar((data ?? []) as Contacto[]));
    setError(null);
    setEstado('ready');
  }, []);

  useEffect(() => {
    vivo.current = true;
    void cargar();
    return () => { vivo.current = false; };
  }, [cargar]);

  const crear = useCallback(async (v: Valores): Promise<Resultado> => {
    if (cuantos.current >= MAX_CONTACTOS) return { ok: false, message: LLENO };
    const { error: e } = await supabase.from('contactos').insert(v);
    if (e) return { ok: false, message: mensajeDe(e) };
    await cargar();
    return { ok: true };
  }, [cargar]);

  const actualizar = useCallback(async (id: string, v: Valores): Promise<Resultado> => {
    const { error: e } = await supabase.from('contactos').update(v).eq('contacto_id', id);
    if (e) return { ok: false, message: mensajeDe(e) };
    await cargar();
    return { ok: true };
  }, [cargar]);

  const eliminar = useCallback(async (id: string): Promise<Resultado> => {
    const { error: e } = await supabase.from('contactos').delete().eq('contacto_id', id);
    if (e) return { ok: false, message: 'No pude eliminarlo ahora. Inténtalo de nuevo.' };
    await cargar();
    return { ok: true };
  }, [cargar]);

  /** Guarda varios de una vez. Si algún número se repite (otra pestaña, otro celular), cae a uno por uno y se queda con los que sí entran. */
  const importar = useCallback(async (entrantes: Valores[]): Promise<Resultado & { guardados?: number }> => {
    if (entrantes.length === 0) return { ok: true, guardados: 0 };
    // `desdeSelector` ya recorta al cupo; esto es el último cerrojo antes de escribir.
    const lista = entrantes.slice(0, Math.max(0, MAX_CONTACTOS - cuantos.current));
    if (lista.length === 0) return { ok: false, message: LLENO };
    const lote = await supabase.from('contactos').insert(lista);
    if (!lote.error) {
      await cargar();
      return { ok: true, guardados: lista.length };
    }
    if (lote.error.code !== '23505') return { ok: false, message: FALLO };
    let guardados = 0;
    for (const v of lista) {
      const { error: e } = await supabase.from('contactos').insert(v);
      if (!e) guardados++;
      else if (e.code !== '23505') {
        await cargar();
        return { ok: false, message: FALLO };
      }
    }
    await cargar();
    return { ok: true, guardados };
  }, [cargar]);

  return { items, estado, error, recargar: cargar, crear, actualizar, eliminar, importar };
}

export type ContactosApi = ReturnType<typeof useContactos>;
