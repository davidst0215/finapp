// Llamadas HTTP a Google Calendar v3 y Gmail v1. Lógica pura: el `fetch` y el token se inyectan,
// así las pruebas comprueban la URL, los parámetros y el cuerpo exactos de cada pedido.
// Formatos verificados en la documentación oficial:
//   https://developers.google.com/workspace/calendar/api/v3/reference/events
//   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts
//   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
import { type Fetcher, GoogleApiError } from "./errors.ts";
import type { GDraft, GMessage } from "./mail.ts";
import type { RawEvent } from "./events.ts";
import { LIMA_TZ } from "./time.ts";

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// Encabezados que se piden en format=metadata (lo demás no hace falta para listar ni para responder).
export const META_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "In-Reply-To", "References"] as const;

async function toApiError(res: Response): Promise<GoogleApiError> {
  const reasons: string[] = [];
  let message = res.statusText;
  try {
    const j = await res.json();
    const e = j?.error;
    if (e && typeof e === "object") {
      if (typeof e.message === "string") message = e.message;
      for (const x of Array.isArray(e.errors) ? e.errors : []) if (typeof x?.reason === "string") reasons.push(x.reason);
      for (const x of Array.isArray(e.details) ? e.details : []) if (typeof x?.reason === "string") reasons.push(x.reason);
      if (typeof e.status === "string") reasons.push(e.status);
    }
  } catch { /* cuerpo vacío o no JSON */ }
  return new GoogleApiError(res.status, reasons, message.slice(0, 300));
}

async function call<T>(f: Fetcher, token: string, method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

// ---------------------------------------------------------------- Calendar

// Eventos de [timeMin, timeMax) con las repeticiones ya expandidas y ordenados por inicio.
// timeMin/timeMax son RFC 3339 con desfase (p. ej. 2026-10-05T00:00:00-05:00).
export async function calendarList(f: Fetcher, token: string, w: { timeMin: string; timeMax: string }, max = 250): Promise<RawEvent[]> {
  const u = new URL(`${CAL}/events`);
  u.searchParams.set("timeMin", w.timeMin);
  u.searchParams.set("timeMax", w.timeMax);
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("timeZone", LIMA_TZ);
  u.searchParams.set("maxResults", String(Math.min(250, max)));
  const j = await call<{ items?: RawEvent[] }>(f, token, "GET", u.toString());
  return j.items ?? [];
}

export const calendarGet = (f: Fetcher, token: string, eventId: string) =>
  call<RawEvent>(f, token, "GET", `${CAL}/events/${encodeURIComponent(eventId)}`);

export type EventInsert = { id?: string; title: string; start: string; end: string; location?: string; description?: string };

// Crea el evento SOLO para David: sin `attendees` (no se invita a nadie) y con sendUpdates=none (no se avisa a nadie).
export function calendarInsert(f: Fetcher, token: string, ev: EventInsert): Promise<RawEvent> {
  const body: Record<string, unknown> = {
    summary: ev.title,
    start: { dateTime: ev.start, timeZone: LIMA_TZ },
    end: { dateTime: ev.end, timeZone: LIMA_TZ },
  };
  if (ev.id) body.id = ev.id;
  if (ev.location) body.location = ev.location;
  if (ev.description) body.description = ev.description;
  return call<RawEvent>(f, token, "POST", `${CAL}/events?sendUpdates=none`, body);
}

// Mueve/reprograma con PATCH (solo cambia start y end) y sendUpdates=none: no se envía aviso a los invitados.
export const calendarPatchTimes = (
  f: Fetcher,
  token: string,
  eventId: string,
  times: { start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string } },
) => call<RawEvent>(f, token, "PATCH", `${CAL}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, times);

// ---------------------------------------------------------------- Gmail: lectura

export async function gmailListIds(f: Fetcher, token: string, q: string, max: number): Promise<{ id: string; threadId: string }[]> {
  const u = new URL(`${GMAIL}/messages`);
  u.searchParams.set("q", q);
  u.searchParams.set("maxResults", String(max));
  const j = await call<{ messages?: { id: string; threadId: string }[] }>(f, token, "GET", u.toString());
  return j.messages ?? [];
}

function withMetaHeaders(u: URL) {
  u.searchParams.set("format", "metadata");
  for (const h of META_HEADERS) u.searchParams.append("metadataHeaders", h);
}

export function gmailGetMeta(f: Fetcher, token: string, id: string): Promise<GMessage> {
  const u = new URL(`${GMAIL}/messages/${encodeURIComponent(id)}`);
  withMetaHeaders(u);
  return call<GMessage>(f, token, "GET", u.toString());
}

export function gmailThreadMeta(f: Fetcher, token: string, threadId: string): Promise<{ id?: string; messages?: GMessage[] }> {
  const u = new URL(`${GMAIL}/threads/${encodeURIComponent(threadId)}`);
  withMetaHeaders(u);
  return call(f, token, "GET", u.toString());
}

// ---------------------------------------------------------------- Gmail: borradores

export async function draftsList(f: Fetcher, token: string, max: number): Promise<{ id: string }[]> {
  const u = new URL(`${GMAIL}/drafts`);
  u.searchParams.set("maxResults", String(max));
  const j = await call<{ drafts?: { id: string }[] }>(f, token, "GET", u.toString());
  return j.drafts ?? [];
}

// format=full trae encabezados y cuerpo; format=minimal solo ids (sirve para comprobar que no cambió).
export function draftGet(f: Fetcher, token: string, id: string, format: "full" | "minimal"): Promise<GDraft> {
  const u = new URL(`${GMAIL}/drafts/${encodeURIComponent(id)}`);
  u.searchParams.set("format", format);
  return call<GDraft>(f, token, "GET", u.toString());
}

const draftBody = (raw: string, threadId?: string) => ({ message: threadId ? { raw, threadId } : { raw } });

export const draftCreate = (f: Fetcher, token: string, raw: string, threadId?: string) =>
  call<GDraft>(f, token, "POST", `${GMAIL}/drafts`, draftBody(raw, threadId));

export const draftUpdate = (f: Fetcher, token: string, id: string, raw: string, threadId?: string) =>
  call<GDraft>(f, token, "PUT", `${GMAIL}/drafts/${encodeURIComponent(id)}`, { id, ...draftBody(raw, threadId) });

// ÚNICO lugar del módulo que envía un correo. Solo lo llama `draftSend` de google.ts, que exige confirmación.
export const draftSendRequest = (f: Fetcher, token: string, id: string) =>
  call<GMessage>(f, token, "POST", `${GMAIL}/drafts/send`, { id });
