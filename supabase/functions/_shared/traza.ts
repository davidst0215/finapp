// Traza de cada pedido al agente (tabla agent_trazas, migración 020): qué dijo David, qué herramienta y argumentos eligió el modelo,
// qué se le respondió y cuánto tardó, para saber dónde se rompe. Puro salvo `guardarTraza` (usa el cliente que le pasan): se prueba
// con Node (traza.test.ts).
//
// PRIVACIDAD. Es contenido de David, así que: solo lo lee él (RLS), se borra a los 30 días y los teléfonos no se guardan nunca:
// todo tramo de 6 o más dígitos queda como «[número]» (mismo criterio que las frases de contactos) y el argumento `telefono` se
// descarta. Guardar la traza JAMÁS puede romper ni retrasar un pedido: no lanza y el que llama no la espera.
import { enmascararNumeros } from "./contactos.ts";

export const MAX_TRAZA_TEXTO = 2000;
const MAX_ARG_TEXTO = 500;
const MAX_ARG_CLAVES = 30;
const MAX_ARG_LISTA = 20;
const MAX_ARG_NIVEL = 3;
// Argumentos que son un teléfono: no se guardan ni enmascarados.
const CLAVES_TELEFONO = new Set(["telefono", "phone", "celular"]);

export type FilaTraza = {
  texto: string;
  fn?: string;
  args?: unknown;
  resultado?: string;
  mensaje?: string;
  error?: string;
  prov?: string;
  respaldo?: boolean;
  voz?: boolean;
  voz_chars?: number;
  medidas?: Record<string, unknown>;
};

/** Texto dicho o respondido, con los teléfonos enmascarados y acotado. */
export const textoTraza = (s: unknown, max = MAX_TRAZA_TEXTO): string =>
  enmascararNumeros(typeof s === "string" ? s : "").slice(0, max);

/** Argumentos de la herramienta tal como los armó el modelo: sin teléfonos, textos acotados y estructura de profundidad limitada. */
export function argsTraza(v: unknown, nivel = 0): unknown {
  if (typeof v === "string") return textoTraza(v, MAX_ARG_TEXTO);
  if (v === null || typeof v === "number" || typeof v === "boolean" || v === undefined) return v ?? null;
  if (nivel >= MAX_ARG_NIVEL) return null;
  if (Array.isArray(v)) return v.slice(0, MAX_ARG_LISTA).map((x) => argsTraza(x, nivel + 1));
  if (typeof v === "object") {
    const salida: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_ARG_CLAVES)) {
      if (CLAVES_TELEFONO.has(k.toLowerCase())) continue;
      salida[k.slice(0, 60)] = argsTraza(x, nivel + 1);
    }
    return salida;
  }
  return null;
}

/** La fila tal como se inserta (sin user_id: lo pone quien llama). */
export function filaTraza(f: FilaTraza) {
  return {
    texto: textoTraza(f.texto),
    fn: f.fn?.slice(0, 80) ?? null,
    args: f.args === undefined ? null : argsTraza(f.args),
    resultado: f.resultado?.slice(0, 80) ?? null,
    mensaje: f.mensaje ? textoTraza(f.mensaje) : null,
    error: f.error ? textoTraza(f.error, 500) : null,
    prov: f.prov?.slice(0, 120) || null,
    respaldo: f.respaldo === true,
    voz: f.voz === true,
    voz_chars: typeof f.voz_chars === "number" ? Math.round(f.voz_chars) : null,
    medidas: f.medidas ?? null,
  };
}

type Insertador = { from: (tabla: string) => { insert: (fila: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message: string } | null }> } };

/** Inserta la traza. Nunca lanza: si falla (tabla sin migrar, RLS, red) lo deja en el log y el pedido sigue como si nada. */
export async function guardarTraza(supabase: Insertador, userId: string, fila: FilaTraza): Promise<void> {
  try {
    const { error } = await supabase.from("agent_trazas").insert({ user_id: userId, ...filaTraza(fila) });
    if (error) console.error("traza:", error.code ?? "", error.message);
  } catch (e) {
    console.error("traza:", e instanceof Error ? e.message : String(e));
  }
}
