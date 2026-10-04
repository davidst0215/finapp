// Lectura de la base para el módulo reuniones. Compartido por la función `fathom` y la tool del agente.
// Solo lee con el cliente que le pasen (RLS del usuario); no escribe ni llama a Fathom.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { construirEsperas, ESTADOS_ABIERTOS, type Espera, type Reunion } from "./pure.ts";

export type EsperasResultado =
  | { ok: true; esperas: Espera[] }
  | { ok: false; motivo: "sin_vault" | "error"; mensaje: string };

// La migración del vault (005) puede no estar aplicada todavía: eso no debe romper la pantalla ni el agente.
const tablaFalta = (e: { code?: string; message?: string }) =>
  e.code === "42P01" || e.code === "PGRST205" || /vault_tasks/.test(e.message ?? "") && /(does not exist|schema cache)/.test(e.message ?? "");

/** Tareas abiertas con #conjunto/<quien> del índice del vault, convertidas en esperas con sus días. */
export async function leerEsperas(db: SupabaseClient, hoy: string): Promise<EsperasResultado> {
  const { data, error } = await db.from("vault_tasks")
    .select("text, status, shared_with, note, raw, due")
    .in("status", ESTADOS_ABIERTOS)
    .not("shared_with", "is", null)
    .limit(500);
  if (error) {
    if (tablaFalta(error)) {
      return { ok: false, motivo: "sin_vault", mensaje: "El índice del vault todavía no está disponible, así que no puedo ver tus esperas." };
    }
    console.error("fathom esperas:", error.message);
    return { ok: false, motivo: "error", mensaje: "No pude leer tus esperas ahora." };
  }
  return { ok: true, esperas: construirEsperas(data ?? [], hoy) };
}

const COLUMNAS = "recording_id, titulo, inicio, duracion_min, invitados, resumen, action_items, share_url, creada_en";

/** Últimas reuniones guardadas (más recientes primero). Lanza si la lectura falla. */
export async function leerReuniones(db: SupabaseClient, limite = 100): Promise<Reunion[]> {
  const { data, error } = await db.from("fathom_meetings").select(COLUMNAS).order("inicio", { ascending: false }).limit(limite);
  if (error) throw new Error(error.message);
  return (data ?? []) as Reunion[];
}

export async function leerReunion(db: SupabaseClient, recordingId: number): Promise<Reunion | null> {
  const { data, error } = await db.from("fathom_meetings").select(COLUMNAS).eq("recording_id", recordingId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Reunion | null) ?? null;
}
