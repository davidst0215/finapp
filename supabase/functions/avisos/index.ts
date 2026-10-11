// Función `avisos`: envía los avisos programados que ya vencieron (recordatorios, vencimientos, presupuestos).
//
//   * La llama pg_cron cada minuto (solo cuando hay algo por enviar: ver avisos_hay_trabajo, migración 017) con el header
//     `x-avisos-secret` igual a AVISOS_CRON_SECRET. Se despliega con verify_jwt=false porque pg_cron no tiene JWT de usuario.
//   * RECLAMA los vencidos con avisos_reclamar (UPDATE atómico: dos ejecuciones a la vez nunca reciben el mismo aviso), los envía
//     por el camino de siempre (bandeja + push, _shared/notify.ts) y cierra cada uno con avisos_cerrar (reintento con espera o fallido).
//   * Sirve a todos los usuarios: cada fila lleva su user_id. No hay camino con JWT de usuario: la app lee y cancela sus avisos
//     directo contra la tabla (RLS).
// Secretos: AVISOS_CRON_SECRET (el mismo valor que avisos_cron_secret en Supabase Vault).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, json, preflight } from "../_shared/http.ts";
import { insertNotice, pushToDevices } from "../_shared/notify.ts";
import { secretoIgual } from "../brief/logic.ts";
import { type AvisoReclamado, type Deps, procesarLote } from "./logic.ts";

const LOTE = 20; // por pasada; si hay más, la siguiente (un minuto después) sigue

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  // Primero se valida el secreto; la configuración faltante se dice solo a quien ya se identificó.
  if (!secretoIgual(req.headers.get("x-avisos-secret"), Deno.env.get("AVISOS_CRON_SECRET"))) {
    // Sin esta línea un secreto desparejado entre Vault y la función es invisible: pg_cron solo ve que el HTTP salió. Si NO aparece nunca y
    // los avisos no salen, falta --no-verify-jwt: el gateway rechaza antes de llegar aquí (ver «Avisos programados» en SPEC-wabid.md).
    console.warn("avisos: 401");
    return json({ error: "No autorizado" }, 401);
  }

  try {
    const db = adminClient();
    const { data, error } = await db.rpc("avisos_reclamar", { p_limite: LOTE });
    if (error) throw new Error(`reclamar: ${error.message}`);
    const avisos = (data ?? []) as AvisoReclamado[];

    const deps: Deps = {
      crearNotificacion: (userId, notice) => insertNotice(db, userId, notice),
      asentarNotificacion: async (avisoId, notificationId) => {
        const { error: e } = await db.rpc("avisos_asentar_notificacion", { p_id: avisoId, p_notification_id: notificationId });
        if (e) throw new Error(e.message);
      },
      enviarPush: (userId, notificationId, notice) => pushToDevices(db, userId, notificationId, notice),
      cerrar: async (avisoId, ok, detalle, notificationId) => {
        const { error: e } = await db.rpc("avisos_cerrar", { p_id: avisoId, p_ok: ok, p_detalle: detalle, p_notification_id: notificationId });
        if (e) throw new Error(e.message);
      },
    };
    const { enviados, reintentos } = await procesarLote(avisos, deps);
    // Una línea por pasada, sin contenido de los avisos.
    console.log(JSON.stringify({ evt: "avisos", reclamados: avisos.length, enviados, reintentos }));
    return json({ ok: true, reclamados: avisos.length, enviados, reintentos });
  } catch (e) {
    console.error("avisos:", e instanceof Error ? e.message : String(e));
    return json({ error: "No pude enviar los avisos." }, 500);
  }
});
