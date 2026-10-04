// node --experimental-strip-types --test supabase/functions/_shared/google/core.test.ts
// Lógica del módulo con almacenamiento y Google falsos: renovación de tokens, confirmaciones y "nunca enviar".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { base64UrlToUtf8, utf8ToBase64Url } from "./b64.ts";
import { parseBundle, SCOPE_CALENDAR, SCOPE_GMAIL_COMPOSE, SCOPE_GMAIL_READ, TOKEN_URL, type TokenBundle } from "./auth.ts";
import {
  calendarCreate, calendarEvents, calendarMove, disconnect, draftCreateReply, draftSend, draftUpdateBody, googleStatus, mailDrafts, mailImportant,
  saveConnection, withGoogle, type Deps, type GoogleAccount, type GoogleStore,
} from "./core.ts";
import { GoogleApiError, GoogleConflict, GoogleInputError, GoogleNotConnected, GoogleReauth, GoogleScopeMissing, GoogleTokenError } from "./errors.ts";
import { parseAddress } from "./mail.ts";

const USER = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const ALL = [SCOPE_CALENDAR, SCOPE_GMAIL_READ, SCOPE_GMAIL_COMPOSE];
const T0 = Date.UTC(2026, 9, 5, 13, 0, 0); // lunes 5 oct 2026, 08:00 en Lima

type Call = { method: string; url: URL; body: any };
type Route = (c: Call) => Response | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const gErr = (status: number, reason: string, message = "error") => json({ error: { code: status, message, errors: [{ reason }] } }, status);

class MemStore implements GoogleStore {
  accounts = new Map<string, GoogleAccount>();
  tokens = new Map<string, string>();
  revokedNotices: string[] = [];
  deleted: string[] = [];
  clock: () => number;
  constructor(clock: () => number) {
    this.clock = clock;
  }
  async getAccount(userId: string) {
    return userId === USER ? [...this.accounts.values()].sort((a, b) => a.status.localeCompare(b.status) || b.connected_at.localeCompare(a.connected_at))[0] ?? null : null;
  }
  async readTokens(accountId: string) { return this.tokens.get(accountId) ?? null; }
  async writeTokens(accountId: string, _u: string, payload: string) { this.tokens.set(accountId, payload); }
  async setAccessExpiry(accountId: string, iso: string) { const a = this.accounts.get(accountId); if (a) a.access_expires_at = iso; }
  async markRevoked(_u: string, account: GoogleAccount, why: string) {
    const a = this.accounts.get(account.account_id);
    if (a && a.status === "active") { a.status = "revoked"; a.last_error = why; this.revokedNotices.push(why); }
  }
  async upsertAccount(_u: string, identity: { sub: string; email: string }, scopes: string[], exp: string) {
    const id = `acc-${identity.sub}`;
    this.accounts.set(id, { account_id: id, email: identity.email, scopes, status: "active", access_expires_at: exp, last_error: null, connected_at: new Date(this.clock()).toISOString() });
    return id;
  }
  async accountIds() { return [...this.accounts.keys()]; }
  async deleteAccount(_u: string, id: string) { this.accounts.delete(id); this.tokens.delete(id); this.deleted.push(id); }
}

function setup(opts: { scopes?: string[]; status?: "active" | "revoked"; tokens?: TokenBundle | null; none?: boolean } = {}) {
  let now = T0;
  const store = new MemStore(() => now);
  const calls: Call[] = [];
  const routes: Route[] = [];
  if (!opts.none) {
    store.accounts.set("acc-1", {
      account_id: "acc-1", email: "david@sayainvestments.co", scopes: opts.scopes ?? ALL, status: opts.status ?? "active",
      access_expires_at: null, last_error: null, connected_at: "2026-10-01T00:00:00.000Z",
    });
    if (opts.tokens !== null) store.tokens.set("acc-1", JSON.stringify(opts.tokens ?? { refresh_token: "1//REFRESH" }));
  }
  const d: Deps = {
    store,
    now: () => now,
    credentials: () => ({ clientId: "cid", clientSecret: "csec" }),
    configured: () => true,
    fetch: async (url, init) => {
      const call: Call = { method: String(init?.method), url: new URL(url), body: init?.body === undefined ? undefined : (String(init.body).startsWith("{") ? JSON.parse(String(init.body)) : Object.fromEntries(new URLSearchParams(String(init.body)))) };
      calls.push(call);
      for (const r of routes) { const out = r(call); if (out) return out; }
      return gErr(404, "notFound", `sin ruta para ${call.method} ${call.url.pathname}`);
    },
  };
  const on = (r: Route) => routes.push(r);
  const first = (r: Route) => routes.unshift(r); // tiene prioridad sobre las demás
  // Token endpoint que entrega access tokens numerados
  let n = 0;
  on((c) => (c.url.href === TOKEN_URL && c.body?.grant_type === "refresh_token")
    ? json({ access_token: `ya29.nuevo-${++n}`, expires_in: 3599, scope: ALL.join(" "), token_type: "Bearer" }) : undefined);
  return { d, store, calls, on, first, advance: (ms: number) => { now += ms; }, tokenCalls: () => calls.filter((c) => c.url.href === TOKEN_URL) };
}

const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id, summary: `Evento ${id}`,
  start: { dateTime: "2026-10-05T09:00:00-05:00" }, end: { dateTime: "2026-10-05T10:00:00-05:00" }, ...over,
});

describe("acceso y permisos", () => {
  it("sin cuenta conectada → GoogleNotConnected; revocada → GoogleReauth", async () => {
    await assert.rejects(() => calendarEvents(setup({ none: true }).d, USER, "2026-10-05", 1), GoogleNotConnected);
    await assert.rejects(() => calendarEvents(setup({ status: "revoked" }).d, USER, "2026-10-05", 1), GoogleReauth);
  });

  it("falta un permiso → GoogleScopeMissing con cuál; mode any acepta con uno", async () => {
    const s = setup({ scopes: [SCOPE_CALENDAR] });
    await assert.rejects(() => mailImportant(s.d, USER), (e: unknown) => e instanceof GoogleScopeMissing && e.need === "gmail_read");
    await assert.rejects(() => draftCreateReply(s.d, USER, { thread_id: "t1", body: "hola" }), GoogleScopeMissing);
    assert.equal(s.calls.length, 0, "ni siquiera pide token");
    const soloCompose = setup({ scopes: [SCOPE_GMAIL_COMPOSE] });
    soloCompose.on((c) => (c.url.pathname.endsWith("/drafts") ? json({ drafts: [] }) : undefined));
    assert.deepEqual(await mailDrafts(soloCompose.d, USER), []);
  });

  it("estado: no conectado / conectado con permisos / revocado", async () => {
    assert.deepEqual(await googleStatus(setup({ none: true }).d, USER), { configured: true, connected: false, reauth: false, account: null });
    const ok = await googleStatus(setup({ scopes: [SCOPE_CALENDAR] }).d, USER);
    assert.equal(ok.connected, true);
    assert.deepEqual(ok.account?.capabilities, { calendar: true, gmail_read: false, gmail_compose: false });
    assert.equal(ok.account?.email, "david@sayainvestments.co");
    const revoked = await googleStatus(setup({ status: "revoked" }).d, USER);
    assert.deepEqual([revoked.connected, revoked.reauth], [false, true]);
  });
});

describe("token de acceso", () => {
  it("sin access_token guardado renueva, lo guarda cifrado (vía store) y conserva el refresh_token", async () => {
    const s = setup();
    s.on((c) => (c.url.pathname.endsWith("/events") ? json({ items: [] }) : undefined));
    await calendarEvents(s.d, USER, "2026-10-05", 1);
    assert.equal(s.tokenCalls().length, 1);
    assert.deepEqual(s.tokenCalls()[0]!.body, { client_id: "cid", client_secret: "csec", refresh_token: "1//REFRESH", grant_type: "refresh_token" });
    const saved = parseBundle(s.store.tokens.get("acc-1") ?? null);
    assert.equal(saved?.refresh_token, "1//REFRESH");
    assert.equal(saved?.access_token, "ya29.nuevo-1");
    assert.equal(saved?.access_expires_at, new Date(T0 + 3599_000).toISOString());
    assert.equal(s.store.accounts.get("acc-1")?.access_expires_at, saved?.access_expires_at);
  });

  it("reutiliza el access_token vigente y renueva cuando faltan menos de 60 s", async () => {
    const s = setup({ tokens: { refresh_token: "r", access_token: "ya29.vigente", access_expires_at: new Date(T0 + 30 * 60_000).toISOString() } });
    s.on((c) => (c.url.pathname.endsWith("/events") ? json({ items: [] }) : undefined));
    await calendarEvents(s.d, USER, "2026-10-05", 1);
    assert.equal(s.tokenCalls().length, 0, "no llama a Google para renovar");
    s.advance(30 * 60_000 - 30_000); // quedan 30 s
    await calendarEvents(s.d, USER, "2026-10-05", 1);
    assert.equal(s.tokenCalls().length, 1);
  });

  it("invalid_grant al renovar: marca la cuenta como revocada una sola vez y pide reconectar", async () => {
    const s = setup();
    s.first((c) => (c.url.href === TOKEN_URL ? json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400) : undefined));
    await assert.rejects(() => calendarEvents(s.d, USER, "2026-10-05", 1), GoogleReauth);
    assert.deepEqual(s.store.revokedNotices, ["invalid_grant"]);
    assert.equal(s.store.accounts.get("acc-1")?.status, "revoked");
    await assert.rejects(() => calendarEvents(s.d, USER, "2026-10-05", 1), GoogleReauth); // ya no insiste
    assert.equal(s.store.revokedNotices.length, 1);
    assert.equal(s.tokenCalls().length, 1, "tampoco vuelve a llamar a Google");
  });

  it("sin tokens guardados → reconectar; otros errores del endpoint de tokens se propagan", async () => {
    const sinTokens = setup({ tokens: null });
    await assert.rejects(() => calendarEvents(sinTokens.d, USER, "2026-10-05", 1), GoogleReauth);
    const roto = setup();
    roto.d.fetch = async () => json({ error: "invalid_client" }, 401);
    await assert.rejects(() => calendarEvents(roto.d, USER, "2026-10-05", 1), (e: unknown) => e instanceof GoogleTokenError && e.code === "invalid_client");
    assert.equal(roto.store.accounts.get("acc-1")?.status, "active", "una credencial mala no desconecta la cuenta");
  });

  it("un 401 de la API fuerza una renovación y reintenta UNA vez", async () => {
    const s = setup({ tokens: { refresh_token: "r", access_token: "ya29.viejo", access_expires_at: new Date(T0 + 3600_000).toISOString() } });
    let intentos = 0;
    s.on((c) => {
      if (!c.url.pathname.endsWith("/events")) return undefined;
      return ++intentos === 1 ? gErr(401, "authError", "Invalid Credentials") : json({ items: [ev("a")] });
    });
    const events = await calendarEvents(s.d, USER, "2026-10-05", 1);
    assert.equal(events.length, 1);
    assert.equal(intentos, 2);
    assert.equal(s.tokenCalls().length, 1);
    // si sigue fallando, no entra en bucle
    const s2 = setup();
    s2.on((c) => (c.url.pathname.endsWith("/events") ? gErr(401, "authError") : undefined));
    await assert.rejects(() => calendarEvents(s2.d, USER, "2026-10-05", 1), (e: unknown) => e instanceof GoogleApiError && e.status === 401);
    assert.equal(s2.calls.filter((c) => c.url.pathname.endsWith("/events")).length, 2);
  });

  it("withGoogle entrega el token y la cuenta", async () => {
    const s = setup();
    const out = await withGoogle(s.d, USER, ["calendar"], async (token, account) => `${token}|${account.email}`);
    assert.equal(out, "ya29.nuevo-1|david@sayainvestments.co");
  });
});

describe("Calendar", () => {
  it("ver el día: pide la ventana de Lima y devuelve eventos ordenados y ya normalizados", async () => {
    const s = setup();
    s.on((c) => (c.url.pathname.endsWith("/events") ? json({ items: [ev("b", { start: { dateTime: "2026-10-05T11:30:00-05:00" }, end: { dateTime: "2026-10-05T12:00:00-05:00" } }), ev("a"), ev("x", { status: "cancelled" })] }) : undefined));
    const events = await calendarEvents(s.d, USER, "2026-10-05", 1);
    assert.deepEqual(events.map((e) => e.id), ["a", "b"]);
    const list = s.calls.find((c) => c.url.pathname.endsWith("/events"))!;
    assert.equal(list.url.searchParams.get("timeMin"), "2026-10-05T00:00:00-05:00");
    assert.equal(list.url.searchParams.get("timeMax"), "2026-10-06T00:00:00-05:00");
  });

  it("crear: avisa de cruces, inserta con sendUpdates=none y SIN invitados", async () => {
    const s = setup();
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/events") ? json({ items: [ev("a", { summary: "Maqui CO" })] }) : undefined));
    s.on((c) => (c.method === "POST" && c.url.pathname.endsWith("/events") ? json({ id: "nuevo", summary: c.body.summary, start: c.body.start, end: c.body.end }) : undefined));
    const out = await calendarCreate(s.d, USER, { title: "Reunión con Daniel", date: "2026-10-05", start_time: "09:30", duration_min: 30 });
    assert.deepEqual(out.overlaps, ["Maqui CO"]);
    assert.equal(out.event.title, "Reunión con Daniel");
    assert.equal(out.event.start_hm, "09:30");
    const insert = s.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/events"))!;
    assert.equal(insert.url.searchParams.get("sendUpdates"), "none");
    assert.ok(!("attendees" in insert.body));
    assert.equal(insert.body.start.dateTime, "2026-10-05T09:30:00-05:00");
  });

  it("crear con request_id: el reintento del mismo envío (409) devuelve el evento ya creado, sin duplicar", async () => {
    const s = setup();
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/events") ? json({ items: [] }) : undefined));
    s.on((c) => (c.method === "POST" ? gErr(409, "duplicate", "The requested identifier already exists.") : undefined));
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/6f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f") ? json(ev("6f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f", { summary: "Reunión con Daniel" })) : undefined));
    const out = await calendarCreate(s.d, USER, { title: "Reunión con Daniel", date: "2026-10-05", start_time: "09:00", request_id: USER });
    assert.equal(out.event.id, "6f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f");
    assert.deepEqual(out.overlaps, [], "no se cruza consigo mismo");
    const inserts = s.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/events"));
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0]!.body.id, "6f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f");
  });

  it("crear con datos inválidos no toca la red", async () => {
    const s = setup();
    await assert.rejects(() => calendarCreate(s.d, USER, { title: "", date: "2026-10-05", start_time: "09:00" }), GoogleInputError);
    assert.equal(s.calls.length, 0);
  });

  it("mover un evento sin invitados: PATCH con sendUpdates=none y la duración original", async () => {
    const s = setup();
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/events/ev1") ? json(ev("ev1")) : undefined));
    s.on((c) => (c.method === "PATCH" ? json(ev("ev1", { start: c.body.start, end: c.body.end })) : undefined));
    const { event } = await calendarMove(s.d, USER, { event_id: "ev1", date: "2026-10-06", start_time: "16:00" });
    assert.equal(event.start_hm, "16:00");
    const patch = s.calls.find((c) => c.method === "PATCH")!;
    assert.equal(patch.url.searchParams.get("sendUpdates"), "none");
    assert.deepEqual(patch.body, {
      start: { dateTime: "2026-10-06T16:00:00-05:00", timeZone: "America/Lima" },
      end: { dateTime: "2026-10-06T17:00:00-05:00", timeZone: "America/Lima" },
    });
  });

  it("mover un evento CON invitados exige confirmación: sin ella no se cambia nada", async () => {
    const s = setup();
    const withGuests = ev("ev2", { summary: "TDV — Early Warning", attendees: [{ self: true }, { email: "monica@tdv.com", displayName: "Mónica" }, { email: "juanjo@tdv.com" }] });
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/events/ev2") ? json(withGuests) : undefined));
    s.on((c) => (c.method === "PATCH" ? json(ev("ev2", { start: c.body.start, end: c.body.end })) : undefined));

    await assert.rejects(
      () => calendarMove(s.d, USER, { event_id: "ev2", date: "2026-10-06", start_time: "16:00" }),
      (e: unknown) => e instanceof GoogleConflict && e.code === "invitados" && e.data.guests === 2 && /2 invitados/.test(e.message),
    );
    await assert.rejects(() => calendarMove(s.d, USER, { event_id: "ev2", date: "2026-10-06", start_time: "16:00", confirm_guests: "si" }), GoogleConflict);
    assert.equal(s.calls.filter((c) => c.method === "PATCH").length, 0, "no se movió nada sin confirmación");

    await calendarMove(s.d, USER, { event_id: "ev2", date: "2026-10-06", start_time: "16:00", confirm_guests: true });
    const patch = s.calls.filter((c) => c.method === "PATCH");
    assert.equal(patch.length, 1);
    assert.equal(patch[0]!.url.searchParams.get("sendUpdates"), "none", "aun confirmado, no se avisa a nadie");
  });

  it("no mueve eventos de todo el día ni inexistentes", async () => {
    const s = setup();
    s.on((c) => (c.url.pathname.endsWith("/events/dia") ? json(ev("dia", { start: { date: "2026-10-05" }, end: { date: "2026-10-06" } })) : undefined));
    s.on((c) => (c.url.pathname.endsWith("/events/cancelado") ? json(ev("cancelado", { status: "cancelled" })) : undefined));
    await assert.rejects(() => calendarMove(s.d, USER, { event_id: "dia", date: "2026-10-06", start_time: "16:00" }), GoogleInputError);
    await assert.rejects(() => calendarMove(s.d, USER, { event_id: "cancelado", date: "2026-10-06", start_time: "16:00" }), /ya no existe/);
    assert.equal(s.calls.filter((c) => c.method === "PATCH").length, 0);
  });
});

const hdr = (name: string, value: string) => ({ name, value });
const gmsg = (id: string, over: Record<string, unknown> = {}) => ({
  id, threadId: `t-${id}`, labelIds: ["INBOX", "UNREAD", "IMPORTANT"], snippet: `resumen ${id}`, internalDate: String(T0 - Number(id.replace(/\D/g, "") || 0) * 60_000),
  payload: { headers: [hdr("From", `Persona ${id} <p${id}@x.com>`), hdr("Subject", `Asunto ${id}`)] }, ...over,
});

describe("Gmail: importantes", () => {
  it("busca importantes (y el resto si se pide), lee cada mensaje en metadata y ordena por fecha", async () => {
    const s = setup();
    s.on((c) => {
      if (c.url.pathname.endsWith("/messages")) {
        return c.url.searchParams.get("q")!.includes("-is:important")
          ? json({ messages: [{ id: "9", threadId: "t-9" }] })
          : json({ messages: [{ id: "1", threadId: "t-1" }, { id: "2", threadId: "t-2" }] });
      }
      const m = /\/messages\/(\d+)$/.exec(c.url.pathname);
      return m ? json(gmsg(m[1]!)) : undefined;
    });
    const { important, rest } = await mailImportant(s.d, USER, { max: 5, rest: true });
    assert.deepEqual(important.map((m) => m.id), ["1", "2"]);
    assert.deepEqual(rest.map((m) => m.id), ["9"]);
    const lists = s.calls.filter((c) => c.url.pathname.endsWith("/messages"));
    assert.ok(lists.some((c) => c.url.searchParams.get("q")!.startsWith("in:inbox is:important")));
    assert.ok(lists.every((c) => c.url.searchParams.get("maxResults") === "5"));
    const gets = s.calls.filter((c) => /\/messages\/\d+$/.test(c.url.pathname));
    assert.ok(gets.every((c) => c.url.searchParams.get("format") === "metadata"));
  });

  it("un mensaje suelto que falla se omite; si fallan todos, el error sale", async () => {
    const s = setup();
    s.on((c) => (c.url.pathname.endsWith("/messages") ? json({ messages: [{ id: "1", threadId: "t-1" }, { id: "2", threadId: "t-2" }] }) : undefined));
    s.on((c) => (c.url.pathname.endsWith("/messages/1") ? json(gmsg("1")) : undefined));
    s.on((c) => (c.url.pathname.endsWith("/messages/2") ? gErr(404, "notFound") : undefined));
    assert.deepEqual((await mailImportant(s.d, USER)).important.map((m) => m.id), ["1"]);

    const caido = setup();
    caido.on((c) => (c.url.pathname.endsWith("/messages") ? json({ messages: [{ id: "1", threadId: "t-1" }] }) : undefined));
    caido.on((c) => (/\/messages\/1$/.test(c.url.pathname) ? gErr(403, "accessNotConfigured", "Gmail API has not been used") : undefined));
    await assert.rejects(() => mailImportant(caido.d, USER), (e: unknown) => e instanceof GoogleApiError && e.status === 403);
  });
});

const threadFor = (me = "david@sayainvestments.co") => ({
  id: "t1",
  messages: [{
    id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: "1000", snippet: "Pide cifras",
    payload: { headers: [hdr("From", "Mónica Pérez <monica@tdv.com>"), hdr("To", me), hdr("Subject", "Informe 03"), hdr("Message-ID", "<m1@mail.gmail.com>")] },
  }],
});

describe("Gmail: borradores (nunca se envía solo)", () => {
  it("crear respuesta: arma el MIME en el hilo, lo guarda como borrador y NO envía", async () => {
    const s = setup();
    s.on((c) => (c.url.pathname.endsWith("/threads/t1") ? json(threadFor()) : undefined));
    s.on((c) => (c.method === "POST" && c.url.pathname.endsWith("/drafts") ? json({ id: "r-1", message: { id: "m-draft", threadId: "t1" } }) : undefined));
    const draft = await draftCreateReply(s.d, USER, { thread_id: "t1", body: "Hola Mónica,\nTe paso las cifras hoy.\nSaludos, David." });
    assert.deepEqual([draft.draft_id, draft.message_id, draft.to, draft.to_email, draft.subject, draft.editable], ["r-1", "m-draft", "Mónica Pérez", "monica@tdv.com", "Re: Informe 03", true]);

    const create = s.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/drafts"))!;
    assert.equal(create.body.message.threadId, "t1");
    const mime = base64UrlToUtf8(create.body.message.raw) as string;
    assert.match(mime, /^In-Reply-To: <m1@mail\.gmail\.com>$/m);
    assert.match(mime, /^References: <m1@mail\.gmail\.com>$/m);
    assert.match(mime, /^Subject: Re: Informe 03$/m);
    assert.deepEqual(parseAddress(/^To: (.*)$/m.exec(mime)![1]!), { name: "Mónica Pérez", email: "monica@tdv.com" });
    assert.equal(s.calls.filter((c) => /\/send$/.test(c.url.pathname)).length, 0);
  });

  it("rechaza ids raros, cuerpos vacíos o enormes antes de llamar a Google", async () => {
    const s = setup();
    for (const input of [
      { thread_id: "../x", body: "hola" }, { thread_id: "t1", body: "   " }, { thread_id: "t1", body: "x".repeat(9000) }, { thread_id: "t1", message_id: "a b", body: "hola" }, { body: "hola" },
    ]) await assert.rejects(() => draftCreateReply(s.d, USER, input), GoogleInputError, JSON.stringify(input).slice(0, 60));
    assert.equal(s.calls.length, 0);
  });

  it("listar borradores: lee cada uno completo y los ordena por fecha", async () => {
    const s = setup();
    const draft = (id: string, ms: number, body: string) => ({ id, message: { id: `m-${id}`, threadId: "t1", internalDate: String(ms), snippet: body, payload: { mimeType: "text/plain", headers: [hdr("To", "Mónica <monica@tdv.com>"), hdr("Subject", "Re: Informe 03")], body: { data: utf8ToBase64Url(body) } } } });
    s.on((c) => (c.url.pathname.endsWith("/drafts") ? json({ drafts: [{ id: "a" }, { id: "b" }] }) : undefined));
    s.on((c) => (c.url.pathname.endsWith("/drafts/a") ? json(draft("a", 1000, "viejo")) : undefined));
    s.on((c) => (c.url.pathname.endsWith("/drafts/b") ? json(draft("b", 2000, "nuevo")) : undefined));
    const drafts = await mailDrafts(s.d, USER);
    assert.deepEqual(drafts.map((x) => [x.draft_id, x.body]), [["b", "nuevo"], ["a", "viejo"]]);
    assert.ok(s.calls.filter((c) => /\/drafts\/[ab]$/.test(c.url.pathname)).every((c) => c.url.searchParams.get("format") === "full"));
  });

  it("editar: conserva destinatarios e hilo, cambia el cuerpo y devuelve el message_id nuevo", async () => {
    const s = setup();
    const current = { id: "r-1", message: { id: "m-old", threadId: "t1", internalDate: "5000", payload: { mimeType: "text/plain", headers: [hdr("To", "Mónica <monica@tdv.com>"), hdr("Cc", "c@x.com"), hdr("Subject", "Re: Informe 03"), hdr("In-Reply-To", "<m1@mail.gmail.com>"), hdr("References", "<m1@mail.gmail.com>")], body: { data: utf8ToBase64Url("texto viejo") } } } };
    let saved: any = null;
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/drafts/r-1") ? json(saved ?? current) : undefined));
    s.on((c) => {
      if (c.method !== "PUT" || !c.url.pathname.endsWith("/drafts/r-1")) return undefined;
      saved = { id: "r-1", message: { id: "m-new", threadId: "t1", internalDate: "6000", payload: { mimeType: "text/plain", headers: current.message.payload.headers, body: { data: utf8ToBase64Url(c.body.message.raw ? "texto nuevo" : "") } } } };
      return json({ id: "r-1", message: { id: "m-new", threadId: "t1" } });
    });
    const out = await draftUpdateBody(s.d, USER, { draft_id: "r-1", body: "texto nuevo" });
    assert.deepEqual([out.message_id, out.body, out.subject, out.to_email], ["m-new", "texto nuevo", "Re: Informe 03", "monica@tdv.com"]);
    const put = s.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.body.message.threadId, "t1");
    const mime = base64UrlToUtf8(put.body.message.raw) as string;
    assert.match(mime, /^Cc: c@x\.com$/m);
    assert.match(mime, /^In-Reply-To: <m1@mail\.gmail\.com>$/m);
  });

  it("un borrador con adjuntos no se reescribe (se perderían)", async () => {
    const s = setup();
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/drafts/r-2")
      ? json({ id: "r-2", message: { id: "m2", threadId: "t", payload: { mimeType: "multipart/mixed", headers: [], parts: [{ mimeType: "text/plain", body: { data: utf8ToBase64Url("x") } }, { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "AT" } }] } } })
      : undefined));
    await assert.rejects(() => draftUpdateBody(s.d, USER, { draft_id: "r-2", body: "nuevo" }), (e: unknown) => e instanceof GoogleConflict && e.code === "adjuntos");
    assert.equal(s.calls.filter((c) => c.method === "PUT").length, 0);
  });
});

describe("enviar: solo con confirmación explícita y el borrador que David vio", () => {
  const sendRoutes = (s: ReturnType<typeof setup>, currentMessageId = "m-vista") => {
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/drafts/r-1") ? json({ id: "r-1", message: { id: currentMessageId } }) : undefined));
    s.on((c) => (c.method === "POST" && c.url.pathname.endsWith("/drafts/send") ? json({ id: "sent-1", threadId: "t1" }) : undefined));
  };
  const sends = (s: ReturnType<typeof setup>) => s.calls.filter((c) => /\/send$/.test(c.url.pathname));

  it("sin confirm === true no se envía ni se llama a Google", async () => {
    const s = setup();
    sendRoutes(s);
    for (const confirm of [undefined, false, "true", 1, "yes", null]) {
      await assert.rejects(
        () => draftSend(s.d, USER, { draft_id: "r-1", expected_message_id: "m-vista", confirm }),
        (e: unknown) => e instanceof GoogleInputError && e.code === "confirmacion",
        `confirm=${String(confirm)}`,
      );
    }
    assert.equal(s.calls.length, 0);
  });

  it("exige draft_id y expected_message_id válidos", async () => {
    const s = setup();
    sendRoutes(s);
    await assert.rejects(() => draftSend(s.d, USER, { confirm: true, draft_id: "r-1" }), GoogleInputError);
    await assert.rejects(() => draftSend(s.d, USER, { confirm: true, expected_message_id: "m-vista" }), GoogleInputError);
    await assert.rejects(() => draftSend(s.d, USER, { confirm: true, draft_id: "../r-1", expected_message_id: "m" }), GoogleInputError);
    assert.equal(sends(s).length, 0);
  });

  it("si el borrador cambió desde que lo viste, no se envía", async () => {
    const s = setup();
    sendRoutes(s, "m-OTRA-VERSION");
    await assert.rejects(
      () => draftSend(s.d, USER, { draft_id: "r-1", expected_message_id: "m-vista", confirm: true }),
      (e: unknown) => e instanceof GoogleConflict && e.code === "cambio",
    );
    assert.equal(sends(s).length, 0);
  });

  it("con confirmación y el mismo borrador: comprueba y envía exactamente una vez", async () => {
    const s = setup();
    sendRoutes(s);
    const out = await draftSend(s.d, USER, { draft_id: "r-1", expected_message_id: "m-vista", confirm: true });
    assert.deepEqual(out, { sent: true, message_id: "sent-1", thread_id: "t1" });
    assert.equal(sends(s).length, 1);
    assert.deepEqual(sends(s)[0]!.body, { id: "r-1" });
    const gmail = s.calls.filter((c) => c.url.hostname === "gmail.googleapis.com").map((c) => `${c.method} ${c.url.pathname}`);
    assert.deepEqual(gmail, ["GET /gmail/v1/users/me/drafts/r-1", "POST /gmail/v1/users/me/drafts/send"]);
  });

  it("necesita el permiso de redactar (gmail.compose)", async () => {
    const s = setup({ scopes: [SCOPE_CALENDAR, SCOPE_GMAIL_READ] });
    sendRoutes(s);
    await assert.rejects(() => draftSend(s.d, USER, { draft_id: "r-1", expected_message_id: "m-vista", confirm: true }), GoogleScopeMissing);
  });

  it("ninguna otra operación del módulo envía: crear, editar, listar y leer terminan sin llamar a /send", async () => {
    const s = setup();
    s.on((c) => (c.url.pathname.endsWith("/threads/t1") ? json(threadFor()) : undefined));
    s.on((c) => (c.method === "POST" && c.url.pathname.endsWith("/drafts") ? json({ id: "r-1", message: { id: "m", threadId: "t1" } }) : undefined));
    s.on((c) => (c.method === "GET" && c.url.pathname.endsWith("/drafts") ? json({ drafts: [] }) : undefined));
    s.on((c) => (c.url.pathname.endsWith("/messages") ? json({ messages: [] }) : undefined));
    await draftCreateReply(s.d, USER, { thread_id: "t1", body: "hola" });
    await mailDrafts(s.d, USER);
    await mailImportant(s.d, USER, { rest: true });
    assert.equal(sends(s).length, 0);
  });
});

describe("conectar y desconectar", () => {
  const identity = { sub: "sub-nueva", email: "david@sayainvestments.co", emailVerified: true };
  const tok = { access_token: "ya29.A", expires_in: 3599, refresh_token: "1//NUEVO", scope: `openid email ${ALL.join(" ")}` };

  it("guarda la cuenta y los tokens, con los permisos que Google concedió", async () => {
    const s = setup({ none: true });
    const out = await saveConnection(s.d, USER, identity, { ...tok, scope: `openid email ${SCOPE_CALENDAR}` });
    assert.deepEqual(out, { account_id: "acc-sub-nueva", scopes: ["openid", "email", SCOPE_CALENDAR] });
    assert.deepEqual(parseBundle(s.store.tokens.get("acc-sub-nueva") ?? null), {
      refresh_token: "1//NUEVO", access_token: "ya29.A", access_expires_at: new Date(T0 + 3599_000).toISOString(),
    });
  });

  it("sin refresh_token no guarda nada", async () => {
    const s = setup({ none: true });
    await assert.rejects(() => saveConnection(s.d, USER, identity, { ...tok, refresh_token: undefined }), GoogleTokenError);
    assert.equal(s.store.accounts.size, 0);
  });

  it("conectar otra cuenta reemplaza a la anterior: se revoca en Google y se borra", async () => {
    const s = setup();
    s.on((c) => (c.url.href === "https://oauth2.googleapis.com/revoke" ? json({}) : undefined));
    await saveConnection(s.d, USER, identity, tok);
    assert.deepEqual([...s.store.accounts.keys()], ["acc-sub-nueva"]);
    assert.deepEqual(s.store.deleted, ["acc-1"]);
    const revoke = s.calls.find((c) => c.url.href === "https://oauth2.googleapis.com/revoke")!;
    assert.deepEqual(revoke.body, { token: "1//REFRESH" });
  });

  it("si falla la limpieza de la anterior, la conexión nueva queda igual", async () => {
    const s = setup();
    const original = s.store.deleteAccount.bind(s.store);
    s.store.deleteAccount = async (u, id) => { if (id === "acc-1") throw new Error("boom"); await original(u, id); };
    s.on((c) => (c.url.href === "https://oauth2.googleapis.com/revoke" ? json({}) : undefined));
    const out = await saveConnection(s.d, USER, identity, tok);
    assert.equal(out.account_id, "acc-sub-nueva");
  });

  it("desconectar revoca el token y borra la cuenta; sin cuenta no hace nada", async () => {
    const s = setup();
    s.on((c) => (c.url.href === "https://oauth2.googleapis.com/revoke" ? json({}) : undefined));
    assert.deepEqual(await disconnect(s.d, USER), { disconnected: true });
    assert.equal(s.store.accounts.size, 0);
    assert.equal(s.store.tokens.size, 0);
    assert.deepEqual(await disconnect(s.d, USER), { disconnected: false });
  });

  it("desconectar borra aunque Google falle al revocar", async () => {
    const s = setup();
    s.d.fetch = async () => { throw new Error("sin red"); };
    assert.deepEqual(await disconnect(s.d, USER), { disconnected: true });
    assert.equal(s.store.accounts.size, 0);
  });
});
