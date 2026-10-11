// Recordatorios ligados a una tarea de Norte: qué pasa con ellos cuando la tarea se completa o cambia de lugar. Lo usan el agente (voz) y
// la función `vault` (la web), para que completar o mover una tarea se comporte igual venga de donde venga.
// La referencia es (ruta, línea, texto limpio) y se guarda al crear el aviso (migración 017: tarea_path / tarea_line / tarea_texto).
// Limitación conocida: la línea cambia si se edita el archivo por otro lado (Obsidian, Norte); un recordatorio cuya tarea se corrió de línea
// deja de coincidir (el texto se compara a propósito para no tocar OTRA tarea) y sigue sonando a su hora aunque la tarea ya se haga.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type RefTarea = { path: string; line: number; texto: string };

/** Mismo recorte que al guardar: tarea_texto es VARCHAR(200). */
const textoRef = (t: string) => t.slice(0, 200);

/** Al completar una tarea, sus recordatorios pendientes ya no hacen falta. Nunca lanza: completar la tarea no depende de esto. */
export async function cancelarAvisosDeTarea(db: SupabaseClient, userId: string, tarea: RefTarea): Promise<number> {
  try {
    const { data, error } = await db.from("avisos_programados").update({ estado: "cancelado" }).eq("user_id", userId).eq("estado", "pendiente")
      .eq("tarea_path", tarea.path).eq("tarea_line", tarea.line).eq("tarea_texto", textoRef(tarea.texto)).select("aviso_id");
    if (error) throw new Error(error.message);
    return data?.length ?? 0;
  } catch (e) {
    console.error("avisos: cancelarAvisosDeTarea:", e instanceof Error ? e.message : String(e));
    return 0;
  }
}

/**
 * Al mover una tarea de proyecto, sus recordatorios pendientes la siguen (nueva ruta y línea). Va por un RPC con privilegios de dueño que
 * filtra por auth.uid(): el usuario solo puede CANCELAR sus avisos, no editar su referencia. Nunca lanza: mover la tarea no depende de esto.
 */
export async function moverAvisosDeTarea(db: SupabaseClient, viejo: RefTarea, nuevo: { path: string; line: number }): Promise<number> {
  try {
    const { data, error } = await db.rpc("avisos_mover_tarea", {
      p_path: viejo.path, p_line: viejo.line, p_texto: textoRef(viejo.texto), p_nuevo_path: nuevo.path, p_nueva_line: nuevo.line,
    });
    if (error) throw new Error(error.message);
    return Number(data) || 0;
  } catch (e) {
    console.error("avisos: moverAvisosDeTarea:", e instanceof Error ? e.message : String(e));
    return 0;
  }
}
