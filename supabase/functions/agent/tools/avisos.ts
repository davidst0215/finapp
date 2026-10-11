// Módulo "avisos" del agente: recordatorios con hora ("recuérdame llamar a Marco a las 5"). El aviso queda en avisos_programados
// (migración 017) con el JWT de David (RLS: solo crea y cancela lo suyo) y la función `avisos` lo envía como push a esa hora.
// Las decisiones de fecha y las frases son puras (avisosPlan.ts); aquí solo se lee y escribe. No agrega contexto al prompt.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corto } from "../../_shared/vault/speech.ts";
import { cortoVoz } from "../../_shared/voz.ts";
import { type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";
import {
  buscarRecordatorio, type FilaAviso, fraseCreado, fraseLista, MAX_PENDIENTES, planearRecordatorio, type PlanRecordatorio, preguntaCual,
} from "./avisosPlan.ts";

const rules = `RECORDATORIOS (avisos push a una hora de Lima):
- "recuérdame / avísame / ponme una alarma … [a las 5 · el jueves a las 9 · mañana · en 20 minutos]" → create_reminder: solo el aviso, no crea tarea. text corto en infinitivo ("Llamar a Marco"). Si además dice "anótalo / agrégalo a mis pendientes" → create_task (que también avisa a esa hora).
- due: hoy, mañana, jueves, +3 o AAAA-MM-DD. time en 24 h; "a las 5" sin más es de la tarde (17:00) y "a las 9" de la mañana (09:00). "en 20 minutos / en dos horas" → en_minutos (20 / 120) sin due ni time. Solo el día: suena a las 9:00. Sin día ni hora, pregunta cuándo.
- "qué recordatorios tengo" → list_reminders. "cancela / quita el recordatorio de X" → cancel_reminder.
- Los avisos de pagos y de presupuestos los manda el sistema solo; no los crees.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const err = (message: string): ToolResult => ({ action: "error", message });
/** El agente corre con la hora de Lima como "hora UTC" (−5 h): el instante real se recupera sumando las 5 horas. */
const ahoraReal = (ctx: AgentContext) => new Date(ctx.limaNow.getTime() + 5 * 3_600_000);

const COLUMNAS = "aviso_id, titulo, cuando, origen, tarea_texto";
const MENSAJE = "Me pediste que te lo recordara.";

/** Los recordatorios que David puede ver y cancelar: los suyos (origen recordatorio o tarea), aún pendientes, del más próximo al más lejano. */
async function pendientes(db: SupabaseClient, userId: string): Promise<FilaAviso[]> {
  const { data, error } = await db.from("avisos_programados").select(COLUMNAS).eq("user_id", userId)
    .in("origen", ["recordatorio", "tarea"]).eq("estado", "pendiente").order("cuando", { ascending: true }).limit(MAX_PENDIENTES + 1);
  if (error) throw new Error(error.message);
  return (data ?? []) as FilaAviso[];
}

/** Inserta el aviso. Devuelve false si ya había uno igual (mismo texto y hora): decirlo dos veces no lo duplica. */
async function insertarAviso(
  db: SupabaseClient, userId: string, plan: PlanRecordatorio, extra: { origen: "recordatorio" | "tarea"; cuerpo: string; url: string; tarea?: { path: string; line: number; texto: string } },
): Promise<"creado" | "repetido" | "lleno"> {
  const existentes = await pendientes(db, userId);
  const cuando = plan.cuando.toISOString();
  if (existentes.some((f) => f.titulo === plan.titulo && new Date(f.cuando).toISOString() === cuando)) return "repetido";
  if (existentes.length >= MAX_PENDIENTES) return "lleno";
  const { error } = await db.from("avisos_programados").insert({
    user_id: userId, origen: extra.origen, titulo: plan.titulo, cuerpo: extra.cuerpo, url: extra.url, cuando,
    ...(extra.tarea ? { tarea_path: extra.tarea.path, tarea_line: extra.tarea.line, tarea_texto: extra.tarea.texto.slice(0, 200) } : {}),
  });
  if (error) throw new Error(error.message);
  return "creado";
}

const LLENO = `Ya tienes ${MAX_PENDIENTES} recordatorios pendientes. Cancela alguno y lo intento de nuevo.`;
const FALLO = "No pude programar el aviso. Inténtalo de nuevo.";

/** Recordatorio ligado a una tarea que se acaba de crear (lo usa create_task cuando David dijo «recuérdame»). */
export async function crearAvisoDeTarea(
  db: SupabaseClient, userId: string, plan: PlanRecordatorio, tarea: { path: string; line: number; texto: string } | null, donde: string,
): Promise<"creado" | "repetido" | "lleno" | "error"> {
  try {
    // Sin la tarea a mano (no se pudo leer tras escribirla) el aviso sale igual, como recordatorio suelto.
    return await insertarAviso(db, userId, plan, {
      origen: tarea ? "tarea" : "recordatorio", cuerpo: `Tu pendiente en ${donde}. ${MENSAJE}`.slice(0, 400), url: "/tareas", ...(tarea ? { tarea } : {}),
    });
  } catch (e) {
    console.error("avisos: crearAvisoDeTarea:", e instanceof Error ? e.message : String(e));
    return "error";
  }
}

// Completar o mover una tarea cancela o reubica sus recordatorios; la lógica vive en _shared/avisosTarea.ts porque también la usa la web
// (función `vault`). Se reexporta aquí para quien ya la importaba de este módulo.
export { cancelarAvisosDeTarea, moverAvisosDeTarea } from "../../_shared/avisosTarea.ts";

// --- create_reminder -----------------------------------------------------------------------------
const createReminder = async (args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> => {
  const planeado = planearRecordatorio(args, { ahora: ahoraReal(ctx) });
  if ("respuesta" in planeado) return planeado.respuesta;
  const { plan } = planeado;
  try {
    const r = await insertarAviso(ctx.supabase, ctx.user.id, plan, { origen: "recordatorio", cuerpo: MENSAJE, url: "/avisos" });
    if (r === "lleno") return err(LLENO);
    return { action: "create_reminder", ...fraseCreado(plan, r === "repetido"), data: { cuando: plan.cuando.toISOString(), titulo: plan.titulo } };
  } catch (e) {
    console.error("avisos: create_reminder:", e instanceof Error ? e.message : String(e));
    return err(FALLO);
  }
};

// --- list_reminders ------------------------------------------------------------------------------
const listReminders = async (_args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> => {
  try {
    const filas = (await pendientes(ctx.supabase, ctx.user.id)).slice(0, 10);
    return { action: "list_reminders", ...fraseLista(filas, ahoraReal(ctx)), data: { reminders: filas.map((f) => ({ title: f.titulo, at: f.cuando })) } };
  } catch (e) {
    console.error("avisos: list_reminders:", e instanceof Error ? e.message : String(e));
    return err("No pude leer tus recordatorios. Inténtalo de nuevo.");
  }
};

// --- cancel_reminder -----------------------------------------------------------------------------
const cancelReminder = async (args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> => {
  try {
    const filas = await pendientes(ctx.supabase, ctx.user.id);
    if (filas.length === 0) return { action: "cancel_reminder", message: "No tienes recordatorios pendientes.", voz: "No tienes recordatorios pendientes." };
    const b = buscarRecordatorio(args.search, filas);
    if (b.kind === "none") return err(`No encontré un recordatorio que se parezca a «${corto(str(args.search), 40)}».`);
    if (b.kind === "many") return { action: "clarify", ...preguntaCual(b.filas) };

    const { data, error } = await ctx.supabase.from("avisos_programados").update({ estado: "cancelado" })
      .eq("aviso_id", b.fila.aviso_id).eq("user_id", ctx.user.id).eq("estado", "pendiente").select("aviso_id");
    if (error) throw new Error(error.message);
    if (!data?.length) return err("Ese aviso ya salió o ya estaba cancelado.");
    return { action: "cancel_reminder", message: `Cancelé el recordatorio «${corto(b.fila.titulo, 60)}».`, voz: `Cancelé «${cortoVoz(b.fila.titulo, 40)}».` };
  } catch (e) {
    console.error("avisos: cancel_reminder:", e instanceof Error ? e.message : String(e));
    return err("No pude cancelar el recordatorio. Inténtalo de nuevo.");
  }
};

export const avisos: AgentModule = {
  id: "avisos",
  rules,
  definitions: [
    tool("create_reminder", "Programa un aviso push a una hora ('recuérdame…', 'avísame…'). No crea una tarea.", {
      text: { type: "string", description: "Qué recordar, corto y en infinitivo (ej. 'Llamar a Marco')" },
      due: { type: "string", description: "Día: 'hoy', 'mañana', 'jueves', '+3' o AAAA-MM-DD; vacío si solo dio la hora o los minutos" },
      time: { type: "string", description: "Hora en 24 h HH:MM ('a las 5' = 17:00, 'a las 9' = 09:00); vacío si solo dio el día" },
      en_minutos: { type: "number", description: "Solo para 'en 20 minutos / en una hora': los minutos (20 / 60), sin due ni time" },
    }, ["text"]),
    tool("list_reminders", "Lista los recordatorios pendientes ('¿qué recordatorios tengo?').", {}),
    tool("cancel_reminder", "Cancela un recordatorio pendiente.", {
      search: { type: "string", description: "Palabras del recordatorio; vacío si dijo 'el recordatorio' a secas" },
    }),
  ],
  handlers: { create_reminder: createReminder, list_reminders: listReminders, cancel_reminder: cancelReminder },
};
