// Función `push`: avisos del celular. Suscripciones Web Push del dispositivo y bandeja de avisos.
//
// POST { action, ... } con el JWT del usuario:
//   vapid-key    -> { publicKey }                clave pública VAPID que el navegador necesita para suscribirse
//   subscribe    { subscription }                guarda este dispositivo (PushSubscription.toJSON())
//   unsubscribe  { endpoint }                    olvida este dispositivo
//   test                                         se manda un aviso de prueba a sí mismo (llega por push y a la bandeja)
//   inbox        { limit? }                      -> { items, unread }
//   read         { ids? } | { all: true }        marca avisos como leídos
//
// Secretos: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (scripts/generate-vapid-keys.mjs).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, json, preflight, requireUser } from "../_shared/http.ts";
import { notifyDetailed } from "../_shared/notify.ts";
import { decodeBase64Url, isSafeAppPath, parseSubscriptionInput } from "../_shared/webpush-core.ts";
import { pushConfigured, vapidPublicKey } from "../_shared/webpush.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dispositivos con avisos por usuario. Un celular, una laptop y alguna tablet; más que eso es una sesión rara,
// y cada dispositivo es un POST más a un push service en cada aviso.
const MAX_DEVICES = 10;

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("no es un objeto");
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Se esperaba un JSON con 'action'" }, 400);
  }

  try {
    switch (body.action) {
      case "vapid-key":
        return vapidKey();
      case "subscribe":
        return await subscribe(user.id, body.subscription, req.headers.get("user-agent"));
      case "unsubscribe":
        return await unsubscribe(user.id, body.endpoint);
      case "test":
        return await test(user.id);
      case "inbox":
        return await inbox(db, user.id, body.limit);
      case "read":
        return await read(db, user.id, body);
      default:
        return json({ error: "Acción desconocida" }, 400);
    }
  } catch (e) {
    console.error("push:", e instanceof Error ? e.message : String(e));
    return json({ error: "Error interno" }, 500);
  }
});

function vapidKey(): Response {
  const publicKey = vapidPublicKey();
  if (!publicKey) return json({ error: "Los avisos aún no están configurados en el servidor" }, 503);
  return json({ publicKey });
}

// RFC 8291 exige comprobar que la clave del navegador es un punto de la curva P-256. En Deno importKey("raw") no
// lo valida (falla recién al derivar), así que se deriva un secreto de prueba con un par efímero.
async function isOnCurve(rawPublicKey: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    const algo = { name: "ECDH", namedCurve: "P-256" };
    const publicKey = await crypto.subtle.importKey("raw", rawPublicKey, algo, false, []);
    const own = await crypto.subtle.generateKey(algo, false, ["deriveBits"]);
    await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, own.privateKey, 256);
    return true;
  } catch {
    return false;
  }
}

// Las suscripciones solo las escribe esta función (cliente de servicio) y solo tras validar que el endpoint sea
// un push service conocido: el servidor hará POST ahí. El user_id sale del JWT, nunca del cuerpo.
async function subscribe(userId: string, input: unknown, userAgent: string | null): Promise<Response> {
  const parsed = parseSubscriptionInput(input);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { endpoint, p256dh, auth } = parsed.value;

  if (!(await isOnCurve(decodeBase64Url(p256dh)))) return json({ error: "Clave p256dh inválida" }, 400);

  const db = adminClient();
  const { count, error: countError } = await db.from("push_subscriptions")
    .select("subscription_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("endpoint", endpoint); // volver a suscribir el mismo navegador no cuenta como un dispositivo nuevo
  if (countError) {
    console.error("push: subscribe (conteo):", countError.message);
    return json({ error: "No se pudo guardar la suscripción" }, 500);
  }
  if ((count ?? 0) >= MAX_DEVICES) {
    return json({ error: `Ya hay ${MAX_DEVICES} dispositivos con avisos activados. Desactiva alguno para agregar otro.` }, 409);
  }

  // El mismo navegador que vuelve a suscribirse repite endpoint: se actualiza en lugar de duplicar.
  const { error } = await db.from("push_subscriptions").upsert(
    { user_id: userId, endpoint, p256dh, auth, user_agent: userAgent?.slice(0, 300) || null, failures: 0 },
    { onConflict: "endpoint" },
  );
  if (error) {
    console.error("push: subscribe:", error.message);
    return json({ error: "No se pudo guardar la suscripción" }, 500);
  }
  return json({ ok: true });
}

async function unsubscribe(userId: string, endpoint: unknown): Promise<Response> {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 2048) {
    return json({ error: "Falta el endpoint" }, 400);
  }
  const { error } = await adminClient().from("push_subscriptions").delete().eq("user_id", userId).eq("endpoint", endpoint);
  if (error) {
    console.error("push: unsubscribe:", error.message);
    return json({ error: "No se pudo quitar la suscripción" }, 500);
  }
  return json({ ok: true });
}

async function test(userId: string): Promise<Response> {
  const result = await notifyDetailed(adminClient(), userId, {
    kind: "sistema",
    title: "Aviso de prueba",
    body: "Si lo estás leyendo, los avisos funcionan. Yo nunca lo dudé.",
    url: "/avisos",
  });
  if (!result.id) return json({ error: "No se pudo crear el aviso de prueba" }, 500);
  return json({ ok: true, id: result.id, configured: pushConfigured(), ...result.push });
}

async function inbox(db: SupabaseClient, userId: string, rawLimit: unknown): Promise<Response> {
  const limit = Math.min(Math.max(Math.trunc(Number(rawLimit)) || 50, 1), 100);
  const [list, unread] = await Promise.all([
    db.from("notifications")
      .select("notification_id, kind, title, body, url, created_at, read_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit),
    db.from("notifications").select("notification_id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null),
  ]);
  if (list.error || unread.error) {
    console.error("push: inbox:", list.error?.message ?? unread.error?.message);
    return json({ error: "No se pudo leer la bandeja" }, 500);
  }
  const items = (list.data ?? []).map((n) => ({
    id: n.notification_id as string,
    kind: n.kind as string,
    title: n.title as string,
    body: n.body as string,
    url: isSafeAppPath(n.url) ? n.url : null, // la bandeja solo navega dentro de la app
    createdAt: n.created_at as string,
    readAt: (n.read_at as string | null) ?? null,
  }));
  return json({ items, unread: unread.count ?? 0 });
}

async function read(db: SupabaseClient, userId: string, body: Record<string, unknown>): Promise<Response> {
  const todos = body.all === true;
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string" && UUID.test(id)).slice(0, 100)
    : [];
  if (!todos && ids.length === 0) return json({ error: "Indica qué avisos marcar como leídos" }, 400);

  let query = db.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId).is("read_at", null);
  if (!todos) query = query.in("notification_id", ids);
  const { data, error } = await query.select("notification_id");
  if (error) {
    console.error("push: read:", error.message);
    return json({ error: "No se pudo marcar como leído" }, 500);
  }
  return json({ ok: true, updated: data?.length ?? 0 });
}
