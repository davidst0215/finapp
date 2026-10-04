// Módulo reuniones: caché de Fathom + esperas del vault. Solo para el dueño de Wabid.
// Acciones (POST JSON { action, ... }):
//   sync    { antes?, desde? }  trae reuniones nuevas de Fathom y las guarda; avisa esperas > 3 días
//   list    { limite? }         reuniones guardadas (más recientes primero)
//   detail  { recording_id }    una reunión
//   esperas {}                  lo que David espera de otros (tareas del vault con #conjunto/<quien>)
// Secretos: FATHOM_API_KEY (Fathom), WABID_OWNER_ID (único usuario autorizado).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, json, preflight, requireUser } from "../_shared/http.ts";
import { notify } from "../_shared/notify.ts";
import { leerEsperas, leerReunion, leerReuniones } from "./data.ts";
import { desdeSync, hoyLima, parsePage, type Reunion, UMBRAL_VENCIDA_DIAS } from "./pure.ts";

const API = "https://api.fathom.ai/external/v1/meetings";
const MAX_PAGINAS = 8; // 10 reuniones por página: 80 por corrida; si quedan más, el cliente repite con `antes`
const MAX_AVISOS = 5; // por corrida
const DIAS_INICIAL = 30;

class FathomError extends Error {}

/** GET a Fathom con un reintento en 429/5xx. Nunca incluye la key ni el cuerpo de la respuesta en el error. */
async function fathomGet(params: URLSearchParams, key: string): Promise<unknown> {
  for (let intento = 0; ; intento++) {
    let res: Response;
    try {
      res = await fetch(`${API}?${params}`, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(20000) });
    } catch {
      if (intento >= 1) throw new FathomError("No pude conectar con Fathom");
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (res.ok) return await res.json();
    if (res.status === 401 || res.status === 403) throw new FathomError("Fathom rechazó la API key");
    if ((res.status === 429 || res.status >= 500) && intento < 1) {
      const espera = Math.min(Number(res.headers.get("retry-after")) || 3, 10);
      await new Promise((r) => setTimeout(r, espera * 1000));
      continue;
    }
    throw new FathomError(`Fathom respondió ${res.status}`);
  }
}

const isoOpcional = (v: unknown): string | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;

async function sync(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const key = Deno.env.get("FATHOM_API_KEY");
  if (!key) return json({ error: "FATHOM_API_KEY no configurada" }, 500);

  const admin = adminClient();
  // `desde` y `antes` llegan solo al continuar una corrida cortada por el tope: así se recorre el hueco sin perder reuniones.
  let desde = isoOpcional(body.desde);
  const antes = isoOpcional(body.antes);
  if (!desde) {
    const { data, error } = await db.from("fathom_meetings").select("creada_en").order("creada_en", { ascending: false }).limit(1);
    if (error) return json({ error: "No pude leer la caché de reuniones" }, 500);
    desde = desdeSync(data?.[0]?.creada_en ?? null, Date.now(), DIAS_INICIAL);
  }

  let cursor: string | null = null;
  let paginas = 0;
  let guardadas = 0;
  let nuevas = 0;
  let masAntigua: string | null = null;
  let quedan = false;

  try {
    do {
      const params = new URLSearchParams({ created_after: desde, include_summary: "true", include_action_items: "true" });
      if (antes) params.set("created_before", antes);
      if (cursor) params.set("cursor", cursor);
      const pagina = parsePage(await fathomGet(params, key));
      paginas++;
      if (pagina.items.length) {
        const ids = pagina.items.map((r) => r.recording_id);
        const { data: previas } = await admin.from("fathom_meetings").select("recording_id").eq("user_id", userId).in("recording_id", ids);
        const yaEstaban = new Set((previas ?? []).map((p: { recording_id: number }) => Number(p.recording_id)));
        const { error } = await admin.from("fathom_meetings").upsert(
          pagina.items.map((r: Reunion) => ({ ...r, user_id: userId, synced_at: new Date().toISOString() })),
          { onConflict: "user_id,recording_id" },
        );
        if (error) {
          console.error("fathom upsert:", error.message);
          return json({ error: "No pude guardar las reuniones" }, 500);
        }
        guardadas += pagina.items.length;
        nuevas += pagina.items.filter((r) => !yaEstaban.has(r.recording_id)).length;
        for (const r of pagina.items) if (!masAntigua || r.creada_en < masAntigua) masAntigua = r.creada_en;
      }
      cursor = pagina.nextCursor;
      if (cursor && paginas >= MAX_PAGINAS) quedan = true;
    } while (cursor && !quedan);
  } catch (e) {
    if (e instanceof FathomError) return json({ error: e.message }, 502);
    console.error("fathom sync:", e instanceof Error ? e.message : "error");
    return json({ error: "Falló la sincronización" }, 500);
  }

  // Los avisos esperan a que la corrida termine: con reuniones pendientes aún no se sabe el panorama completo.
  const avisos = quedan ? 0 : await avisarEsperas(db, admin, userId);
  return json({ ok: true, guardadas, nuevas, quedan, desde, antes: quedan ? masAntigua : null, avisos });
}

/** Una notificación por espera que pasa de 3 días, una sola vez (fathom_avisos). Devuelve cuántas envió. */
async function avisarEsperas(db: SupabaseClient, admin: SupabaseClient, userId: string): Promise<number> {
  const res = await leerEsperas(db, hoyLima());
  if (!res.ok) return 0;
  const vencidas = res.esperas.filter((e) => e.vencida);
  if (!vencidas.length) return 0;

  const { data: previos, error } = await admin.from("fathom_avisos").select("clave").eq("user_id", userId).in("clave", vencidas.map((e) => e.clave));
  if (error) return 0;
  const avisadas = new Set((previos ?? []).map((p: { clave: string }) => p.clave));

  let enviados = 0;
  for (const e of vencidas.filter((v) => !avisadas.has(v.clave)).slice(0, MAX_AVISOS)) {
    // Primero se reserva la clave y solo quien la reservó avisa: dos sincronizaciones a la vez no duplican.
    const { data: reservada } = await admin.from("fathom_avisos")
      .upsert({ user_id: userId, clave: e.clave }, { onConflict: "user_id,clave", ignoreDuplicates: true }).select("clave");
    if (!reservada?.length) continue;
    const id = await notify(admin, userId, {
      kind: "espera",
      title: `Espera de ${e.quien}: ${e.dias} días`,
      body: e.texto,
      url: "/reuniones",
    });
    if (id) enviados++;
    else await admin.from("fathom_avisos").delete().eq("user_id", userId).eq("clave", e.clave); // que se reintente en la próxima
  }
  return enviados;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const owner = Deno.env.get("WABID_OWNER_ID");
  if (!owner) return json({ error: "WABID_OWNER_ID no configurado" }, 500);
  if (auth.user.id !== owner) return json({ error: "No autorizado" }, 403);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.action !== "string") return json({ error: "Falta 'action'" }, 400);

  try {
    switch (body.action) {
      case "sync":
        return await sync(auth.db, auth.user.id, body);
      case "list": {
        const limite = Math.min(Math.max(Number(body.limite) || 30, 1), 100);
        return json({ ok: true, reuniones: await leerReuniones(auth.db, limite) });
      }
      case "detail": {
        const id = Number(body.recording_id);
        if (!Number.isSafeInteger(id)) return json({ error: "recording_id inválido" }, 400);
        const r = await leerReunion(auth.db, id);
        return r ? json({ ok: true, reunion: r }) : json({ error: "Reunión no encontrada" }, 404);
      }
      case "esperas": {
        const hoy = hoyLima();
        const res = await leerEsperas(auth.db, hoy);
        return json({ ...res, hoy, umbral: UMBRAL_VENCIDA_DIAS });
      }
      default:
        return json({ error: "Acción desconocida" }, 400);
    }
  } catch (e) {
    console.error("fathom:", e instanceof Error ? e.message : "error");
    return json({ error: "Error interno" }, 500);
  }
});
