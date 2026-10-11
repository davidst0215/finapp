import { useEffect } from 'react';
import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { hayQueRefrescar, leerTipoCambio, PAR_USD, type Punto, type TipoCambio } from '@/lib/fx';

// Tipo de cambio USD→PEN para convertir totales. Se lee de fx_rates (rápido, lo ve cualquier sesión) y, si ya venció (>6 h), se pide a la
// función `fx`, que lo refresca desde BCRP y lo guarda. Guarda copia local: sin red (PWA) los totales siguen saliendo con el último valor.
const CLAVE = 'wabid-tc';
const REVISAR_CADA_MS = 5 * 60 * 1000; // dentro de la app no se vuelve a consultar antes de esto

interface Guardado {
  tc: TipoCambio | null;
  historial: Punto[];
}

function leerLocal(): Guardado {
  try {
    const g = JSON.parse(localStorage.getItem(CLAVE) ?? 'null') as Partial<Guardado> | null;
    return { tc: leerTipoCambio(g?.tc), historial: Array.isArray(g?.historial) ? g.historial.filter((p) => Number.isFinite(p?.valor) && typeof p?.fecha === 'string') : [] };
  } catch {
    return { tc: null, historial: [] };
  }
}

function guardarLocal(g: Guardado) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(g));
  } catch {
    // sin almacenamiento disponible: la copia es solo una comodidad
  }
}

interface FxState extends Guardado {
  /** Ya se intentó leer (con o sin resultado): distingue «cargando» de «no hay tipo de cambio». */
  listo: boolean;
  revisadoEn: number;
  load: () => Promise<void>;
}

let enCurso: Promise<void> | null = null;

export const useFxStore = create<FxState>((set, get) => ({
  ...leerLocal(),
  listo: false,
  revisadoEn: 0,

  load: () => {
    if (enCurso) return enCurso;
    if (get().tc && Date.now() - get().revisadoEn < REVISAR_CADA_MS) return Promise.resolve();
    enCurso = (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        // 1) Lo guardado: el valor vigente es la fila más reciente; el historial sirve para convertir cada movimiento con el tipo de su día.
        const { data } = await supabase.from('fx_rates').select('fecha, valor, fuente, obtenido_en').eq('par', PAR_USD).order('fecha', { ascending: false }).limit(500);
        const filas = (data ?? []) as Record<string, unknown>[];
        let tc = leerTipoCambio(filas[0]);
        let historial: Punto[] = filas.map((f) => ({ fecha: String(f.fecha), valor: Number(f.valor) })).filter((p) => Number.isFinite(p.valor));
        // obtenido_en más reciente de TODAS las filas: la última consulta (la fila de la fecha más nueva puede ser de una consulta anterior).
        const ultimaConsulta = filas.reduce((m, f) => (String(f.obtenido_en) > m ? String(f.obtenido_en) : m), '');
        if (tc) set({ tc, historial, revisadoEn: Date.now() });

        // 2) Vencido (o nada guardado): la función lo refresca. Si falla se sigue con lo que hay.
        if (hayQueRefrescar(tc ? { ...tc, obtenido_en: ultimaConsulta || tc.obtenido_en } : null, new Date())) {
          try {
            const { data: nuevo, error } = await supabase.functions.invoke('fx');
            const t = error ? null : leerTipoCambio(nuevo);
            if (t) {
              tc = t;
              if (!historial.some((p) => p.fecha === t.fecha)) historial = [{ fecha: t.fecha, valor: t.valor }, ...historial];
              set({ tc, historial, revisadoEn: Date.now() });
            }
          } catch {
            // sin red o función caída: queda el último valor conocido
          }
        }
        if (tc) guardarLocal({ tc, historial });
      } catch {
        // la lectura falló: se conserva la copia local
      } finally {
        set({ listo: true });
        enCurso = null;
      }
    })();
    return enCurso;
  },
}));

/** El tipo de cambio vigente (o null si todavía no hay). Pide la actualización al montarse. */
export function useTipoCambio(): { tc: TipoCambio | null; historial: Punto[]; listo: boolean } {
  const tc = useFxStore((s) => s.tc);
  const historial = useFxStore((s) => s.historial);
  const listo = useFxStore((s) => s.listo);
  const load = useFxStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return { tc, historial, listo };
}
