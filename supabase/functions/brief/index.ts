// Brief de las 7:00 de Wabid.
//   * Cron (pg_cron -> pg_net, 12:00 UTC = 7:00 Lima): header `x-brief-secret` igual a BRIEF_CRON_SECRET.
//     Genera el brief del dueño (idempotente) y avisa por push una sola vez.
//   * UI (JWT del dueño): { action: "latest" } último brief · { action: "generate" } genera el de hoy si falta.
// Se despliega con verify_jwt=false porque la llama pg_cron; cada camino valida lo suyo.
// Secretos: BRIEF_CRON_SECRET, WABID_OWNER_ID (UUID de David en Auth).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, json, preflight, requireUser } from "../_shared/http.ts";
import { notify } from "../_shared/notify.ts";
import { limaDateKey } from "../_shared/google/time.ts";
import { generarBrief } from "./generate.ts";
import { secretoIgual } from "./logic.ts";

const cuerpo = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
};

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const ownerId = Deno.env.get("WABID_OWNER_ID");
    if (!ownerId) return json({ error: "Falta configurar WABID_OWNER_ID" }, 503);

    // --- Cron
    const secreto = req.headers.get("x-brief-secret");
    if (secreto !== null) {
      if (!secretoIgual(secreto, Deno.env.get("BRIEF_CRON_SECRET"))) return json({ error: "No autorizado" }, 401);
      const db = adminClient();
      const { brief, creado } = await generarBrief(db, ownerId, "cron");
      if (creado) {
        await notify(db, ownerId, { kind: "brief", title: brief.secciones.titulo, body: brief.texto, url: "/brief" });
      }
      return json({ ok: true, fecha: brief.fecha, creado });
    }

    // --- UI: solo el dueño
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;
    if (auth.user.id !== ownerId) return json({ error: "No autorizado" }, 403);

    const { action } = await cuerpo(req);
    if (action === "latest") {
      const { data, error } = await auth.db.from("briefs").select("fecha, texto, secciones, creado, origen")
        .eq("user_id", auth.user.id).order("fecha", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return json({ brief: data, hoy: limaDateKey(new Date()) });
    }
    if (action === "generate") {
      const { brief, creado } = await generarBrief(adminClient(), auth.user.id, "manual");
      return json({ brief, creado });
    }
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    console.error("brief:", e instanceof Error ? e.message : String(e));
    return json({ error: "No pude armar el brief. Intenta de nuevo." }, 500);
  }
});
