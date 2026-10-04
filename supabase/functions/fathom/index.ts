// Módulo reuniones: caché de Fathom + esperas del vault. Solo para el dueño de Wabid.
// Acciones (POST JSON { action, ... }):
//   sync    {}                  trae reuniones de Fathom (continúa la corrida cortada) y avisa esperas > 3 días.
//                               Responde quedan=true si falta algo: el cliente vuelve a llamar.
//   list    { limite? }         reuniones guardadas (más recientes primero)
//   detail  { recording_id }    una reunión
//   esperas {}                  lo que David espera de otros (tareas del vault con #conjunto/<quien>)
// Secretos: FATHOM_API_KEY (Fathom), WABID_OWNER_ID (único usuario autorizado).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, json, preflight, requireUser } from "../_shared/http.ts";
import { notify } from "../_shared/notify.ts";
import { leerEsperas, leerReunion, leerReuniones } from "./data.ts";
import { avanzarPlan, type EstadoSync, hoyLima, parsePage, planSync, type Reunion, UMBRAL_VENCIDA_DIAS } from "./pure.ts";

const API = "https://api.fathom.ai/external/v1/meetings";
const MAX_PAGINAS = 5; // 10 reuniones por página: 50 por corrida
const PRESUPUESTO_MS = 100_000; // tope global de la corrida: la edge function muere hacia los 150 s
const FETCH_MS = 20_000;
const MAX_AVISOS = 5; // por corrida
const DIAS_INICIAL = 30;

class FathomError extends Error {}
class TiempoAgotado extends Error {}

/** GET a Fathom con un reintento en 429/5xx. `limite` = instante (ms) en que la corrida debe cortar. */
async function fathomGet(params: URLSearchParams, key: string, limite: number): Promise<unknown> {
  for (let intento = 0; ; intento++) {
    const queda = limite - Date.now();
    if (queda < 2000) throw new TiempoAgotado();
    let res: Response;
    try {
      res = await fetch(`${API}?${params}`, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(Math.min(FETCH_MS, queda)) });
    } catch {
      if (intento >= 1 || limite - Date.now() < 4000) throw new FathomError("No pude conectar con Fathom");
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (res.ok) return await res.json();
    if (res.status === 401 || res.status === 403) throw new FathomError("Fathom rechazó la API key");
    if ((res.status === 429 || res.status >= 500) && intento < 1) {
      const espera = Math.min(Number(res.headers.get("retry-after")) || 3, 10);
      if (Date.now() + espera * 1000 > limite) throw new TiempoAgotado();
      await new Promise((r) => setTimeout(r, espera * 1000));
      continue;
    }
    throw new FathomError(`Fathom respondió ${res.status}`);
  }
}

async function sync(db: SupabaseClient, userId: string) {
  const key = Deno.env.get("FATHOM_API_KEY");
  if (!key) return json({ error: "FATHOM_API_KEY no configurada" }, 500);

  const admin = adminClient();
  const limite = Date.now() + PRESUPUESTO_MS;

  // El punto de partida sale SIEMPRE del estado guardado en la base (nunca del cliente ni de la última reunión):
  // una corrida cortada se continúa donde quedó y complete_until no avanza hasta terminar.
  const { data: estado, error: errEstado } = await admin.from("fathom_sync_estado").select("*").eq("user_id", userId).maybeSingle();
  if (errEstado) return json({ error: "No pude leer el estado de sincronización" }, 500);
  let plan = planSync(estado as EstadoSync | null, Date.now(), DIAS_INICIAL);
  const guardarEstado = (campos: Record<string, string | null>) =>
    admin.from("fathom_sync_estado").upsert({ user_id: userId, ...campos, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  let cursor: string | null = null;
  let paginas = 0;
  let guardadas = 0;
  let nuevas = 0;
  let completa = false;
  let error: { msg: string; status: number } | null = null;
  const traidas: Reunion[] = [];

  try {
    while (true) {
      const params = new URLSearchParams({ created_after: plan.desde, include_summary: "true", include_action_items: "true" });
      if (plan.antes) params.set("created_before", plan.antes);
      if (cursor) params.set("cursor", cursor);
      const pagina = parsePage(await fathomGet(params, key, limite));
      paginas++;
      if (pagina.items.length) {
        const ids = pagina.items.map((r) => r.recording_id);
        const { data: previas } = await admin.from("fathom_meetings").select("recording_id").eq("user_id", userId).in("recording_id", ids);
        const yaEstaban = new Set((previas ?? []).map((p: { recording_id: number }) => Number(p.recording_id)));
        const { error: errUp } = await admin.from("fathom_meetings").upsert(
          pagina.items.map((r: Reunion) => ({ ...r, user_id: userId, synced_at: new Date().toISOString() })),
          { onConflict: "user_id,recording_id" },
        );
        if (errUp) {
          console.error("fathom upsert:", errUp.message);
          error = { msg: "No pude guardar las reuniones", status: 500 };
          break;
        }
        guardadas += pagina.items.length;
        nuevas += pagina.items.filter((r) => !yaEstaban.has(r.recording_id)).length;
        traidas.push(...pagina.items);
      }
      cursor = pagina.nextCursor;
      if (!cursor) { completa = true; break; }
      if (paginas >= MAX_PAGINAS) break;
    }
  } catch (e) {
    if (e instanceof TiempoAgotado) {
      // Corte limpio por tiempo: no es un error, la corrida queda pendiente (quedan = true).
    } else if (e instanceof FathomError) error = { msg: e.message, status: 502 };
    else {
      console.error("fathom sync:", e instanceof Error ? e.message : "error");
      error = { msg: "Falló la sincronización", status: 500 };
    }
  }

  // Solo una corrida completa mueve complete_until. Una cortada (tope, tiempo o error) guarda el punto de
  // continuación según lo ya guardado: las páginas traídas no se repiten ni se pierden.
  if (completa) {
    await guardarEstado({ complete_until: plan.objetivo, en_curso_desde: null, en_curso_antes: null, objetivo: null });
  } else {
    plan = avanzarPlan(plan, traidas);
    await guardarEstado({ en_curso_desde: plan.desde, en_curso_antes: plan.antes, objetivo: plan.objetivo });
  }

  // Los avisos no esperan a que la corrida termine: se avisa con lo ya sincronizado.
  const avisos = await avisarEsperas(db, admin, userId);
  if (error && !guardadas) return json({ error: error.msg }, error.status);
  return json({ ok: true, guardadas, nuevas, quedan: !completa, avisos, ...(error ? { aviso: error.msg } : {}) });
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
        return await sync(auth.db, auth.user.id);
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
