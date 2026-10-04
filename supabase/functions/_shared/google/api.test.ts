// node --experimental-strip-types --test supabase/functions/_shared/google/api.test.ts
// Comprueba la URL, los parámetros, los encabezados y el cuerpo EXACTOS de cada pedido a Calendar y Gmail.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calendarGet, calendarInsert, calendarList, calendarPatchTimes, draftCreate, draftGet, draftsList, draftSendRequest, draftUpdate, gmailGetMeta,
  gmailListIds, gmailThreadMeta, META_HEADERS,
} from "./api.ts";
import {
  describeError, GoogleApiError, GoogleConflict, GoogleInputError, GoogleNotConnected, GoogleReauth, GoogleScopeMissing, GoogleTokenError, type Fetcher,
} from "./errors.ts";

function fake(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: URL; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const f: Fetcher = async (url, init) => {
    const i = init ?? {};
    calls.push({ url: new URL(url), method: String(i.method), headers: i.headers as Record<string, string>, body: i.body === undefined ? undefined : JSON.parse(String(i.body)) });
    return handler(url, i);
  };
  return { f, calls };
}
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKEN = "ya29.token-de-prueba";

describe("Calendar", () => {
  it("listar: ventana con desfase, repeticiones expandidas, orden por inicio, zona de Lima y token Bearer", async () => {
    const { f, calls } = fake(() => res({ items: [{ id: "a" }, { id: "b" }] }));
    const items = await calendarList(f, TOKEN, { timeMin: "2026-10-05T00:00:00-05:00", timeMax: "2026-10-06T00:00:00-05:00" });
    assert.deepEqual(items.map((e) => e.id), ["a", "b"]);
    const c = calls[0]!;
    assert.equal(c.method, "GET");
    assert.equal(`${c.url.origin}${c.url.pathname}`, "https://www.googleapis.com/calendar/v3/calendars/primary/events");
    assert.equal(c.url.searchParams.get("timeMin"), "2026-10-05T00:00:00-05:00");
    assert.equal(c.url.searchParams.get("timeMax"), "2026-10-06T00:00:00-05:00");
    assert.equal(c.url.searchParams.get("singleEvents"), "true");
    assert.equal(c.url.searchParams.get("orderBy"), "startTime");
    assert.equal(c.url.searchParams.get("timeZone"), "America/Lima");
    assert.equal(c.url.searchParams.get("maxResults"), "250");
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
  });

  it("crear: sendUpdates=none, sin invitados, zona de Lima; el id propio solo si se da", async () => {
    const { f, calls } = fake(() => res({ id: "nuevo" }));
    await calendarInsert(f, TOKEN, { title: "Reunión", start: "2026-10-06T16:00:00-05:00", end: "2026-10-06T17:00:00-05:00" });
    const c = calls[0]!;
    assert.equal(c.method, "POST");
    assert.equal(c.url.pathname, "/calendar/v3/calendars/primary/events");
    assert.equal(c.url.searchParams.get("sendUpdates"), "none"); // no se avisa a nadie
    assert.equal(c.headers["Content-Type"], "application/json");
    assert.deepEqual(c.body, {
      summary: "Reunión",
      start: { dateTime: "2026-10-06T16:00:00-05:00", timeZone: "America/Lima" },
      end: { dateTime: "2026-10-06T17:00:00-05:00", timeZone: "America/Lima" },
    });
    assert.ok(!("attendees" in (c.body as object)), "jamás se envían invitados");
    assert.ok(!("conferenceData" in (c.body as object)));

    await calendarInsert(f, TOKEN, { id: "abcde12345", title: "X", start: "s", end: "e", location: "Oficina", description: "d" });
    assert.deepEqual(calls[1]!.body, {
      id: "abcde12345", summary: "X", location: "Oficina", description: "d",
      start: { dateTime: "s", timeZone: "America/Lima" }, end: { dateTime: "e", timeZone: "America/Lima" },
    });
    assert.equal(calls[1]!.url.searchParams.get("sendUpdates"), "none");
  });

  it("mover: PATCH solo de start y end, con sendUpdates=none", async () => {
    const { f, calls } = fake(() => res({ id: "ev1" }));
    const times = { start: { dateTime: "2026-10-06T16:00:00-05:00", timeZone: "America/Lima" }, end: { dateTime: "2026-10-06T17:00:00-05:00", timeZone: "America/Lima" } };
    await calendarPatchTimes(f, TOKEN, "ev1_20261005T140000Z", times);
    const c = calls[0]!;
    assert.equal(c.method, "PATCH");
    assert.equal(c.url.pathname, "/calendar/v3/calendars/primary/events/ev1_20261005T140000Z");
    assert.equal(c.url.searchParams.get("sendUpdates"), "none");
    assert.deepEqual(c.body, times);
    assert.deepEqual(Object.keys(c.body as object).sort(), ["end", "start"]);
  });

  it("el id del evento se codifica en la ruta (no puede escapar de ella)", async () => {
    const { f, calls } = fake(() => res({ id: "x" }));
    await calendarGet(f, TOKEN, "a/b?c=d#e");
    assert.equal(calls[0]!.url.pathname, "/calendar/v3/calendars/primary/events/a%2Fb%3Fc%3Dd%23e");
    assert.equal(calls[0]!.url.search, "");
  });
});

describe("Gmail: lectura", () => {
  it("listar ids con la búsqueda de Gmail", async () => {
    const { f, calls } = fake(() => res({ messages: [{ id: "m1", threadId: "t1" }] }));
    const ids = await gmailListIds(f, TOKEN, "in:inbox is:important newer_than:7d", 10);
    assert.deepEqual(ids, [{ id: "m1", threadId: "t1" }]);
    const c = calls[0]!;
    assert.equal(c.url.pathname, "/gmail/v1/users/me/messages");
    assert.equal(c.url.searchParams.get("q"), "in:inbox is:important newer_than:7d");
    assert.equal(c.url.searchParams.get("maxResults"), "10");
    const vacio = fake(() => res({ resultSizeEstimate: 0 }));
    assert.deepEqual(await gmailListIds(vacio.f, TOKEN, "x", 5), []);
  });

  it("mensaje: format=metadata con metadataHeaders repetido", async () => {
    const { f, calls } = fake(() => res({ id: "m1" }));
    await gmailGetMeta(f, TOKEN, "m1");
    const u = calls[0]!.url;
    assert.equal(u.pathname, "/gmail/v1/users/me/messages/m1");
    assert.equal(u.searchParams.get("format"), "metadata");
    assert.deepEqual(u.searchParams.getAll("metadataHeaders"), [...META_HEADERS]);
    for (const h of ["From", "Subject", "Message-ID", "References", "In-Reply-To", "Reply-To"]) assert.ok(META_HEADERS.includes(h as never), h);
  });

  it("hilo: threads.get en format=metadata", async () => {
    const { f, calls } = fake(() => res({ id: "t1", messages: [] }));
    await gmailThreadMeta(f, TOKEN, "t1");
    assert.equal(calls[0]!.url.pathname, "/gmail/v1/users/me/threads/t1");
    assert.equal(calls[0]!.url.searchParams.get("format"), "metadata");
  });
});

describe("Gmail: borradores", () => {
  it("listar y leer borradores", async () => {
    const { f, calls } = fake((url) => (url.includes("/drafts/") ? res({ id: "r-1" }) : res({ drafts: [{ id: "r-1" }] })));
    assert.deepEqual(await draftsList(f, TOKEN, 10), [{ id: "r-1" }]);
    assert.equal(calls[0]!.url.pathname, "/gmail/v1/users/me/drafts");
    assert.equal(calls[0]!.url.searchParams.get("maxResults"), "10");
    await draftGet(f, TOKEN, "r-1", "full");
    assert.equal(calls[1]!.url.pathname, "/gmail/v1/users/me/drafts/r-1");
    assert.equal(calls[1]!.url.searchParams.get("format"), "full");
    await draftGet(f, TOKEN, "r-1", "minimal");
    assert.equal(calls[2]!.url.searchParams.get("format"), "minimal");
  });

  it("crear: POST /drafts con message.raw y threadId (hilo)", async () => {
    const { f, calls } = fake(() => res({ id: "r-9", message: { id: "m-9", threadId: "t1" } }));
    await draftCreate(f, TOKEN, "UkFX", "t1");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url.pathname, "/gmail/v1/users/me/drafts");
    assert.deepEqual(calls[0]!.body, { message: { raw: "UkFX", threadId: "t1" } });
    await draftCreate(f, TOKEN, "UkFX");
    assert.deepEqual(calls[1]!.body, { message: { raw: "UkFX" } });
  });

  it("editar: PUT /drafts/{id} con el mensaje nuevo", async () => {
    const { f, calls } = fake(() => res({ id: "r-9" }));
    await draftUpdate(f, TOKEN, "r-9", "TlVFVk8", "t1");
    assert.equal(calls[0]!.method, "PUT");
    assert.equal(calls[0]!.url.pathname, "/gmail/v1/users/me/drafts/r-9");
    // El cuerpo es un recurso Draft: lleva el mismo id de la ruta y el mensaje nuevo (Gmail lo reemplaza entero).
    assert.deepEqual(calls[0]!.body, { id: "r-9", message: { raw: "TlVFVk8", threadId: "t1" } });
  });

  it("enviar: POST /drafts/send con el id del borrador y nada más", async () => {
    const { f, calls } = fake(() => res({ id: "sent-1", threadId: "t1" }));
    const sent = await draftSendRequest(f, TOKEN, "r-9");
    assert.equal(sent.id, "sent-1");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url.pathname, "/gmail/v1/users/me/drafts/send");
    assert.deepEqual(calls[0]!.body, { id: "r-9" });
  });

  it("solo crear/editar/leer no envían: ningún otro pedido toca /drafts/send ni /messages/send", async () => {
    const { f, calls } = fake(() => res({ id: "x", message: { id: "m" }, drafts: [], messages: [] }));
    await draftsList(f, TOKEN, 5);
    await draftGet(f, TOKEN, "r", "full");
    await draftCreate(f, TOKEN, "raw", "t");
    await draftUpdate(f, TOKEN, "r", "raw", "t");
    await gmailListIds(f, TOKEN, "q", 5);
    await gmailGetMeta(f, TOKEN, "m");
    await gmailThreadMeta(f, TOKEN, "t");
    assert.equal(calls.filter((c) => /\/send$/.test(c.url.pathname)).length, 0);
  });
});

describe("errores de Google → mensajes", () => {
  const apiError = async (status: number, body: unknown) => {
    const { f } = fake(() => res(body, status));
    try {
      await calendarGet(f, TOKEN, "x");
    } catch (e) {
      return e as GoogleApiError;
    }
    throw new Error("debía fallar");
  };

  it("API sin habilitar en el proyecto (la causa más común al estrenar)", async () => {
    const e = await apiError(403, {
      error: {
        code: 403, status: "PERMISSION_DENIED",
        message: "Google Calendar API has not been used in project 123 before or it is disabled.",
        errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
      },
    });
    assert.ok(e instanceof GoogleApiError);
    assert.equal(e.status, 403);
    const d = describeError(e);
    assert.equal(d.code, "api_deshabilitada");
    assert.match(d.message, /Calendar/);
    assert.equal(describeError(new GoogleApiError(403, ["accessNotConfigured"], "Gmail API has not been used")).message.includes("Gmail"), true);
  });

  it("permiso insuficiente, límite, no encontrado, token inválido y caída de Google", async () => {
    assert.equal(describeError(await apiError(403, { error: { message: "x", errors: [{ reason: "insufficientPermissions" }] } })).code, "permiso");
    assert.equal(describeError(await apiError(403, { error: { message: "x", errors: [{ reason: "rateLimitExceeded" }] } })).code, "limite");
    assert.equal(describeError(await apiError(429, { error: { message: "x" } })).code, "limite");
    assert.equal(describeError(await apiError(404, { error: { message: "Not Found" } })).code, "no_encontrado");
    assert.equal(describeError(await apiError(401, { error: { message: "Invalid Credentials" } })).code, "reauth");
    assert.equal(describeError(await apiError(503, { error: { message: "Backend Error" } })).code, "google");
  });

  it("cuerpo no JSON no rompe el manejo", async () => {
    const { f } = fake(() => new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    await assert.rejects(() => calendarGet(f, TOKEN, "x"), (e: unknown) => e instanceof GoogleApiError && e.status === 502);
  });

  it("errores propios: no conectado, reconectar, permiso, entrada y confirmación", () => {
    assert.deepEqual(describeError(new GoogleNotConnected()).code, "no_conectado");
    assert.match(describeError(new GoogleNotConnected()).message, /Conectar Google/);
    assert.equal(describeError(new GoogleReauth()).code, "reauth");
    assert.equal(describeError(new GoogleScopeMissing("gmail_read")).code, "permiso");
    assert.equal(describeError(new GoogleScopeMissing("calendar")).status, 403);
    assert.deepEqual([describeError(new GoogleInputError("falta")).code, describeError(new GoogleInputError("falta")).status], ["invalido", 400]);
    assert.equal(describeError(new GoogleInputError("falta", "confirmacion")).code, "confirmacion");
    const c = describeError(new GoogleConflict("invitados", "tiene invitados", { guests: 3 }));
    assert.deepEqual([c.code, c.status, c.data], ["invitados", 409, { guests: 3 }]);
    assert.equal(describeError(new GoogleTokenError(401, "invalid_client", "x")).code, "config");
    assert.equal(describeError(new Error("boom")).code, "interno");
    assert.ok(!describeError(new Error("secreto sk-123")).message.includes("sk-123"), "un error inesperado no filtra detalles");
  });
});
