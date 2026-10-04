// OAuth 2.0 de Google para aplicaciones web de servidor: URL de autorización, cambio de código por
// tokens, renovación y revocación. Lógica pura (sin Deno): el `fetch` se inyecta.
// Formatos verificados en https://developers.google.com/identity/protocols/oauth2/web-server
import { base64UrlToUtf8 } from "./b64.ts";
import { type Fetcher, GoogleTokenError, type Need } from "./errors.ts";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.events";
export const SCOPE_GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

// Fijos en el servidor: el cliente NUNCA decide qué permisos se piden.
export const GOOGLE_SCOPES = ["openid", "email", SCOPE_CALENDAR, SCOPE_GMAIL_READ, SCOPE_GMAIL_COMPOSE] as const;

const SCOPE_OF: Record<Need, string> = {
  calendar: SCOPE_CALENDAR,
  gmail_read: SCOPE_GMAIL_READ,
  gmail_compose: SCOPE_GMAIL_COMPOSE,
};

export type Capabilities = Record<Need, boolean>;

export const capabilitiesOf = (scopes: readonly string[]): Capabilities => ({
  calendar: scopes.includes(SCOPE_CALENDAR),
  gmail_read: scopes.includes(SCOPE_GMAIL_READ),
  gmail_compose: scopes.includes(SCOPE_GMAIL_COMPOSE),
});

export const hasScope = (scopes: readonly string[], need: Need) => scopes.includes(SCOPE_OF[need]);

// Google devuelve los permisos concedidos como texto separado por espacios.
export const parseScopes = (scope: unknown): string[] =>
  typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; loginHint?: string }): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline"); // para recibir refresh_token
  u.searchParams.set("prompt", "consent"); // fuerza un refresh_token nuevo aunque ya haya autorizado antes
  u.searchParams.set("state", p.state);
  if (p.loginHint && /^[^\s@]+@[^\s@]+$/.test(p.loginHint)) u.searchParams.set("login_hint", p.loginHint);
  return u.toString();
}

// ---------------------------------------------------------------- tokens

export type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
};

async function tokenCall(f: Fetcher, body: Record<string, string>): Promise<TokenResponse> {
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  let json: Record<string, unknown> = {};
  try {
    json = await res.json();
  } catch { /* cuerpo vacío o no JSON */ }
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : "desconocido";
    // error_description es de Google (no contiene secretos); se recorta por prolijidad.
    const desc = typeof json.error_description === "string" ? json.error_description.slice(0, 200) : res.statusText;
    throw new GoogleTokenError(res.status, code, desc);
  }
  if (typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
    throw new GoogleTokenError(502, "respuesta_invalida", "Google devolvió una respuesta de tokens incompleta");
  }
  return {
    access_token: json.access_token,
    expires_in: json.expires_in,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    scope: typeof json.scope === "string" ? json.scope : "",
    id_token: typeof json.id_token === "string" ? json.id_token : undefined,
  };
}

export const exchangeCode = (
  f: Fetcher,
  p: { clientId: string; clientSecret: string; redirectUri: string; code: string },
) =>
  tokenCall(f, {
    code: p.code,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: p.redirectUri,
    grant_type: "authorization_code",
  });

export const refreshAccessToken = (f: Fetcher, p: { clientId: string; clientSecret: string; refreshToken: string }) =>
  tokenCall(f, {
    client_id: p.clientId,
    client_secret: p.clientSecret,
    refresh_token: p.refreshToken,
    grant_type: "refresh_token",
  });

// Revoca el token (refresh o access) en Google. Devuelve si Google respondió 200.
export async function revokeToken(f: Fetcher, token: string): Promise<boolean> {
  const res = await f(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  return res.ok;
}

// ---------------------------------------------------------------- id_token

export type GoogleIdentity = { sub: string; email: string; emailVerified: boolean };

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// El id_token llega directo del endpoint de tokens por TLS, así que no hace falta verificar su firma
// (OpenID Connect Core 3.1.3.7). Sí se comprueba a quién se emitió y quién lo emitió.
export function decodeIdToken(idToken: string, clientId: string): GoogleIdentity | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const text = base64UrlToUtf8(parts[1] as string);
  if (text === null) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(text);
  } catch {
    return null;
  }
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.includes(clientId) || typeof p.iss !== "string" || !ISSUERS.includes(p.iss)) return null;
  if (typeof p.sub !== "string" || p.sub === "" || typeof p.email !== "string" || p.email === "") return null;
  return { sub: p.sub, email: p.email, emailVerified: p.email_verified === true };
}

// ---------------------------------------------------------------- paquete guardado en Vault

export type TokenBundle = {
  refresh_token: string;
  access_token?: string;
  access_expires_at?: string; // ISO
};

export const serializeBundle = (b: TokenBundle) => JSON.stringify(b);

export function parseBundle(text: string | null): TokenBundle | null {
  if (!text) return null;
  try {
    const b = JSON.parse(text);
    if (!b || typeof b.refresh_token !== "string" || b.refresh_token === "") return null;
    return {
      refresh_token: b.refresh_token,
      access_token: typeof b.access_token === "string" ? b.access_token : undefined,
      access_expires_at: typeof b.access_expires_at === "string" ? b.access_expires_at : undefined,
    };
  } catch {
    return null;
  }
}

// ¿Sigue vigente el access_token guardado? Se renueva 60 s antes de vencer para no fallar a mitad de una llamada.
export function accessTokenUsable(b: TokenBundle, nowMs: number, skewMs = 60_000): boolean {
  if (!b.access_token || !b.access_expires_at) return false;
  const exp = Date.parse(b.access_expires_at);
  return Number.isFinite(exp) && exp - nowMs > skewMs;
}
