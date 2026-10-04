// Lógica del módulo google con sus dependencias inyectadas (almacenamiento, fetch, reloj, credenciales):
// token de acceso con renovación automática, Calendar (ver, crear, mover) y Gmail (importantes, borradores).
// No toca Deno ni Supabase: `_shared/google.ts` la conecta a la base real y las pruebas la conectan a una falsa.
//
// Reglas que este archivo hace cumplir:
//   * Calendar: sendUpdates=none y sin invitados. Mover un evento con invitados exige confirmación.
//   * Gmail: se crean y editan borradores; se envía SOLO con draftSend, que exige confirmación explícita
//     y que el borrador sea el mismo que David revisó. Las tools del agente no lo importan.
import {
  calendarGet,
  calendarInsert,
  calendarList,
  calendarPatchTimes,
  draftCreate as apiDraftCreate,
  draftGet,
  draftsList,
  draftSendRequest,
  draftUpdate as apiDraftUpdate,
  gmailGetMeta,
  gmailListIds,
  gmailThreadMeta,
} from "./api.ts";
import {
  accessTokenUsable,
  type Capabilities,
  capabilitiesOf,
  type GoogleIdentity,
  hasScope,
  parseBundle,
  parseScopes,
  refreshAccessToken,
  revokeToken,
  serializeBundle,
  type TokenResponse,
} from "./auth.ts";
import {
  type Fetcher,
  GoogleApiError,
  GoogleConflict,
  GoogleInputError,
  GoogleNotConnected,
  GoogleReauth,
  GoogleScopeMissing,
  GoogleTokenError,
  type Need,
} from "./errors.ts";
import {
  type CalEvent,
  compareEvents,
  findOverlaps,
  isGoogleId,
  mapEvent,
  moveBody,
  normalizeMove,
  normalizeNewEvent,
  type RawEvent,
} from "./events.ts";
import {
  buildRaw,
  type DraftItem,
  type GDraft,
  type GMessage,
  mapDraft,
  mapMessage,
  MAX_BODY_CHARS,
  type MailItem,
  rebuildDraft,
  replyTarget,
} from "./mail.ts";
import { limaRange } from "./time.ts";

// ---------------------------------------------------------------- dependencias

export type GoogleAccount = {
  account_id: string;
  email: string;
  scopes: string[];
  status: "active" | "revoked";
  access_expires_at: string | null;
  last_error: string | null;
  connected_at: string;
};

// Todo lo que el módulo necesita de la base. Implementación real: _shared/google.ts (Supabase + Vault).
export interface GoogleStore {
  // Cuenta activa más reciente; si no hay, la revocada más reciente (para avisar que hay que reconectar).
  getAccount(userId: string): Promise<GoogleAccount | null>;
  // JSON descifrado de los tokens (null si no existen).
  readTokens(accountId: string, userId: string): Promise<string | null>;
  writeTokens(accountId: string, userId: string, payload: string): Promise<void>;
  setAccessExpiry(accountId: string, iso: string): Promise<void>;
  // Pasa la cuenta a revocada y avisa a David la primera vez (active → revoked).
  markRevoked(userId: string, account: GoogleAccount, why: string): Promise<void>;
  upsertAccount(userId: string, identity: GoogleIdentity, scopes: string[], accessExpiresAt: string): Promise<string>;
  accountIds(userId: string): Promise<string[]>;
  deleteAccount(userId: string, accountId: string): Promise<void>;
}

export type Deps = {
  store: GoogleStore;
  fetch: Fetcher;
  now: () => number;
  credentials: () => { clientId: string; clientSecret: string };
  configured: () => boolean;
};

// ---------------------------------------------------------------- estado

export type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  reauth: boolean; // había una cuenta, pero Google cerró la conexión
  account: { email: string; capabilities: Capabilities; connected_at: string; access_expires_at: string | null } | null;
};

export async function googleStatus(d: Deps, userId: string): Promise<GoogleStatus> {
  const configured = d.configured();
  const account = await d.store.getAccount(userId);
  if (!account) return { configured, connected: false, reauth: false, account: null };
  const active = account.status === "active";
  return {
    configured,
    connected: active,
    reauth: !active,
    account: {
      email: account.email,
      capabilities: capabilitiesOf(account.scopes),
      connected_at: account.connected_at,
      access_expires_at: account.access_expires_at,
    },
  };
}

// ---------------------------------------------------------------- token de acceso

async function accessToken(d: Deps, userId: string, account: GoogleAccount, force = false): Promise<string> {
  const bundle = parseBundle(await d.store.readTokens(account.account_id, userId));
  if (!bundle) {
    await d.store.markRevoked(userId, account, "sin_token");
    throw new GoogleReauth();
  }
  if (!force && accessTokenUsable(bundle, d.now()) && bundle.access_token) return bundle.access_token;

  const { clientId, clientSecret } = d.credentials();
  let tok: TokenResponse;
  try {
    tok = await refreshAccessToken(d.fetch, { clientId, clientSecret, refreshToken: bundle.refresh_token });
  } catch (e) {
    if (e instanceof GoogleTokenError && e.code === "invalid_grant") {
      await d.store.markRevoked(userId, account, "invalid_grant");
      throw new GoogleReauth();
    }
    throw e;
  }
  const expiresAt = new Date(d.now() + tok.expires_in * 1000).toISOString();
  // Google no suele devolver un refresh_token nuevo al renovar: se conserva el que ya teníamos.
  await d.store.writeTokens(
    account.account_id,
    userId,
    serializeBundle({ refresh_token: tok.refresh_token ?? bundle.refresh_token, access_token: tok.access_token, access_expires_at: expiresAt }),
  );
  await d.store.setAccessExpiry(account.account_id, expiresAt);
  return tok.access_token;
}

// Ejecuta `fn` con un token vigente. Si Google responde 401 (token invalidado antes de tiempo) renueva y reintenta una vez.
// `needs`: permisos que la operación exige; con mode "any" basta uno.
export async function withGoogle<T>(
  d: Deps,
  userId: string,
  needs: Need[],
  fn: (token: string, account: GoogleAccount) => Promise<T>,
  mode: "all" | "any" = "all",
): Promise<T> {
  const account = await d.store.getAccount(userId);
  if (!account) throw new GoogleNotConnected();
  if (account.status !== "active") throw new GoogleReauth();
  const ok = mode === "all" ? needs.every((n) => hasScope(account.scopes, n)) : needs.some((n) => hasScope(account.scopes, n));
  if (!ok) throw new GoogleScopeMissing(needs.find((n) => !hasScope(account.scopes, n)) ?? (needs[0] as Need));

  let token = await accessToken(d, userId, account);
  try {
    return await fn(token, account);
  } catch (e) {
    if (e instanceof GoogleApiError && e.status === 401) {
      token = await accessToken(d, userId, account, true);
      return await fn(token, account);
    }
    throw e;
  }
}

// ---------------------------------------------------------------- conectar y desconectar

async function removeAccount(d: Deps, userId: string, accountId: string) {
  const bundle = parseBundle(await d.store.readTokens(accountId, userId));
  if (bundle) {
    try {
      await revokeToken(d.fetch, bundle.refresh_token); // si Google falla igual se borra lo nuestro
    } catch (e) {
      console.error("revoke:", e instanceof Error ? e.message : e);
    }
  }
  // El borrado en cascada elimina google_tokens y un trigger elimina el secreto de Vault.
  await d.store.deleteAccount(userId, accountId);
}

// Guarda la cuenta y sus tokens (cifrados en Vault) tras el consentimiento. Devuelve los permisos concedidos.
export async function saveConnection(d: Deps, userId: string, identity: GoogleIdentity, tok: TokenResponse): Promise<{ account_id: string; scopes: string[] }> {
  if (!tok.refresh_token) throw new GoogleTokenError(400, "sin_refresh", "Google no devolvió refresh_token");
  const scopes = parseScopes(tok.scope);
  const expiresAt = new Date(d.now() + tok.expires_in * 1000).toISOString();

  const accountId = await d.store.upsertAccount(userId, identity, scopes, expiresAt);
  await d.store.writeTokens(
    accountId,
    userId,
    serializeBundle({ refresh_token: tok.refresh_token, access_token: tok.access_token, access_expires_at: expiresAt }),
  );

  // Hoy Wabid usa UNA cuenta: conectar otra reemplaza a la anterior (se revoca y se borra, sin tokens huérfanos).
  for (const other of (await d.store.accountIds(userId)).filter((id) => id !== accountId)) {
    try {
      await removeAccount(d, userId, other);
    } catch (e) {
      console.error("limpieza de cuenta anterior:", e instanceof Error ? e.message : e); // la conexión nueva ya quedó guardada
    }
  }
  return { account_id: accountId, scopes };
}

export async function disconnect(d: Deps, userId: string): Promise<{ disconnected: boolean }> {
  const ids = await d.store.accountIds(userId);
  for (const id of ids) await removeAccount(d, userId, id);
  return { disconnected: ids.length > 0 };
}

// ---------------------------------------------------------------- Calendar

const mapAll = (raw: RawEvent[]) => raw.map(mapEvent).filter((e): e is CalEvent => e !== null);

export function calendarEvents(d: Deps, userId: string, fromKey: string, days: number): Promise<CalEvent[]> {
  return withGoogle(d, userId, ["calendar"], async (token) => {
    const raw = await calendarList(d.fetch, token, limaRange(fromKey, days));
    return mapAll(raw).sort(compareEvents);
  });
}

export async function calendarCreate(d: Deps, userId: string, input: Record<string, unknown>): Promise<{ event: CalEvent; overlaps: string[] }> {
  const ev = normalizeNewEvent(input);
  return await withGoogle(d, userId, ["calendar"], async (token) => {
    // Cruces con lo que ya hay ese día (se avisa, no se bloquea: David pidió el evento).
    const day = mapAll(await calendarList(d.fetch, token, limaRange(ev.date, ev.end_date === ev.date ? 1 : 2)));
    const crossing = findOverlaps(day, Date.parse(ev.start), Date.parse(ev.end));

    let raw: RawEvent;
    try {
      raw = await calendarInsert(d.fetch, token, { id: ev.event_id, title: ev.title, start: ev.start, end: ev.end, location: ev.location, description: ev.description });
    } catch (e) {
      // El mismo envío repetido (doble toque, reintento de red) cae en el mismo id: ya existe, se devuelve ese.
      if (ev.event_id && e instanceof GoogleApiError && e.status === 409) raw = await calendarGet(d.fetch, token, ev.event_id);
      else throw e;
    }
    const event = mapEvent(raw);
    if (!event) throw new Error("Calendar devolvió un evento ilegible");
    return { event, overlaps: crossing.filter((c) => c.id !== event.id).map((c) => c.title) };
  });
}

export async function calendarMove(d: Deps, userId: string, input: Record<string, unknown>): Promise<{ event: CalEvent }> {
  const mv = normalizeMove(input);
  return await withGoogle(d, userId, ["calendar"], async (token) => {
    const current = mapEvent(await calendarGet(d.fetch, token, mv.event_id));
    if (!current) throw new GoogleInputError("Ese evento ya no existe.");
    // Mover un evento con invitados cambia SU calendario aunque no se les avise: pide confirmación explícita.
    if (current.guests > 0 && !mv.confirm_guests) {
      throw new GoogleConflict(
        "invitados",
        `«${current.title}» tiene ${current.guests} ${current.guests === 1 ? "invitado" : "invitados"}. Moverlo cambia su calendario y no se les avisa. Confirma para continuar.`,
        { guests: current.guests, guest_names: current.guest_names, title: current.title },
      );
    }
    const body = moveBody(current, mv);
    const raw = await calendarPatchTimes(d.fetch, token, mv.event_id, { start: body.start, end: body.end });
    const event = mapEvent(raw);
    if (!event) throw new Error("Calendar devolvió un evento ilegible");
    return { event };
  });
}

// ---------------------------------------------------------------- Gmail: lectura

export const IMPORTANT_Q = "in:inbox is:important newer_than:7d -category:promotions -category:social";
export const REST_Q = "in:inbox -is:important newer_than:7d";

async function fetchMail(d: Deps, token: string, q: string, max: number): Promise<MailItem[]> {
  const refs = await gmailListIds(d.fetch, token, q, max);
  const settled = await Promise.allSettled(refs.map((r) => gmailGetMeta(d.fetch, token, r.id)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<GMessage> => s.status === "fulfilled");
  const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
  // Si fallaron todos es un problema real (token, permisos); si falló alguno suelto, se omite (p. ej. lo borraron en el medio).
  if (ok.length === 0 && failed.length > 0) throw (failed[0] as PromiseRejectedResult).reason;
  return ok.map((s) => mapMessage(s.value)).filter((m): m is MailItem => m !== null)
    .sort((a, b) => b.received_at.localeCompare(a.received_at));
}

export function mailImportant(d: Deps, userId: string, opts: { max?: number; rest?: boolean } = {}): Promise<{ important: MailItem[]; rest: MailItem[] }> {
  const max = Math.min(Math.max(opts.max ?? 10, 1), 25);
  return withGoogle(d, userId, ["gmail_read"], async (token) => {
    const [important, rest] = await Promise.all([
      fetchMail(d, token, IMPORTANT_Q, max),
      opts.rest ? fetchMail(d, token, REST_Q, max) : Promise.resolve([] as MailItem[]),
    ]);
    return { important, rest };
  });
}

// ---------------------------------------------------------------- Gmail: borradores

export function mailDrafts(d: Deps, userId: string, max = 10): Promise<DraftItem[]> {
  const n = Math.min(Math.max(max, 1), 25);
  // drafts.list/get aceptan gmail.readonly o gmail.compose: basta uno.
  return withGoogle(d, userId, ["gmail_read", "gmail_compose"], async (token) => {
    const refs = await draftsList(d.fetch, token, n);
    const settled = await Promise.allSettled(refs.map((r) => draftGet(d.fetch, token, r.id, "full")));
    const ok = settled.filter((s): s is PromiseFulfilledResult<GDraft> => s.status === "fulfilled");
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    if (ok.length === 0 && failed.length > 0) throw (failed[0] as PromiseRejectedResult).reason;
    return ok.map((s) => mapDraft(s.value)).filter((x): x is DraftItem => x !== null)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, "any");
}

const cleanBody = (v: unknown): string => {
  const body = typeof v === "string" ? v.replace(/\u0000/g, "").trim() : "";
  if (!body) throw new GoogleInputError("El borrador no puede estar vacío.");
  if (body.length > MAX_BODY_CHARS) throw new GoogleInputError(`El texto es demasiado largo (máximo ${MAX_BODY_CHARS} caracteres).`);
  return body;
};

// Crea un borrador de respuesta DENTRO del hilo (In-Reply-To, References, mismo asunto y threadId).
// Nunca envía: el borrador queda en Gmail para que David lo revise y lo envíe desde Wabid.
export async function draftCreateReply(d: Deps, userId: string, input: Record<string, unknown>): Promise<DraftItem> {
  if (!isGoogleId(input.thread_id)) throw new GoogleInputError("Falta el hilo al que responder.");
  if (input.message_id !== undefined && !isGoogleId(input.message_id)) throw new GoogleInputError("El mensaje al que responder no es válido.");
  const body = cleanBody(input.body);
  const threadId = input.thread_id;
  const messageId = typeof input.message_id === "string" ? input.message_id : undefined;

  return await withGoogle(d, userId, ["gmail_read", "gmail_compose"], async (token, account) => {
    const thread = await gmailThreadMeta(d.fetch, token, threadId);
    const target = replyTarget(thread, account.email, messageId, input.use_reply_to === true);
    if (!target) throw new GoogleInputError("No pude saber a quién responder en ese hilo.");
    const raw = buildRaw({ to: target.to, subject: target.subject, body, inReplyTo: target.in_reply_to, references: target.references });
    const draft = await apiDraftCreate(d.fetch, token, raw, target.thread_id);
    if (!draft.id || !draft.message?.id) throw new Error("Gmail devolvió un borrador ilegible");
    return {
      draft_id: draft.id,
      message_id: draft.message.id,
      thread_id: target.thread_id,
      to: target.to.map((a) => a.name || a.email).join(", "),
      to_email: target.to.map((a) => a.email).join(", "),
      subject: target.subject,
      body,
      snippet: body.slice(0, 120),
      updated_at: new Date(d.now()).toISOString(),
      cc: "",
      bcc: "",
      notice: target.reply_to_differs && input.use_reply_to === true
        ? `La respuesta irá a ${target.to.map((a) => a.email).join(", ")}, un dominio distinto al del remitente. Revísalo antes de enviar.`
        : undefined,
      editable: true,
    };
  });
}

// Cambia el texto de un borrador conservando destinatarios, asunto e hilo.
export async function draftUpdateBody(d: Deps, userId: string, input: Record<string, unknown>): Promise<DraftItem> {
  if (!isGoogleId(input.draft_id)) throw new GoogleInputError("Falta el borrador a editar.");
  const body = cleanBody(input.body);
  const draftId = input.draft_id;

  return await withGoogle(d, userId, ["gmail_read", "gmail_compose"], async (token) => {
    const current = await draftGet(d.fetch, token, draftId, "full");
    const before = mapDraft(current);
    if (!before) throw new GoogleInputError("Ese borrador ya no existe.");
    if (!before.editable) {
      throw new GoogleConflict("adjuntos", "Este borrador tiene adjuntos. Edítalo en Gmail para no perderlos.");
    }
    const { raw, threadId } = rebuildDraft(current, body);
    await apiDraftUpdate(d.fetch, token, draftId, raw, threadId);
    // Se vuelve a leer: destinatarios, copias y message_id salen de lo que quedó guardado en Gmail, no del borrador viejo.
    const fresh = mapDraft(await draftGet(d.fetch, token, draftId, "full"));
    if (!fresh) throw new Error("Gmail devolvió un borrador ilegible");
    return fresh;
  });
}

// ÚNICA vía para enviar un correo desde Wabid. Exige:
//   1. confirm === true  (lo manda la UI solo tras el toque de "Enviar ahora" en el diálogo de confirmación)
//   2. expected_message_id = el mensaje del borrador que David vio; si el borrador cambió, no se envía.
export async function draftSend(d: Deps, userId: string, input: Record<string, unknown>): Promise<{ sent: true; message_id: string; thread_id: string }> {
  if (input.confirm !== true) throw new GoogleInputError("Falta la confirmación explícita para enviar.", "confirmacion");
  if (!isGoogleId(input.draft_id) || !isGoogleId(input.expected_message_id)) {
    throw new GoogleInputError("Faltan datos del borrador a enviar.");
  }
  const draftId = input.draft_id;
  const expected = input.expected_message_id;

  return await withGoogle(d, userId, ["gmail_compose"], async (token) => {
    const current = await draftGet(d.fetch, token, draftId, "minimal");
    if (current.message?.id !== expected) {
      throw new GoogleConflict("cambio", "El borrador cambió desde que lo revisaste. Ábrelo de nuevo antes de enviarlo.");
    }
    const sent = await draftSendRequest(d.fetch, token, draftId);
    return { sent: true as const, message_id: sent.id ?? "", thread_id: sent.threadId ?? "" };
  });
}
