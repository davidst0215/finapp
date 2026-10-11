// Antes de escribir una tarea en el vault hay que decidir DÓNDE (proyecto), CUÁNDO (fecha y hora de Lima) y si falta algo por
// preguntar. Esa decisión es pura y se prueba sin GitHub ni base: tareas.ts solo ejecuta el plan.
import { horaHablada } from "../../_shared/google/speech.ts";
import { parseTime } from "../../_shared/google/time.ts";
import { addDays, resolveDue } from "../../_shared/vault/fechas.ts";
import { destinoHablado, type Indice, preguntaProyecto, type Resolucion, resolverProyecto } from "../../_shared/vault/proyectos.ts";
import { corto } from "../../_shared/vault/speech.ts";
import { INBOX_FOLDER } from "../../_shared/vault/taxonomy.ts";
import type { ToolResult } from "../types.ts";
import { HORA_POR_DEFECTO } from "./avisosPlan.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** «recuérdame», «recuérdalo», «avísame»…: se lo pide a Wabid. «Avisar a Ana» dentro del texto de una tarea NO es un pedido de aviso. */
export const PIDE_AVISO = /\b(?:recu[eé]rd(?:ame|amelo|amela|alo|ala)|av[ií]same(?:lo|la)?)\b/i;

export type PlanTarea = {
  text: string;
  folder: string;
  /** Dónde quedó, como se dice: «Maqui CO cobranzas», «el cajón». */
  donde: string;
  due: string | null;
  /** HH:MM en 24 h. Norte no tiene hora: va en el detalle de la tarea y en la frase. */
  hora: string | null;
  note: string | null;
  /** Si el proyecto pedido no existe: la tarea queda en el cajón y se dice. */
  aviso: string;
  avisoVoz: string;
  /** David pidió «recuérdame / avísame»: además de la tarea hay que programar un aviso (o decirle que falta el cuándo). */
  pidioAviso: boolean;
  /** Cuándo suena ese aviso (día y hora de Lima; solo el día = 9:00). null si no dio fecha ni hora. */
  recordar: { fecha: string; hora: string; porDefecto: boolean } | null;
  /** Qué pasó con el proyecto que dijo (para el registro): null si no dijo ninguno. */
  proyecto: Resolucion | null;
  /** «a las cinco de la tarde», para la voz. */
  horaHablada: string;
};

const clarify = (message: string, voz?: string, proyecto: Resolucion | null = null): { respuesta: ToolResult; proyecto: Resolucion | null } => ({
  respuesta: { action: "clarify", message, ...(voz ? { voz } : {}) },
  proyecto,
});

/**
 * Convierte lo que pidió el modelo (create_task) en un plan o en una pregunta. `dictado` es lo que dijo David: solo se mira
 * para saber si pidió «recuérdame» (entonces la tarea lleva además un aviso a esa hora). Sin hora ni fecha la tarea queda sin vencimiento; con hora y sin fecha es de hoy, o de
 * mañana si esa hora ya pasó en Lima.
 */
export function planearTarea(
  args: Record<string, unknown>,
  ctx: { hoy: string; minutos: number; dictado: string },
  ix: Indice | ((dicho: string) => Resolucion) | null,
): { plan: PlanTarea } | { respuesta: ToolResult; proyecto: Resolucion | null } {
  const text = str(args.text).trim();
  if (!text) return { respuesta: { action: "error", message: "No entendí qué tarea anotar." }, proyecto: null };

  let folder = INBOX_FOLDER;
  let donde = "el cajón";
  let aviso = "";
  let avisoVoz = "";
  let proyecto: Resolucion | null = null;
  const dicho = str(args.project).trim();
  if (dicho) {
    proyecto = typeof ix === "function" ? ix(dicho) : ix ? resolverProyecto(dicho, ix) : { kind: "none" };
    if (proyecto.kind === "one" && proyecto.aproximado) {
      // Escribir en el proyecto equivocado deja la tarea donde nadie la busca: una coincidencia a medias se confirma antes (leer sí puede ser aproximado).
      const nombre = destinoHablado(proyecto.destino);
      return clarify(`¿Lo anoto en ${nombre}?`, `¿En ${nombre}?`, proyecto);
    } else if (proyecto.kind === "one") {
      folder = proyecto.destino.folder;
      donde = destinoHablado(proyecto.destino);
    } else if (proyecto.kind === "many") {
      const p = preguntaProyecto(proyecto);
      return clarify(p.message, p.voz, proyecto);
    } else {
      aviso = ` No encontré el proyecto «${corto(dicho, 40)}», así que quedó en el cajón.`;
      avisoVoz = " No encontré ese proyecto.";
    }
  }

  let hora: string | null = null;
  const horaDicha = str(args.time).trim();
  if (horaDicha) {
    hora = parseTime(horaDicha);
    if (!hora) return clarify("No entendí la hora. Dímela como las cinco de la tarde.", undefined, proyecto);
  }

  let due: string | null = null;
  const fechaDicha = str(args.due).trim();
  if (fechaDicha) {
    due = resolveDue(fechaDicha, ctx.hoy);
    if (!due) return clarify(`No entendí la fecha «${corto(fechaDicha, 30)}». Dímela como mañana, el viernes o el 15 de octubre.`, undefined, proyecto);
  } else if (hora) {
    const [h = 0, m = 0] = hora.split(":").map(Number);
    due = h * 60 + m <= ctx.minutos ? addDays(ctx.hoy, 1) : ctx.hoy;
  }

  // Norte guarda solo la fecha (📅). La hora viaja en el detalle para no perderla.
  const extra = str(args.note).trim();
  const note = [hora ? `Hora: ${hora}` : "", extra].filter(Boolean).join(". ") || null;

  // «Recuérdame / avísame» programa un aviso push (módulo avisos, migración 017) a la hora dicha; con solo el día, a las 9:00.
  const pidioAviso = PIDE_AVISO.test(ctx.dictado);
  const recordar = pidioAviso && due ? { fecha: due, hora: hora ?? HORA_POR_DEFECTO, porDefecto: !hora } : null;

  return { plan: { text, folder, donde, due, hora, note, aviso, avisoVoz, pidioAviso, recordar, proyecto, horaHablada: hora ? horaHablada(hora) : "" } };
}
