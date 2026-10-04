// Lógica pura del envío Web Push de Wabid: sin globals de Deno ni red, para probarla en Node.
// El envío real (WebCrypto + fetch) vive en webpush.ts; la orquestación, en notify.ts.

// Qué hacer con una suscripción según lo que respondió el push service.
//   ok        entregado al push service (2xx)
//   gone      la suscripción ya no existe: se borra (404 de FCM, 410 de RFC 8030)
//   transient el servicio falló o pidió esperar: se conserva y se reintenta en el próximo aviso
//   rejected  el servicio rechazó este envío (VAPID, formato, tamaño): se conserva y se cuenta como fallo
export type PushOutcome = "ok" | "gone" | "transient" | "rejected";

export function classifyPushStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "gone";
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return "transient";
  return "rejected";
}

// Fallos consecutivos de una suscripción: un envío bueno reinicia la cuenta, cualquier otro suma uno.
export function nextFailureCount(current: number, outcome: PushOutcome | "error"): number {
  return outcome === "ok" ? 0 : current + 1;
}

// ── base64url y claves VAPID ─────────────────────────────────────────────────

const BASE64URL = /^[A-Za-z0-9_-]*$/;

// base64url estricto (sin "+" ni "/"); acepta relleno "=" final y espacios en los extremos.
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const limpio = value.trim().replace(/=+$/, "");
  if (!BASE64URL.test(limpio) || limpio.length % 4 === 1) throw new Error("No es base64url válido");
  const binario = atob(limpio.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (limpio.length % 4)) % 4));
  return Uint8Array.from(binario, (c) => c.charCodeAt(0));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// El claim `sub` del JWT VAPID debe ser un mailto: o una URL https:// (RFC 8292); Apple rechaza otra cosa.
export function normalizeVapidSubject(subject: string): string {
  const s = subject.trim();
  return /^(mailto:|https:\/\/)/i.test(s) ? s : `mailto:${s}`;
}

export type EcJwk = { kty: "EC"; crv: "P-256"; x: string; y: string; d?: string };

// Las claves VAPID se guardan como secretos en el formato estándar de `web-push generate-vapid-keys`
// (y el que espera `applicationServerKey` en el navegador): público = punto P-256 sin comprimir
// (0x04 ‖ X ‖ Y, 65 bytes), privado = escalar de 32 bytes, ambos en base64url. WebCrypto los quiere en JWK.
export function vapidJwkFromRaw(publicKey: string, privateKey: string): { publicKey: EcJwk; privateKey: EcJwk } {
  const leer = (nombre: string, valor: string, largo: number): Uint8Array => {
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64Url(valor);
    } catch {
      throw new Error(`${nombre} no es base64url válido`);
    }
    if (bytes.length !== largo) throw new Error(`${nombre} debe tener ${largo} bytes en base64url (tiene ${bytes.length})`);
    return bytes;
  };
  const pub = leer("VAPID_PUBLIC_KEY", publicKey, 65);
  if (pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY debe ser un punto P-256 sin comprimir (empieza con 0x04)");
  const prv = leer("VAPID_PRIVATE_KEY", privateKey, 32);

  const x = encodeBase64Url(pub.subarray(1, 33));
  const y = encodeBase64Url(pub.subarray(33, 65));
  return {
    publicKey: { kty: "EC", crv: "P-256", x, y },
    privateKey: { kty: "EC", crv: "P-256", x, y, d: encodeBase64Url(prv) },
  };
}

// ── Suscripciones ────────────────────────────────────────────────────────────

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// Push services que usan Chrome/Edge/Brave/Opera/Samsung (FCM), Firefox, Edge (WNS) y Safari.
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];

export function isAllowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((sufijo) => host.endsWith(sufijo));
}

const ENDPOINT_MAX = 2048;

// Valida lo que manda el navegador (PushSubscription.toJSON()). El servidor hará POST al `endpoint`, así que
// solo se aceptan push services conocidos por HTTPS: de lo contrario un cliente podría apuntar el envío a una
// dirección interna (SSRF). Las claves deben ser las de RFC 8291: p256dh = punto P-256 (65 bytes), auth = 16 bytes.
export function parseSubscriptionInput(input: unknown): Parsed<PushSubscriptionInput> {
  const fallo = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return fallo("Suscripción inválida");
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: unknown };

  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > ENDPOINT_MAX) return fallo("Endpoint inválido");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fallo("Endpoint inválido");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "" || !isAllowedPushHost(url.hostname)) {
    return fallo("El endpoint no es de un servicio de notificaciones conocido");
  }

  if (!keys || typeof keys !== "object") return fallo("Faltan las claves de la suscripción");
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== "string" || typeof auth !== "string") return fallo("Faltan las claves de la suscripción");
  let clave: Uint8Array;
  let secreto: Uint8Array;
  try {
    clave = decodeBase64Url(p256dh);
    secreto = decodeBase64Url(auth);
  } catch {
    return fallo("Las claves de la suscripción no son base64url");
  }
  if (clave.length !== 65 || clave[0] !== 4) return fallo("Clave p256dh inválida");
  if (secreto.length !== 16) return fallo("Clave auth inválida");

  return { ok: true, value: { endpoint, p256dh: encodeBase64Url(clave), auth: encodeBase64Url(secreto) } };
}

// ── Payload ──────────────────────────────────────────────────────────────────

export type PushNotice = { id?: string | null; kind: string; title: string; body?: string | null; url?: string | null };

// Adonde lleva un aviso sin ruta propia: la bandeja.
export const DEFAULT_NOTICE_URL = "/avisos";

const TITLE_MAX = 120; // igual que la columna notifications.title
const BODY_MAX = 400;
const URL_MAX = 300; // igual que la columna notifications.url
const KIND_MAX = 30;

// Corta por caracteres Unicode, no por unidades UTF-16: así no parte un emoji por la mitad.
function clip(text: string, max: number, ellipsis: boolean): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return ellipsis ? chars.slice(0, max - 1).join("") + "…" : chars.slice(0, max).join("");
}

// Solo rutas internas ("/tareas?id=1"). Rechaza URLs absolutas, "//host", "/\host", "javascript:" y
// espacios o caracteres de control: lo que abre el service worker o navega la bandeja nunca debe sacar al
// usuario de la app, aunque un módulo arme la ruta con texto de un correo o de una reunión.
const APP_PATH = /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/;

export function isSafeAppPath(url: unknown): url is string {
  return typeof url === "string" && url.length > 0 && url.length <= URL_MAX && APP_PATH.test(url);
}

export function safeAppPath(url: string | null | undefined): string {
  const path = typeof url === "string" ? url.trim() : "";
  return isSafeAppPath(path) ? path : DEFAULT_NOTICE_URL;
}

// JSON que recibe el service worker (public/sw-push.js). Con título ≤ 120, cuerpo ≤ 400 y ruta ≤ 300
// caracteres el peor caso (4 bytes por carácter) queda muy por debajo de los 3993 bytes que permite RFC 8291.
export function buildPushPayload(notice: PushNotice, now: number = Date.now()): string {
  return JSON.stringify({
    v: 1,
    id: notice.id ?? null,
    kind: clip(notice.kind, KIND_MAX, false),
    title: clip(notice.title.trim(), TITLE_MAX, false),
    body: clip((notice.body ?? "").trim(), BODY_MAX, true),
    url: safeAppPath(notice.url),
    ts: now,
  });
}

// ── Entrega ──────────────────────────────────────────────────────────────────

export type PushUrgency = "very-low" | "low" | "normal" | "high";

// Cuánto esperar y con qué prioridad. `high` hace que Android entregue al instante aun en Doze (si no, un
// brief de las 7:00 puede llegar a las 8). La vigencia evita avisos viejos: un permiso de Claude Code que
// llega 20 minutos tarde ya no sirve, un brief a las 6 de la tarde tampoco.
export function pushPolicyFor(kind: string): { urgency: PushUrgency; ttl: number } {
  switch (kind) {
    case "claude":
    case "sistema":
      return { urgency: "high", ttl: 600 };
    case "brief":
      return { urgency: "high", ttl: 21_600 };
    case "agenda":
      return { urgency: "high", ttl: 7_200 };
    case "pago":
      return { urgency: "high", ttl: 86_400 };
    default:
      return { urgency: "normal", ttl: 86_400 };
  }
}

// Resultado de enviar a UN dispositivo. `error` = ni siquiera hubo respuesta HTTP (red, cifrado, tiempo agotado).
export type PushSendResult = { outcome: PushOutcome | "error"; status: number | null };

export type PushSummary = { devices: number; sent: number; removed: number; failed: number; statuses: Array<number | null> };

export const NO_PUSH: PushSummary = { devices: 0, sent: 0, removed: 0, failed: 0, statuses: [] };

export function summarizePush(results: PushSendResult[]): PushSummary {
  return {
    devices: results.length,
    sent: results.filter((r) => r.outcome === "ok").length,
    removed: results.filter((r) => r.outcome === "gone").length,
    failed: results.filter((r) => r.outcome !== "ok" && r.outcome !== "gone").length,
    statuses: results.map((r) => r.status),
  };
}
