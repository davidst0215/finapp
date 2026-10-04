// Módulo google de Wabid: cuenta conectada, token de acceso con renovación automática,
// Calendar (ver, crear, mover) y Gmail (importantes, borradores).
//
// Este archivo solo conecta la lógica (google/core.ts, con sus pruebas) a Deno y Supabase:
//   * variables de entorno (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_STATE_SECRET, APP_URL…)
//   * la base: google_accounts y, para los tokens, solo las RPC google_token_get / google_token_put
//     con el cliente de servicio (los tokens viven cifrados en Vault y nunca llegan al cliente)
//   * el aviso a la bandeja cuando Google cierra la conexión
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { adminClient } from "./http.ts";
import { notify } from "./notify.ts";
import * as core from "./google/core.ts";
import { type Fetcher, GoogleConfigError } from "./google/errors.ts";

export * from "./google/errors.ts";
export type { GoogleAccount, GoogleStatus } from "./google/core.ts";
export type { CalEvent } from "./google/events.ts";
export type { DraftItem, MailItem } from "./google/mail.ts";
export { remitenteCorto, resumenAgenda, resumenCorreo } from "./google/speech.ts";

// ---------------------------------------------------------------- configuración

export type GoogleEnv = { clientId: string; clientSecret: string; stateSecret: string; redirectUri: string; appUrl: string };

const REQUIRED_ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_STATE_SECRET"] as const;

export const missingEnv = () => REQUIRED_ENV.filter((k) => !Deno.env.get(k));

export function googleEnv(): GoogleEnv {
  const missing = missingEnv();
  if (missing.length) throw new GoogleConfigError([...missing]);
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return {
    clientId: Deno.env.get("GOOGLE_CLIENT_ID") as string,
    clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET") as string,
    stateSecret: Deno.env.get("GOOGLE_STATE_SECRET") as string,
    // Debe coincidir EXACTO con el URI autorizado en Google Cloud.
    redirectUri: Deno.env.get("GOOGLE_REDIRECT_URI") ?? `${base}/functions/v1/google-oauth/callback`,
    appUrl: (Deno.env.get("APP_URL") ?? "https://myfinai.vercel.app").replace(/\/+$/, ""),
  };
}

// ---------------------------------------------------------------- almacenamiento real (Supabase + Vault)

const ACCOUNT_COLS = "account_id, email, scopes, status, access_expires_at, last_error, connected_at";

function supabaseStore(db: SupabaseClient): core.GoogleStore {
  return {
    async getAccount(userId) {
      const { data, error } = await db.from("google_accounts").select(ACCOUNT_COLS).eq("user_id", userId)
        .order("status", { ascending: true }) // 'active' < 'revoked'
        .order("connected_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`google_accounts: ${error.message}`);
      return (data?.[0] as core.GoogleAccount | undefined) ?? null;
    },

    async readTokens(accountId, userId) {
      const { data, error } = await db.rpc("google_token_get", { p_account_id: accountId, p_user_id: userId });
      if (error) throw new Error(`google_token_get: ${error.message}`);
      return typeof data === "string" ? data : null;
    },

    async writeTokens(accountId, userId, payload) {
      const { error } = await db.rpc("google_token_put", { p_account_id: accountId, p_user_id: userId, p_payload: payload });
      if (error) throw new Error(`google_token_put: ${error.message}`);
    },

    async setAccessExpiry(accountId, iso) {
      await db.from("google_accounts").update({ access_expires_at: iso, updated_at: new Date().toISOString() }).eq("account_id", accountId);
    },

    async markRevoked(userId, account, why) {
      // Solo avisa la primera vez (active → revoked): sin avisos repetidos mientras siga caída.
      const { data } = await db.from("google_accounts")
        .update({ status: "revoked", last_error: why.slice(0, 200), updated_at: new Date().toISOString() })
        .eq("account_id", account.account_id).eq("status", "active").select("account_id");
      if (data && data.length > 0) {
        await notify(db, userId, {
          kind: "sistema",
          title: "Google se desconectó",
          body: "Vuelve a conectar tu cuenta para usar la agenda y el correo.",
          url: "/agenda",
        });
      }
    },

    async upsertAccount(userId, identity, scopes, accessExpiresAt) {
      const now = new Date().toISOString();
      const { data, error } = await db.from("google_accounts").upsert({
        user_id: userId,
        google_sub: identity.sub,
        email: identity.email,
        scopes,
        status: "active",
        last_error: null,
        access_expires_at: accessExpiresAt,
        connected_at: now,
        updated_at: now,
      }, { onConflict: "user_id,google_sub" }).select("account_id").single();
      if (error || !data) throw new Error(`google_accounts upsert: ${error?.message ?? "sin datos"}`);
      return data.account_id as string;
    },

    async accountIds(userId) {
      const { data, error } = await db.from("google_accounts").select("account_id").eq("user_id", userId);
      if (error) throw new Error(`google_accounts: ${error.message}`);
      return (data ?? []).map((r) => r.account_id as string);
    },

    async deleteAccount(userId, accountId) {
      const { error } = await db.from("google_accounts").delete().eq("account_id", accountId).eq("user_id", userId);
      if (error) throw new Error(`google_accounts delete: ${error.message}`);
    },
  };
}

const fetchFn: Fetcher = (input, init) => fetch(input, init);

const deps = (): core.Deps => ({
  store: supabaseStore(adminClient()),
  fetch: fetchFn,
  now: () => Date.now(),
  credentials: () => {
    const e = googleEnv();
    return { clientId: e.clientId, clientSecret: e.clientSecret };
  },
  configured: () => missingEnv().length === 0,
});

// Cada función de core con las dependencias reales ya puestas.
const bind = <A extends unknown[], R>(fn: (d: core.Deps, ...args: A) => R) => (...args: A): R => fn(deps(), ...args);

export const googleStatus = bind(core.googleStatus);
export const saveConnection = bind(core.saveConnection);
export const disconnect = bind(core.disconnect);

export const calendarEvents = bind(core.calendarEvents);
export const calendarCreate = bind(core.calendarCreate);
export const calendarMove = bind(core.calendarMove);

export const mailImportant = bind(core.mailImportant);
export const mailDrafts = bind(core.mailDrafts);
export const draftCreateReply = bind(core.draftCreateReply);
export const draftUpdateBody = bind(core.draftUpdateBody);
// ÚNICA vía para enviar un correo desde Wabid (exige confirm=true y el borrador sin cambios). Las tools del agente no la importan.
export const draftSend = bind(core.draftSend);
