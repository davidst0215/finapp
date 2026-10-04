// Estado firmado del flujo OAuth de Google. `start` lo crea, `callback` (público) lo verifica.
// Sin base de datos: HMAC-SHA256 con GOOGLE_STATE_SECRET sobre {user_id, nonce, vencimiento}.
// Un `state` válido prueba que el flujo lo inició un usuario autenticado de Wabid hace pocos minutos.
import { base64UrlToBytes, base64UrlToUtf8, bytesToBase64Url, utf8ToBase64Url } from "./b64.ts";

export const STATE_TTL_SECONDS = 600; // 10 min: da tiempo a la pantalla de consentimiento y al 2FA
export const MIN_SECRET_LENGTH = 32;

// Separación de dominio: una firma de este módulo no sirve para ningún otro uso del mismo secreto.
const CONTEXT = "wabid.google-oauth.v1";
const MAX_STATE_LENGTH = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export type StateCheck =
  | { ok: true; userId: string; nonce: string }
  | { ok: false; reason: "formato" | "firma" | "vencido" };

type Payload = { v: 1; uid: string; n: string; exp: number };

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const signingInput = (payloadB64: string) => new TextEncoder().encode(`${CONTEXT}.${payloadB64}`);

export function randomNonce(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function signState(
  secret: string,
  userId: string,
  nowMs: number,
  opts: { ttlSeconds?: number; nonce?: string } = {},
): Promise<string> {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("GOOGLE_STATE_SECRET demasiado corto");
  if (!UUID.test(userId)) throw new Error("user_id inválido");
  const payload: Payload = {
    v: 1,
    uid: userId.toLowerCase(),
    n: opts.nonce ?? randomNonce(),
    exp: Math.floor(nowMs / 1000) + (opts.ttlSeconds ?? STATE_TTL_SECONDS),
  };
  const payloadB64 = utf8ToBase64Url(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), signingInput(payloadB64)));
  return `${payloadB64}.${bytesToBase64Url(sig)}`;
}

export async function verifyState(secret: string, state: unknown, nowMs: number): Promise<StateCheck> {
  if (typeof state !== "string" || state.length === 0 || state.length > MAX_STATE_LENGTH) return { ok: false, reason: "formato" };
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "formato" };
  const [payloadB64, sigB64] = parts as [string, string];
  const sig = base64UrlToBytes(sigB64);
  if (!sig || sig.length === 0 || payloadB64.length === 0) return { ok: false, reason: "formato" };

  // La firma se comprueba ANTES de interpretar el contenido. `verify` compara en tiempo constante.
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, signingInput(payloadB64));
  if (!valid) return { ok: false, reason: "firma" };

  const text = base64UrlToUtf8(payloadB64);
  if (text === null) return { ok: false, reason: "formato" };
  let p: Partial<Payload>;
  try {
    p = JSON.parse(text);
  } catch {
    return { ok: false, reason: "formato" };
  }
  if (!p || p.v !== 1 || typeof p.uid !== "string" || !UUID.test(p.uid) || typeof p.n !== "string" || !NONCE.test(p.n) ||
    typeof p.exp !== "number" || !Number.isFinite(p.exp)) {
    return { ok: false, reason: "formato" };
  }
  if (p.exp * 1000 <= nowMs) return { ok: false, reason: "vencido" };
  return { ok: true, userId: p.uid, nonce: p.n };
}
