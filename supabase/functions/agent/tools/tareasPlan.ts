// Antes de escribir una tarea en el vault hay que decidir DÓNDE (proyecto), CUÁNDO (fecha y hora de Lima) y si falta algo por
// preguntar. Esa decisión es pura y se prueba sin GitHub ni base: tareas.ts solo ejecuta el plan.
import { horaHablada } from "../../_shared/google/speech.ts";
import { parseTime } from "../../_shared/google/time.ts";
import { addDays, resolveDue } from "../../_shared/vault/fechas.ts";
import { destinoHablado, type Indice, preguntaProyecto, type Resolucion, resolverProyecto } from "../../_shared/vault/proyectos.ts";
import { corto } from "../../_shared/vault/speech.ts";
import { INBOX_FOLDER } from "../../_shared/vault/taxonomy.ts";
import type { ToolResult } from "../types.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

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
  /** Para la pantalla: lo que pasará (o no) con «recuérdame». */
  recordatorio: string;
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
 * para saber si pidió «recuérdame». Sin hora ni fecha la tarea queda sin vencimiento; con hora y sin fecha es de hoy, o de
 * mañana si esa hora ya pasó en Lima.
 */
export function planearTarea(
  args: Record<string, unknown>,
  ctx: { hoy: string; minutos: number; dictado: string },
  ix: Indice | null,
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
    proyecto = ix ? resolverProyecto(dicho, ix) : { kind: "none" };
    if (proyecto.kind === "one") {
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

  // Todavía no hay avisos programados a una hora: el resumen de las 7:00 incluye lo que vence ese día. No se promete otra cosa.
  let recordatorio = "";
  if (due && /recu[eé]rd|av[ií]sa/i.test(ctx.dictado)) {
    if (due > ctx.hoy) recordatorio = ` Te lo recordará el resumen de las 7:00 de ese día${hora ? "; aún no te aviso a la hora exacta" : ""}.`;
    else if (hora) recordatorio = " Aún no te aviso a la hora exacta.";
  }

  return { plan: { text, folder, donde, due, hora, note, aviso, avisoVoz, recordatorio, proyecto, horaHablada: hora ? horaHablada(hora) : "" } };
}
