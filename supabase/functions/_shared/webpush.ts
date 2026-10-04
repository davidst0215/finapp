// Envío Web Push (RFC 8030/8291/8292) con VAPID desde el runtime de Supabase Edge (Deno).
//
// Librería: jsr:@negrel/webpush, pura Web API (SubtleCrypto + fetch) y dependencias solo de JSR; no necesita la
// capa de compatibilidad con Node que sí arrastra `npm:web-push` (https, crypto, asn1.js, jws…).
// La versión va fija: su README avisa que ningún experto en criptografía la ha revisado.
//
// Se importa de forma perezosa (import() dentro de getSender) para que, si la librería fallara al cargar,
// el error quede contenido en el push y no tumbe el arranque de las funciones que importan notify.ts.
//
// Secretos: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (ver scripts/generate-vapid-keys.mjs) y VAPID_SUBJECT.
import {
  classifyPushStatus,
  decodeBase64Url,
  encodeBase64Url,
  normalizeVapidSubject,
  type PushSendResult,
  type PushSubscriptionInput,
  type PushUrgency,
  vapidJwkFromRaw,
} from "./webpush-core.ts";

type Lib = typeof import("jsr:@negrel/webpush@0.5.0");
type Sender = { lib: Lib; server: InstanceType<Lib["ApplicationServer"]> };
type VapidConfig = { publicKey: string; privateKey: string; subject: string };

// Tiempo máximo por dispositivo: un push service lento no debe colgar al módulo que avisó.
const SEND_TIMEOUT_MS = 4_000;

function readVapidConfig(): VapidConfig | null {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY")?.trim();
  const subject = Deno.env.get("VAPID_SUBJECT")?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject: normalizeVapidSubject(subject) };
}

export const pushConfigured = (): boolean => readVapidConfig() !== null;

// Clave pública (la que el navegador necesita para suscribirse), normalizada a base64url sin relleno.
export function vapidPublicKey(): string | null {
  const config = readVapidConfig();
  if (!config) return null;
  try {
    return encodeBase64Url(decodeBase64Url(config.publicKey));
  } catch {
    return null;
  }
}

// Un par que no se corresponde firmaría JWT que el push service rechaza con 401/403 sin explicar por qué:
// se detecta al arrancar firmando y verificando una vez.
async function assertKeyPairMatches(keys: CryptoKeyPair): Promise<void> {
  const algo = { name: "ECDSA", hash: "SHA-256" };
  const data = new TextEncoder().encode("vapid-selfcheck");
  const signature = await crypto.subtle.sign(algo, keys.privateKey, data);
  if (!(await crypto.subtle.verify(algo, keys.publicKey, signature, data))) {
    throw new Error("VAPID_PRIVATE_KEY no corresponde a VAPID_PUBLIC_KEY");
  }
}

async function createSender(config: VapidConfig): Promise<Sender> {
  const lib = await import("jsr:@negrel/webpush@0.5.0");
  const vapidKeys = await lib.importVapidKeys(vapidJwkFromRaw(config.publicKey, config.privateKey), { extractable: false });
  await assertKeyPairMatches(vapidKeys);
  const server = await lib.ApplicationServer.new({ contactInformation: config.subject, vapidKeys });
  return { lib, server };
}

// Una sola instancia por isolate (genera su clave ECDH una vez). Si falla, se reintenta en el próximo envío.
let senderPromise: Promise<Sender> | null = null;

function getSender(): Promise<Sender> {
  const config = readVapidConfig();
  if (!config) return Promise.reject(new Error("VAPID no configurado"));
  senderPromise ??= createSender(config).catch((e) => {
    senderPromise = null;
    throw e;
  });
  return senderPromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tiempo agotado")), ms);
  });
  return Promise.race([promise, limite]).finally(() => clearTimeout(timer));
}

// Envía `payload` (texto) a un dispositivo. Nunca lanza: devuelve qué pasó para que el llamador decida
// si borrar la suscripción (gone), contarla como fallo o dejarla como está.
export async function sendPush(
  sub: PushSubscriptionInput,
  payload: string,
  policy: { urgency: PushUrgency; ttl: number },
): Promise<PushSendResult> {
  try {
    const { lib, server } = await getSender();
    const urgency = {
      "very-low": lib.Urgency.VeryLow,
      low: lib.Urgency.Low,
      normal: lib.Urgency.Normal,
      high: lib.Urgency.High,
    }[policy.urgency];
    const subscriber = server.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
    try {
      await withTimeout(subscriber.pushTextMessage(payload, { urgency, ttl: policy.ttl }), SEND_TIMEOUT_MS);
      return { outcome: "ok", status: 201 }; // RFC 8030: el push service acepta con 201 Created
    } catch (e) {
      if (!(e instanceof lib.PushMessageError)) throw e;
      // La librería solo trata 410 como "gone"; FCM también responde 404, así que se clasifica por el código.
      const status = e.response.status;
      const outcome = classifyPushStatus(status);
      if (outcome !== "gone") {
        // El cuerpo del error (p. ej. {"reason":"BadJwtToken"}) es lo que explica un 401/403; solo se lee para el log y
        // con tope de tiempo, para que un push service lento no retenga al módulo que avisó.
        const detalle = (await withTimeout(e.response.text(), 1_000).catch(() => "")).slice(0, 200);
        console.error(`push: rechazado ${status} (${outcome})`, detalle);
      } else {
        void e.response.body?.cancel().catch(() => {});
      }
      return { outcome, status };
    }
  } catch (e) {
    console.error("push:", e instanceof Error ? e.message : String(e));
    return { outcome: "error", status: null };
  }
}
