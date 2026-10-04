// node --experimental-strip-types --test supabase/functions/_shared/google/invariantes.test.ts
// Guardas de código: lo que NUNCA debe pasar en el módulo google, comprobado leyendo las fuentes.
// Si alguien lo rompe en el futuro, esta prueba falla antes de que llegue a producción.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS = join(HERE, "..", "..");
const REPO = join(FUNCTIONS, "..", "..");
const read = (...p: string[]) => readFileSync(join(FUNCTIONS, ...p), "utf8");
const readRepo = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");

// Fuentes de producción del módulo (sin pruebas), con los comentarios quitados para no confundir texto con código.
const noComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const prod = (dir: string) =>
  readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => ({ file: join(dir, f), src: noComments(readFileSync(join(dir, f), "utf8")) }));

const moduleFiles = [
  ...prod(HERE),
  { file: join(FUNCTIONS, "_shared", "google.ts"), src: noComments(read("_shared", "google.ts")) },
  { file: join(FUNCTIONS, "google", "index.ts"), src: noComments(read("google", "index.ts")) },
  { file: join(FUNCTIONS, "google-oauth", "index.ts"), src: noComments(read("google-oauth", "index.ts")) },
  { file: join(FUNCTIONS, "agent", "tools", "agenda.ts"), src: noComments(read("agent", "tools", "agenda.ts")) },
  { file: join(FUNCTIONS, "agent", "tools", "correo.ts"), src: noComments(read("agent", "tools", "correo.ts")) },
];
const rel = (f: string) => relative(FUNCTIONS, f).replaceAll("\\", "/");
const filesMatching = (re: RegExp) => moduleFiles.filter((f) => re.test(f.src)).map((f) => rel(f.file));

describe("nunca se envía un correo por accidente", () => {
  it("la llamada de envío de Gmail (/drafts/send, /messages/send) vive solo en api.ts", () => {
    assert.deepEqual(filesMatching(/drafts\/send|messages\/send|users\.messages\.send/), ["_shared/google/api.ts"]);
  });

  it("solo core.ts usa draftSendRequest, y solo dentro de draftSend", () => {
    assert.deepEqual(filesMatching(/draftSendRequest/).sort(), ["_shared/google/api.ts", "_shared/google/core.ts"]);
    const core = noComments(read("_shared", "google", "core.ts"));
    const uses = [...core.matchAll(/draftSendRequest\(/g)];
    assert.equal(uses.length, 1);
    const draftSendFn = core.slice(core.indexOf("export async function draftSend("));
    assert.ok(draftSendFn.includes("draftSendRequest("), "la única llamada está dentro de draftSend");
    assert.ok(core.indexOf("draftSendRequest(") > core.indexOf("export async function draftSend("));
  });

  it("draftSend exige confirm === true estricto antes de tocar la red", () => {
    const core = noComments(read("_shared", "google", "core.ts"));
    const body = core.slice(core.indexOf("export async function draftSend("));
    assert.match(body, /input\.confirm !== true/);
    assert.ok(body.indexOf("input.confirm !== true") < body.indexOf("withGoogle("));
    assert.match(body, /expected_message_id/);
  });

  it("las tools del agente no pueden enviar: no importan ni mencionan draftSend", () => {
    for (const tool of ["agenda.ts", "correo.ts"]) {
      const src = noComments(read("agent", "tools", tool));
      assert.doesNotMatch(src, /draftSend|sendDraft|drafts\/send|messages\/send|send_mail|mail_send|send_email/i, `${tool} menciona un envío`);
    }
    const correo = noComments(read("agent", "tools", "correo.ts"));
    assert.deepEqual(
      [...correo.matchAll(/import \{([^}]*)\} from "..\/..\/_shared\/google\.ts"/g)].flatMap((m) => (m[1] as string).split(",").map((x) => x.trim()).filter(Boolean)).sort(),
      ["describeError", "draftCreateReply", "mailImportant", "remitenteCorto", "resumenCorreo"],
    );
  });

  it("la función HTTP expone el envío solo en la acción draft.send", () => {
    const src = noComments(read("google", "index.ts"));
    assert.deepEqual([...src.matchAll(/google\.draftSend\(/g)].length, 1);
    assert.match(src, /case "draft\.send":\s*\n\s*return json\(await google\.draftSend\(userId, body\)\)/);
  });
});

describe("nunca se invita ni se avisa a terceros", () => {
  it("toda escritura en Calendar lleva sendUpdates=none", () => {
    const api = noComments(read("_shared", "google", "api.ts"));
    const writes = [...api.matchAll(/call<[^>]*>\(f, token, "(POST|PATCH|PUT)", (`[^`]*`)/g)].filter((m) => (m[2] as string).includes("/events"));
    assert.equal(writes.length, 2, "crear y mover");
    for (const w of writes) assert.match(w[2] as string, /\?sendUpdates=none/, `${w[1]} ${w[2]}`);
  });

  it("el cuerpo para crear un evento no incluye asistentes", () => {
    const api = noComments(read("_shared", "google", "api.ts"));
    assert.doesNotMatch(api, /attendees|conferenceData|guestsCanInviteOthers|sendNotifications/);
    const events = noComments(read("_shared", "google", "events.ts"));
    assert.doesNotMatch(events.slice(events.indexOf("export function normalizeNewEvent")), /attendees/);
  });

  it("no se piden permisos de más: ni gmail.send, ni gmail.modify, ni el calendario completo", () => {
    const auth = noComments(read("_shared", "google", "auth.ts"));
    assert.doesNotMatch(auth, /gmail\.send|gmail\.modify|mail\.google\.com|auth\/calendar["'`]/);
  });
});

describe("el callback y los tokens", () => {
  it("el callback redirige solo a la URL fija de la app (sin open redirect)", () => {
    const src = noComments(read("google-oauth", "index.ts"));
    assert.doesNotMatch(src, /searchParams\.get\(["'](redirect|return|next|url|to)/i);
    // Cada llamada a backToApp(…) usa la URL de la app de la configuración, nunca algo que venga en la petición.
    const redirects = [...src.matchAll(/(?<!function )backToApp\(([^,)]+)/g)].map((m) => (m[1] as string).trim());
    assert.ok(redirects.length >= 8);
    assert.ok(redirects.every((r) => r === "env.appUrl" || r.startsWith('(Deno.env.get("APP_URL"')), redirects.join(" | "));
    assert.match(src, /new URL\("\/agenda", appUrl\)/);
  });

  it("start no acepta permisos ni user_id del cliente: el user_id sale del JWT y los scopes son constantes", () => {
    const src = noComments(read("google-oauth", "index.ts"));
    assert.match(src, /signState\(env\.stateSecret, auth\.user\.id,/);
    assert.doesNotMatch(src, /body\??\.(scope|scopes|user_id|userId)/);
  });

  it("los tokens solo se leen con RPC de servicio: ninguna consulta directa a google_tokens", () => {
    for (const f of moduleFiles) assert.doesNotMatch(f.src, /from\(["']google_tokens["']\)/, rel(f.file));
    assert.deepEqual(filesMatching(/google_token_get/), ["_shared/google.ts"]);
  });

  it("la UI nunca pide tokens ni llama a las RPC de tokens", () => {
    const web = join(REPO, "apps", "web", "src");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(web).filter((x) => /\.(ts|tsx)$/.test(x))) {
      assert.doesNotMatch(readFileSync(f, "utf8"), /google_token|google_tokens|refresh_token/, relative(web, f));
    }
  });

  it("la migración deja los tokens solo para service_role", () => {
    const sql = readRepo("supabase", "migrations", "007_google.sql");
    assert.match(sql, /ALTER TABLE google_tokens ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON google_tokens FROM anon, authenticated/);
    assert.doesNotMatch(sql, /CREATE POLICY\s+\w+\s+ON google_tokens/i);
    assert.match(sql, /REVOKE ALL ON FUNCTION google_token_get\(UUID, UUID\) FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /REVOKE ALL ON FUNCTION google_token_put\(UUID, UUID, TEXT\) FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION google_token_get\(UUID, UUID\) TO service_role/);
    assert.doesNotMatch(sql, /GRANT[^;]*google_token[^;]*(anon|authenticated)/i);
    assert.match(sql, /SET search_path = ''/);
  });
});
