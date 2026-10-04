// Genera y guarda el brief del día. Lo usan la función `brief` (cron y botón de la web) y la tool del agente.
// Corre con el cliente de servicio: nunca recibe un user_id del cliente (quien llama ya validó al dueño).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { calendarEvents, describeError } from "../_shared/google.ts";
import { addDays, limaDateKey, limaParts } from "../_shared/google/time.ts";
import { llmConfigured, llmFetch } from "../_shared/llm.ts";
import { notify } from "../_shared/notify.ts";
import {
  aceptarTextoModelo,
  ANTES_DE_LAS_7,
  debeAvisar,
  buildSections,
  datosParaModelo,
  type EventoCrudo,
  type Fuente,
  type FuentesBrief,
  type RecurrenteCrudo,
  type Secciones,
  SISTEMA_BRIEF,
  type TareaCruda,
  corridaReciente,
  vaultSinConectar,
  textoRespaldo,
  tieneFuenteCaida,
  MAX_VENCIDO_DIAS,
  VENTANA_PAGOS_DIAS,
  ventanaMes,
} from "./logic.ts";

export type Brief = { fecha: string; texto: string; secciones: Secciones; creado: string; origen: "cron" | "manual"; notificado: boolean };
export type Origen = Brief["origen"];

const COLUMNAS = "fecha, texto, secciones, creado, origen, notificado";
const LLM_TIMEOUT_MS = 15_000;
const PAGINA = 1000; // tope de filas por consulta de PostgREST

const mensajeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- fuentes

async function leerAgenda(userId: string, fecha: string): Promise<Fuente<EventoCrudo[]>> {
  try {
    const eventos = await calendarEvents(userId, fecha, 1);
    return { ok: true, data: eventos.map((e) => ({ title: e.title, all_day: e.all_day, start_hm: e.start_hm, my_response: e.my_response })) };
  } catch (e) {
    const d = describeError(e);
    if (d.status >= 500) console.error("brief agenda:", mensajeError(e));
    return { ok: false, estado: d.code === "no_conectado" || d.code === "reauth" ? "no_conectado" : "error", mensaje: d.message };
  }
}

async function leerTareas(db: SupabaseClient, userId: string): Promise<Fuente<TareaCruda[]>> {
  const { data: sync, error: syncError } = await db.from("vault_sync").select("docs, tasks").eq("user_id", userId).maybeSingle();
  if (syncError) return { ok: false, estado: "error", mensaje: "No pude leer tus tareas." };
  const sinVault = vaultSinConectar(sync as { docs: number; tasks: number } | null);
  if (sinVault) return sinVault;
  const { data, error } = await db.from("vault_tasks").select("text, status, due, scheduled, shared_with, raw")
    .eq("user_id", userId).in("status", ["pending", "in-progress", "need-help"]).limit(PAGINA);
  if (error) {
    console.error("brief tareas:", error.message);
    return { ok: false, estado: "error", mensaje: "No pude leer tus tareas." };
  }
  return { ok: true, data: (data ?? []) as TareaCruda[] };
}

// Gastado del mes: solo soles y solo gastos (las transferencias no son gasto). Mes de Lima.
async function leerGasto(db: SupabaseClient, userId: string, desde: string, hasta: string): Promise<Fuente<number>> {
  let total = 0;
  for (let from = 0;; from += PAGINA) {
    const { data, error } = await db.from("transactions").select("amount")
      .eq("user_id", userId).eq("transaction_type", "expense").eq("currency_code", "PEN")
      .gte("transaction_date", desde).lt("transaction_date", hasta)
      .order("transaction_id").range(from, from + PAGINA - 1);
    if (error) {
      console.error("brief gasto:", error.message);
      return { ok: false, estado: "error", mensaje: "No pude leer lo gastado del mes." };
    }
    for (const r of data ?? []) total += Number(r.amount);
    if ((data?.length ?? 0) < PAGINA) return { ok: true, data: total };
  }
}

async function leerPagos(db: SupabaseClient, userId: string, hoy: string, desde: string, hasta: string): Promise<Fuente<{ recurrentes: RecurrenteCrudo[]; pagados: string[] }>> {
  const [rec, pagos] = await Promise.all([
    db.from("recurring_transactions").select("recurring_id, description, amount, next_due_date")
      .eq("user_id", userId).eq("is_active", true).eq("transaction_type", "expense")
      .lte("next_due_date", addDays(hoy, VENTANA_PAGOS_DIAS)).gte("next_due_date", addDays(hoy, -MAX_VENCIDO_DIAS))
      .order("next_due_date"),
    db.from("transactions").select("recurring_id").eq("user_id", userId).eq("is_recurring", true)
      .gte("transaction_date", desde).lt("transaction_date", hasta),
  ]);
  if (rec.error || pagos.error) {
    console.error("brief pagos:", rec.error?.message ?? pagos.error?.message);
    return { ok: false, estado: "error", mensaje: "No pude leer tus pagos próximos." };
  }
  return {
    ok: true,
    data: {
      recurrentes: (rec.data ?? []) as RecurrenteCrudo[],
      pagados: (pagos.data ?? []).map((t: { recurring_id: string | null }) => t.recurring_id).filter((id): id is string => Boolean(id)),
    },
  };
}

// ---------------------------------------------------------------- texto hablado

// MiMo redacta SOLO a partir de las secciones. Si falla, tarda o inventa cifras: texto armado por código.
async function redactar(secciones: Secciones): Promise<string | null> {
  if (!llmConfigured()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const salida = await Promise.race([
      llmFetch({
        messages: [
          { role: "system", content: SISTEMA_BRIEF },
          { role: "user", content: `DATOS (JSON):\n${datosParaModelo(secciones)}` },
        ],
        temperature: 0.6,
        max_tokens: 220,
      }).then(async (r) => {
        if (!r.ok) throw new Error(`modelo ${r.status}`);
        const j = await r.json();
        return String(j?.choices?.[0]?.message?.content ?? "");
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("tiempo agotado")), LLM_TIMEOUT_MS);
      }),
    ]);
    return aceptarTextoModelo(salida, secciones);
  } catch (e) {
    console.error("brief modelo:", mensajeError(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- brief

export async function briefDeHoy(db: SupabaseClient, userId: string, fecha = limaDateKey(new Date())): Promise<Brief | null> {
  const { data, error } = await db.from("briefs").select(COLUMNAS).eq("user_id", userId).eq("fecha", fecha).maybeSingle();
  if (error) throw new Error(`briefs: ${error.message}`);
  return (data as Brief | null) ?? null;
}

// Última corrida sin guardar por día (en memoria de la instancia): clics repetidos no vuelven a llamar al modelo.
const corridasSinGuardar = new Map<string, number>();

export type Resultado = {
  brief: Brief;
  /** true si quedó guardado (o ya lo estaba); false para una vista previa o un brief con una fuente caída. */
  persistido: boolean;
};

/**
 * Devuelve el brief de hoy; si no existe lo arma.
 *  - Antes de las 7:00 de Lima, un pedido manual devuelve una vista previa SIN guardar (no congela el día).
 *  - Si alguna fuente quedó en error tampoco se guarda: el próximo intento lo completa.
 *  - `force` regenera y actualiza la fila de hoy (sin tocar origen, hora ni aviso).
 * `db` debe ser el cliente de servicio (la tabla solo la escribe el servicio).
 */
export async function generarBrief(db: SupabaseClient, userId: string, origen: Origen, opts: { force?: boolean } = {}): Promise<Resultado> {
  const ahora = new Date();
  const { dateKey: fecha, minutes } = limaParts(ahora);
  const existente = await briefDeHoy(db, userId, fecha);
  if (existente && !opts.force) return { brief: existente, persistido: true };

  const mes = ventanaMes(fecha);
  const [agenda, tareas, gasto, pagos] = await Promise.all([
    leerAgenda(userId, fecha),
    leerTareas(db, userId),
    leerGasto(db, userId, mes.desde, mes.hasta),
    leerPagos(db, userId, fecha, mes.desde, mes.hasta),
  ]);
  const fuentes: FuentesBrief = { agenda, tareas, gasto, pagos };
  const secciones = buildSections(ahora, fuentes);
  const vistaPrevia = origen === "manual" && ANTES_DE_LAS_7(minutes);
  const sinGuardar = vistaPrevia || tieneFuenteCaida(secciones);
  const reciente = sinGuardar && corridaReciente(corridasSinGuardar.get(fecha), ahora.getTime());
  const texto = (reciente ? null : await redactar(secciones)) ?? textoRespaldo(secciones);
  const nuevo: Brief = { fecha, texto, secciones, creado: ahora.toISOString(), origen, notificado: false };

  if (sinGuardar) {
    if (!reciente) corridasSinGuardar.set(fecha, ahora.getTime());
    return { brief: nuevo, persistido: false };
  }

  if (existente) {
    const { data, error } = await db.from("briefs").update({ texto, secciones })
      .eq("user_id", userId).eq("fecha", fecha).select(COLUMNAS);
    if (error) throw new Error(`briefs: ${error.message}`);
    return { brief: (data?.[0] as Brief | undefined) ?? { ...existente, texto, secciones }, persistido: true };
  }

  const { data, error } = await db.from("briefs")
    .upsert({ user_id: userId, fecha, texto, secciones, origen }, { onConflict: "user_id,fecha", ignoreDuplicates: true })
    .select(COLUMNAS);
  if (error) throw new Error(`briefs: ${error.message}`);
  if (data && data.length > 0) return { brief: data[0] as Brief, persistido: true };

  // Otro pedido lo guardó mientras este armaba el suyo: se devuelve el que quedó.
  const ganador = await briefDeHoy(db, userId, fecha);
  if (!ganador) throw new Error("briefs: no quedó guardado");
  return { brief: ganador, persistido: true };
}

/**
 * Avisa por push si corresponde y deja constancia en `notificado`. El reclamo es atómico
 * (update ... where notificado = false): dos cron o un cron y un botón nunca avisan dos veces.
 * Si el aviso no pudo registrarse, se libera el reclamo para que el siguiente intento lo reintente.
 */
export async function avisarSiFalta(db: SupabaseClient, userId: string, brief: Brief, via: "cron" | "ui"): Promise<boolean> {
  if (!debeAvisar(brief, via)) return false;
  const { data, error } = await db.from("briefs").update({ notificado: true })
    .eq("user_id", userId).eq("fecha", brief.fecha).eq("notificado", false).select("fecha");
  if (error || !data || data.length === 0) return false; // otro ya lo reclamó
  const id = await notify(db, userId, { kind: "brief", title: brief.secciones.titulo, body: brief.texto, url: "/brief" });
  if (id === null) {
    await db.from("briefs").update({ notificado: false }).eq("user_id", userId).eq("fecha", brief.fecha);
    return false;
  }
  return true;
}
