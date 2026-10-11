// Antes de escribir una nota en el vault hay que decidir DÓNDE (proyecto) y si falta algo por preguntar. Esa decisión es pura y se
// prueba sin GitHub ni base: notas.ts solo ejecuta el plan. Reutiliza la resolución de proyectos hablados (vault/proyectos.ts).
// Escribir en el proyecto equivocado deja la nota donde nadie la busca: lo ambiguo y lo aproximado se confirman ANTES de escribir.
import { limpiarNota, MAX_NOTA, MENSAJE_NOTA_LARGA } from "../../_shared/vault/notas.ts";
import { type Destino, destinoHablado, preguntaProyecto, type Resolucion } from "../../_shared/vault/proyectos.ts";
import { corto } from "../../_shared/vault/speech.ts";
import { INBOX_FOLDER } from "../../_shared/vault/taxonomy.ts";
import type { ToolResult } from "../types.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export type PlanNota = {
  texto: string;
  folder: string;
  /** Dónde quedó, como se dice: «Novafondos app», «el cajón». */
  donde: string;
  /** Cliente con que nace el notas.md nuevo (el de las fichas del proyecto, como en ellas); null en el cajón. */
  cliente: string | null;
  /** Qué pasó con el proyecto que dijo (para el registro): null si no dijo ninguno. */
  proyecto: Resolucion | null;
};

type Respuesta = { respuesta: ToolResult; proyecto: Resolucion | null };
const clarify = (message: string, voz: string, proyecto: Resolucion | null): Respuesta => ({ respuesta: { action: "clarify", message, voz }, proyecto });

/** El `cliente` de las fichas del proyecto; sin él, el proyecto de la configuración (trabajo) o «personal», como las fichas. */
const clienteDe = (d: Destino): string | null => (d.scope === "cajon" ? null : d.cliente ?? (d.scope === "trabajo" ? d.project : "personal"));

/**
 * Convierte lo que pidió el modelo (add_note) en un plan o en una pregunta. `resolucion` es lo que el sistema entendió del
 * proyecto que dijo David (null = no dijo ninguno: la nota va al cajón, como las tareas sin proyecto).
 */
export function planearNota(args: Record<string, unknown>, resolucion: Resolucion | null): { plan: PlanNota } | Respuesta {
  const texto = limpiarNota(args.text);
  if (!texto) return { respuesta: { action: "error", message: "No entendí qué anotar." }, proyecto: null };
  // Una nota que no cabe se rechaza, no se recorta: perder el final de una decisión sin avisar es peor que pedirla más corta.
  if (texto.length > MAX_NOTA) return { respuesta: { action: "error", message: MENSAJE_NOTA_LARGA }, proyecto: null };

  if (!resolucion) return { plan: { texto, folder: INBOX_FOLDER, donde: "el cajón", cliente: null, proyecto: null } };

  if (resolucion.kind === "one" && !resolucion.aproximado) {
    const d = resolucion.destino;
    return { plan: { texto, folder: d.folder, donde: destinoHablado(d), cliente: clienteDe(d), proyecto: resolucion } };
  }
  if (resolucion.kind === "one") {
    const nombre = destinoHablado(resolucion.destino);
    return clarify(`¿Lo anoto en ${nombre}?`, `¿En ${nombre}?`, resolucion);
  }
  if (resolucion.kind === "many") {
    const p = preguntaProyecto(resolucion);
    return clarify(p.message, p.voz, resolucion);
  }
  // Un proyecto que no existe NO se manda al cajón en silencio (una decisión perdida en el cajón no la encuentra nadie): se pregunta.
  const dicho = corto(str(args.project).trim(), 40);
  return clarify(`No encontré el proyecto «${dicho}». ¿En cuál lo anoto? Si no importa, dime «en el cajón».`, "No encontré ese proyecto. ¿En cuál lo anoto?", resolucion);
}
