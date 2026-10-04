// node --experimental-strip-types --test supabase/functions/_shared/google/auth.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { utf8ToBase64Url } from "./b64.ts";
import {
  accessTokenUsable, AUTH_URL, buildAuthUrl, capabilitiesOf, decodeIdToken, exchangeCode, GOOGLE_SCOPES, hasScope, parseBundle, parseScopes,
  refreshAccessToken, REVOKE_URL, revokeToken, serializeBundle, SCOPE_CALENDAR, SCOPE_GMAIL_COMPOSE, SCOPE_GMAIL_READ, TOKEN_URL,
} from "./auth.ts";
import { GoogleTokenError, type Fetcher } from "./errors.ts";

const CLIENT = "123-abc.apps.googleusercontent.com";
const REDIRECT = "https://rrhyyclltgaecfyertqh.supabase.co/functions/v1/google-oauth/callback";

function fake(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  };
  return { f, calls };
}
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

describe("URL de autorización", () => {
  const url = new URL(buildAuthUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "estado.firmado" }));
  const q = url.searchParams;

  it("usa el endpoint y los parámetros documentados", () => {
    assert.equal(`${url.origin}${url.pathname}`, AUTH_URL);
    assert.equal(q.get("client_id"), CLIENT);
    assert.equal(q.get("redirect_uri"), REDIRECT);
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("access_type"), "offline");
    assert.equal(q.get("prompt"), "consent");
    assert.equal(q.get("state"), "estado.firmado");
  });

  it("pide exactamente los permisos acordados, fijos en el servidor", () => {
    assert.deepEqual(q.get("scope")?.split(" "), [
      "openid", "email",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
    assert.deepEqual([...GOOGLE_SCOPES], q.get("scope")?.split(" "));
    // Nada que pueda enviar correo sin pasar por borradores ni administrar el calendario completo:
    assert.ok(!q.get("scope")?.includes("gmail.send") && !q.get("scope")?.includes("gmail.modify") && !q.get("scope")?.includes("mail.google.com"));
  });

  it("login_hint solo si parece un correo", () => {
    const hint = new URL(buildAuthUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s", loginHint: "david@sayainvestments.co" }));
    assert.equal(hint.searchParams.get("login_hint"), "david@sayainvestments.co");
    const bad = new URL(buildAuthUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s", loginHint: "no es correo" }));
    assert.equal(bad.searchParams.has("login_hint"), false);
  });
});

describe("cambio de código por tokens", () => {
  const ok = { access_token: "ya29.A", expires_in: 3599, refresh_token: "1//R", scope: `openid email ${SCOPE_CALENDAR}`, token_type: "Bearer", id_token: "x.y.z" };

  it("POST form-urlencoded con code, client_id, client_secret, redirect_uri y grant_type", async () => {
    const { f, calls } = fake(() => res(ok));
    const t = await exchangeCode(f, { clientId: CLIENT, clientSecret: "SECRETO", redirectUri: REDIRECT, code: "4/0Abc" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, TOKEN_URL);
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");
    assert.deepEqual(form(calls[0]?.init as RequestInit), {
      code: "4/0Abc", client_id: CLIENT, client_secret: "SECRETO", redirect_uri: REDIRECT, grant_type: "authorization_code",
    });
    assert.deepEqual(t, { access_token: "ya29.A", expires_in: 3599, refresh_token: "1//R", scope: ok.scope, id_token: "x.y.z" });
  });

  it("invalid_grant llega como GoogleTokenError con su código", async () => {
    const { f } = fake(() => res({ error: "invalid_grant", error_description: "Bad Request" }, 400));
    await assert.rejects(
      () => exchangeCode(f, { clientId: CLIENT, clientSecret: "S", redirectUri: REDIRECT, code: "x" }),
      (e: unknown) => e instanceof GoogleTokenError && e.code === "invalid_grant" && e.status === 400,
    );
  });

  it("una respuesta sin access_token se rechaza; el error nunca incluye el secreto", async () => {
    const { f } = fake(() => res({ foo: "bar" }));
    await assert.rejects(() => exchangeCode(f, { clientId: CLIENT, clientSecret: "SECRETO-X", redirectUri: REDIRECT, code: "x" }), (e: unknown) => {
      return e instanceof GoogleTokenError && !String((e as Error).message).includes("SECRETO-X");
    });
    const { f: f2 } = fake(() => new Response("<html>502</html>", { status: 502 }));
    await assert.rejects(() => exchangeCode(f2, { clientId: CLIENT, clientSecret: "S", redirectUri: REDIRECT, code: "x" }), GoogleTokenError);
  });
});

describe("renovar y revocar", () => {
  it("renovar manda grant_type=refresh_token y no manda code", async () => {
    const { f, calls } = fake(() => res({ access_token: "ya29.B", expires_in: 3599, scope: "x", token_type: "Bearer" }));
    const t = await refreshAccessToken(f, { clientId: CLIENT, clientSecret: "S", refreshToken: "1//R" });
    assert.deepEqual(form(calls[0]?.init as RequestInit), { client_id: CLIENT, client_secret: "S", refresh_token: "1//R", grant_type: "refresh_token" });
    assert.equal(t.access_token, "ya29.B");
    assert.equal(t.refresh_token, undefined);
  });

  it("revocar manda el token a /revoke", async () => {
    const { f, calls } = fake(() => res({}));
    assert.equal(await revokeToken(f, "1//R"), true);
    assert.equal(calls[0]?.url, REVOKE_URL);
    assert.deepEqual(form(calls[0]?.init as RequestInit), { token: "1//R" });
    const { f: f2 } = fake(() => res({ error: "invalid_token" }, 400));
    assert.equal(await revokeToken(f2, "x"), false);
  });
});

describe("id_token", () => {
  const jwt = (payload: Record<string, unknown>) => `${utf8ToBase64Url("{}")}.${utf8ToBase64Url(JSON.stringify(payload))}.firma`;
  const valid = { iss: "https://accounts.google.com", aud: CLIENT, sub: "1098765", email: "david@sayainvestments.co", email_verified: true };

  it("lee sub y correo cuando emisor y destinatario son los esperados", () => {
    assert.deepEqual(decodeIdToken(jwt(valid), CLIENT), { sub: "1098765", email: "david@sayainvestments.co", emailVerified: true });
    assert.equal(decodeIdToken(jwt({ ...valid, iss: "accounts.google.com" }), CLIENT)?.sub, "1098765");
    assert.equal(decodeIdToken(jwt({ ...valid, aud: ["otro", CLIENT] }), CLIENT)?.sub, "1098765");
  });

  it("rechaza otro destinatario, otro emisor o formato roto", () => {
    assert.equal(decodeIdToken(jwt({ ...valid, aud: "otro-cliente" }), CLIENT), null);
    assert.equal(decodeIdToken(jwt({ ...valid, iss: "https://evil.example.com" }), CLIENT), null);
    assert.equal(decodeIdToken(jwt({ ...valid, sub: "" }), CLIENT), null);
    assert.equal(decodeIdToken(jwt({ ...valid, email: undefined }), CLIENT), null);
    assert.equal(decodeIdToken("no-es-jwt", CLIENT), null);
    assert.equal(decodeIdToken("a.b!!.c", CLIENT), null);
    assert.equal(decodeIdToken(`a.${utf8ToBase64Url("no json")}.c`, CLIENT), null);
  });

  it("email_verified distinto de true no cuenta como verificado", () => {
    assert.equal(decodeIdToken(jwt({ ...valid, email_verified: "true" }), CLIENT)?.emailVerified, false);
    assert.equal(decodeIdToken(jwt({ ...valid, email_verified: undefined }), CLIENT)?.emailVerified, false);
  });
});

describe("permisos concedidos", () => {
  it("Google puede conceder solo algunos: se detecta cada uno", () => {
    const todo = parseScopes(`openid email ${SCOPE_CALENDAR} ${SCOPE_GMAIL_READ} ${SCOPE_GMAIL_COMPOSE}`);
    assert.deepEqual(capabilitiesOf(todo), { calendar: true, gmail_read: true, gmail_compose: true });
    const sinCorreo = parseScopes(`openid email ${SCOPE_CALENDAR}`);
    assert.deepEqual(capabilitiesOf(sinCorreo), { calendar: true, gmail_read: false, gmail_compose: false });
    assert.equal(hasScope(sinCorreo, "gmail_read"), false);
    assert.deepEqual(capabilitiesOf(parseScopes("openid email")), { calendar: false, gmail_read: false, gmail_compose: false });
    assert.deepEqual(parseScopes(undefined), []);
    assert.deepEqual(parseScopes("  a   b "), ["a", "b"]);
  });
});

describe("paquete de tokens", () => {
  it("serializa y lee; descarta lo que no sirve", () => {
    const b = { refresh_token: "1//R", access_token: "ya29", access_expires_at: "2026-10-05T14:00:00.000Z" };
    assert.deepEqual(parseBundle(serializeBundle(b)), b);
    assert.deepEqual(parseBundle('{"refresh_token":"1//R"}'), { refresh_token: "1//R", access_token: undefined, access_expires_at: undefined });
    for (const bad of [null, "", "no json", "{}", '{"refresh_token":""}', '{"refresh_token":5}', "[]"]) assert.equal(parseBundle(bad), null, String(bad));
  });

  it("el access_token se considera vigente hasta 60 s antes de vencer", () => {
    const exp = Date.UTC(2026, 9, 5, 14, 0, 0);
    const b = { refresh_token: "r", access_token: "a", access_expires_at: new Date(exp).toISOString() };
    assert.equal(accessTokenUsable(b, exp - 120_000), true);
    assert.equal(accessTokenUsable(b, exp - 60_001), true);
    assert.equal(accessTokenUsable(b, exp - 60_000), false);
    assert.equal(accessTokenUsable(b, exp + 1), false);
    assert.equal(accessTokenUsable({ refresh_token: "r" }, 0), false);
    assert.equal(accessTokenUsable({ ...b, access_expires_at: "basura" }, 0), false);
  });
});
