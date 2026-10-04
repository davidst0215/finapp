// Segundo flujo OAuth de Google, independiente del login de Supabase: da acceso a Calendar y Gmail.
//
//   POST /google-oauth/start     (JWT de David)  → { url } para mandarlo a la pantalla de consentimiento
//   GET  /google-oauth/callback  (público: lo llama Google) → guarda tokens cifrados y redirige a la app
//
// Despliegue: `supabase functions deploy google-oauth --no-verify-jwt` (Google no manda JWT al callback).
// `start` valida el JWT por su cuenta con requireUser; `callback` se protege con el `state` firmado.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { json, preflight, requireUser } from "../_shared/http.ts";
import { type GoogleEnv, googleEnv, saveConnection } from "../_shared/google.ts";
import { buildAuthUrl, capabilitiesOf, decodeIdToken, exchangeCode, parseScopes } from "../_shared/google/auth.ts";
import { describeError, GoogleConfigError, GoogleTokenError } from "../_shared/google/errors.ts";
import { signState, verifyState } from "../_shared/google/state.ts";

const DEFAULT_APP_URL = "https://myfinai.vercel.app";

// Última parte de la ruta: dentro de la función el pathname incluye su nombre (/google-oauth/callback).
const routeOf = (req: Request) => new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";

// Vuelve a la app. El destino es fijo (APP_URL) y `motivo` es un código corto: la app lo traduce a un mensaje.
function backToApp(appUrl: string, google: "conectado" | "error", motivo?: string): Response {
  const to = new URL("/agenda", appUrl);
  to.searchParams.set("google", google);
  if (motivo) to.searchParams.set("motivo", motivo);
  return new Response(null, {
    status: 302,
    headers: { Location: to.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

async function start(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let env: GoogleEnv;
  try {
    env = googleEnv();
  } catch (e) {
    const d = describeError(e);
    return json({ error: d.message, code: d.code, missing: d.data?.missing }, d.status);
  }

  const body = await req.json().catch(() => ({}));
  const loginHint = typeof body?.login_hint === "string" ? body.login_hint.slice(0, 254) : undefined;
  // El user_id sale del JWT validado, jamás del cuerpo. Los permisos los fija el servidor (GOOGLE_SCOPES).
  const state = await signState(env.stateSecret, auth.user.id, Date.now());
  return json({ url: buildAuthUrl({ clientId: env.clientId, redirectUri: env.redirectUri, state, loginHint }) });
}

async function callback(req: Request): Promise<Response> {
  let env: GoogleEnv;
  try {
    env = googleEnv();
  } catch (e) {
    console.error("google-oauth callback:", e instanceof GoogleConfigError ? e.message : "configuración");
    return backToApp((Deno.env.get("APP_URL") ?? DEFAULT_APP_URL).replace(/\/+$/, ""), "error", "config");
  }
  const url = new URL(req.url);

  // El usuario canceló o Google rechazó la solicitud.
  const googleError = url.searchParams.get("error");
  if (googleError) return backToApp(env.appUrl, "error", googleError === "access_denied" ? "denegado" : "google");

  // Sin un `state` firmado, vigente y emitido por nosotros no se hace nada más.
  const state = await verifyState(env.stateSecret, url.searchParams.get("state"), Date.now());
  if (!state.ok) {
    console.error("google-oauth callback: state", state.reason);
    return backToApp(env.appUrl, "error", "estado");
  }

  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return backToApp(env.appUrl, "error", "sin_codigo");

  try {
    const tok = await exchangeCode(fetch, { clientId: env.clientId, clientSecret: env.clientSecret, redirectUri: env.redirectUri, code });

    const identity = tok.id_token ? decodeIdToken(tok.id_token, env.clientId) : null;
    if (!identity || !identity.emailVerified) return backToApp(env.appUrl, "error", "sin_cuenta");

    // Google deja desmarcar permisos: si no concedió ninguno de los de datos, no se guarda nada.
    const caps = capabilitiesOf(parseScopes(tok.scope));
    if (!caps.calendar && !caps.gmail_read && !caps.gmail_compose) return backToApp(env.appUrl, "error", "permisos");
    if (!tok.refresh_token) return backToApp(env.appUrl, "error", "sin_refresh");

    await saveConnection(state.userId, identity, tok);
    return backToApp(env.appUrl, "conectado");
  } catch (e) {
    if (e instanceof GoogleTokenError) {
      console.error("google-oauth callback: token", e.status, e.code); // sin el cuerpo: podría traer datos de la cuenta
      return backToApp(env.appUrl, "error", "intercambio");
    }
    console.error("google-oauth callback:", e instanceof Error ? e.message : "error");
    return backToApp(env.appUrl, "error", "guardado");
  }
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const route = routeOf(req);
    if (route === "start" && req.method === "POST") return await start(req);
    if (route === "callback" && req.method === "GET") return await callback(req);
    return json({ error: "No encontrado" }, 404);
  } catch (e) {
    console.error("google-oauth:", e instanceof Error ? e.message : "error");
    return json({ error: "Error interno" }, 500);
  }
});
