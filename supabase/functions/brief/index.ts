// Brief de las 7:00 de Wabid.
//   * Cron (pg_cron -> pg_net, 12:00 UTC = 7:00 Lima): header `x-brief-secret` igual a BRIEF_CRON_SECRET.
//     Genera el brief del dueño (idempotente) y avisa por push una sola vez (columna `notificado`).
//   * UI (JWT del dueño): { action: "latest" } último brief · { action: "generate", force?: true }
//     genera el de hoy si falta (antes de las 7:00 es solo una vista previa); `force` lo regenera.
// Se despliega con verify_jwt=false porque la llama pg_cron; cada camino valida lo suyo.
// Secretos: BRIEF_CRON_SECRET, WABID_OWNER_ID (UUID de David en Auth).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, json, preflight, requireUser } from "../_shared/http.ts";
import { limaDateKey } from "../_shared/google/time.ts";
import { notify } from "../_shared/notify.ts";
import { avisarSiFalta, generarBrief } from "./generate.ts";
import { secretoIgual } from "./logic.ts";

const cuerpo = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
};

const sinDueno = () => json({ error: "Falta configurar WABID_OWNER_ID" }, 503);

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const ownerId = Deno.env.get("WABID_OWNER_ID");

    // --- Cron (primero se valida el secreto; la configuración faltante se dice solo a quien ya se identificó)
    const secreto = req.headers.get("x-brief-secret");
    if (secreto !== null) {
      if (!secretoIgual(secreto, Deno.env.get("BRIEF_CRON_SECRET"))) return json({ error: "No autorizado" }, 401);
      if (!ownerId) return sinDueno();
      const db = adminClient();
      const { brief, persistido } = await generarBrief(db, ownerId, "cron");
      let avisado: boolean;
      if (persistido) {
        // También avisa si el brief lo había armado el botón de la web antes del cron.
        avisado = await avisarSiFalta(db, ownerId, brief, "cron");
      } else {
        // Una fuente cayó y no se guardó: igual se avisa a las 7:00 (abrirlo en la app permite completarlo).
        avisado = (await notify(db, ownerId, { kind: "brief", title: brief.secciones.titulo, body: brief.texto, url: "/brief" })) !== null;
      }
      return json({ ok: true, fecha: brief.fecha, persistido, avisado });
    }

    // --- UI: solo el dueño
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;
    if (!ownerId) return sinDueno();
    if (auth.user.id !== ownerId) return json({ error: "No autorizado" }, 403);

    const { action, force } = await cuerpo(req);
    if (action === "latest") {
      const { data, error } = await auth.db.from("briefs").select("fecha, texto, secciones, creado, origen, notificado")
        .eq("user_id", auth.user.id).order("fecha", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return json({ brief: data, hoy: limaDateKey(new Date()) });
    }
    if (action === "generate") {
      const db = adminClient();
      const { brief, persistido } = await generarBrief(db, auth.user.id, "manual", { force: force === true });
      // Reintenta un aviso del cron que no se pudo registrar.
      if (persistido) await avisarSiFalta(db, auth.user.id, brief, "ui");
      return json({ brief, persistido });
    }
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    console.error("brief:", e instanceof Error ? e.message : String(e));
    return json({ error: "No pude armar el brief. Intenta de nuevo." }, 500);
  }
});
