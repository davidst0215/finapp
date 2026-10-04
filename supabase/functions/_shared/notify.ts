// Contrato único para avisar a David desde cualquier módulo.
// Deja el aviso en la bandeja (tabla notifications) y lo envía como Web Push a los dispositivos que activaron
// avisos (módulo `avisos`, tabla push_subscriptions). Quien avisa no se entera del push: la firma de notify() no cambia.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  buildPushPayload,
  nextFailureCount,
  NO_PUSH,
  parseSubscriptionInput,
  type PushSendResult,
  type PushSummary,
  pushPolicyFor,
  summarizePush,
} from "./webpush-core.ts";
import { pushConfigured, sendPush } from "./webpush.ts";

export type NotificationKind = "brief" | "pago" | "tarea" | "espera" | "agenda" | "correo" | "claude" | "sistema";

export type Notice = { kind: NotificationKind; title: string; body?: string; url?: string };

// `db` debe ser el cliente de servicio (adminClient): la tabla no permite inserts desde el cliente.
export async function notify(db: SupabaseClient, userId: string, notice: Notice): Promise<string | null> {
  return (await notifyDetailed(db, userId, notice)).id;
}

export type NotifyResult = { id: string | null; push: PushSummary };

// Igual que notify(), pero además informa qué pasó con el push (lo usa la acción `test` de la función push).
// Espera a que el push service responda (tope de 8 s por dispositivo): las edge functions pueden cortar el
// trabajo pendiente en cuanto devuelven la respuesta. Un fallo de push nunca lanza ni cambia el resultado.
export async function notifyDetailed(db: SupabaseClient, userId: string, notice: Notice): Promise<NotifyResult> {
  const { data, error } = await db.from("notifications").insert({
    user_id: userId,
    kind: notice.kind,
    title: notice.title.slice(0, 120),
    body: notice.body ?? "",
    url: notice.url ?? null,
  }).select("notification_id").single();
  if (error) {
    console.error("notify:", error.message);
    return { id: null, push: NO_PUSH };
  }
  const id = data.notification_id as string;
  return { id, push: await pushToDevices(db, userId, id, notice) };
}

type SubscriptionRow = { subscription_id: string; endpoint: string; p256dh: string; auth: string; failures: number };
type DbWrite = PromiseLike<{ error: { message: string } | null }>;

async function pushToDevices(db: SupabaseClient, userId: string, notificationId: string, notice: Notice): Promise<PushSummary> {
  try {
    if (!pushConfigured()) return NO_PUSH; // aún sin claves VAPID: el aviso queda solo en la bandeja

    const { data, error } = await db.from("push_subscriptions")
      .select("subscription_id, endpoint, p256dh, auth, failures")
      .eq("user_id", userId);
    if (error) {
      console.error("push: leer suscripciones:", error.message);
      return NO_PUSH;
    }
    const subs = (data ?? []) as SubscriptionRow[];
    if (subs.length === 0) return NO_PUSH;

    const payload = buildPushPayload({ id: notificationId, ...notice });
    const policy = pushPolicyFor(notice.kind);
    const results: PushSendResult[] = await Promise.all(subs.map((sub) => {
      // Defensa en profundidad: aunque la tabla solo la escribe la función push, no se hace POST a un endpoint
      // que no sea un push service conocido.
      const valida = parseSubscriptionInput({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
      if (!valida.ok) {
        console.error(`push: suscripción ${sub.subscription_id} inválida (${valida.error}), no se envía`);
        return Promise.resolve<PushSendResult>({ outcome: "error", status: null });
      }
      return sendPush(valida.value, payload, policy);
    }));

    await recordResults(db, notificationId, subs, results);
    return summarizePush(results);
  } catch (e) {
    console.error("push:", e instanceof Error ? e.message : String(e));
    return NO_PUSH;
  }
}

// Deja constancia: envíos buenos (último ok, fallos a cero, pushed_at del aviso), suscripciones caducadas
// (404/410: se borran) y fallos (se cuentan; la suscripción se conserva).
async function recordResults(db: SupabaseClient, notificationId: string, subs: SubscriptionRow[], results: PushSendResult[]) {
  const now = new Date().toISOString();
  const entregadas: string[] = [];
  const caducadas: string[] = [];
  const escrituras: DbWrite[] = [];

  results.forEach((result, i) => {
    const sub = subs[i]!;
    if (result.outcome === "ok") entregadas.push(sub.subscription_id);
    else if (result.outcome === "gone") caducadas.push(sub.subscription_id);
    else {
      escrituras.push(
        db.from("push_subscriptions").update({ failures: nextFailureCount(sub.failures, result.outcome) }).eq("subscription_id", sub.subscription_id),
      );
    }
  });
  if (entregadas.length > 0) {
    escrituras.push(db.from("push_subscriptions").update({ last_ok_at: now, failures: 0 }).in("subscription_id", entregadas));
    escrituras.push(db.from("notifications").update({ pushed_at: now }).eq("notification_id", notificationId));
  }
  if (caducadas.length > 0) escrituras.push(db.from("push_subscriptions").delete().in("subscription_id", caducadas));

  for (const escritura of await Promise.allSettled(escrituras)) {
    if (escritura.status === "rejected") console.error("push: registrar resultado:", escritura.reason);
    else if (escritura.value.error) console.error("push: registrar resultado:", escritura.value.error.message);
  }
}
