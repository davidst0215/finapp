// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/events.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSession, parseDeviceEvent, planNotice, summarizeEvent } from "./events.ts";
import type { ParsedEvent, SessionRow } from "./types.ts";

const parsed = (body: unknown) => {
  const r = parseDeviceEvent(body);
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; event: ParsedEvent }).event;
};

const rejected = (body: unknown) => {
  const r = parseDeviceEvent(body);
  assert.equal(r.ok, false, `debió rechazar ${JSON.stringify(body)?.slice(0, 80)}`);
  return (r as { ok: false; error: string }).error;
};

// --- parseDeviceEvent -------------------------------------------------------------------------------------

test("un evento mínimo válido recibe valores por defecto", () => {
  assert.deepEqual(parsed({ type: "stop", session_id: "abc123" }), {
    type: "stop",
    sessionId: "abc123",
    project: "",
    cwd: null,
    detail: "",
    message: "",
    toolName: "",
    preview: "",
    previewTruncated: false,
    description: "",
  });
});

test("rechaza cuerpos que no son objetos, tipos desconocidos y session_id inválidos", () => {
  for (const body of [null, undefined, "x", 3, [], {}, { type: "stop" }, { session_id: "abc" }]) rejected(body);
  rejected({ type: "otro", session_id: "abc" });
  rejected({ type: "stop", session_id: "tiene espacios" });
  rejected({ type: "stop", session_id: "a".repeat(101) });
  rejected({ type: "stop", session_id: 123 });
});

test("permission_request exige herramienta y vista previa", () => {
  rejected({ type: "permission_request", session_id: "abc" });
  rejected({ type: "permission_request", session_id: "abc", tool_name: "Bash" });
  rejected({ type: "permission_request", session_id: "abc", tool_name: "Bash", preview: "   " });
  rejected({ type: "permission_request", session_id: "abc", tool_name: "con espacios", preview: "ls" });
  const ev = parsed({ type: "permission_request", session_id: "abc", tool_name: "Bash", preview: "ls" });
  assert.equal(ev.toolName, "Bash");
});

test("el servidor vuelve a redactar secretos aunque el cliente no lo haya hecho", () => {
  const ev = parsed({
    type: "permission_request",
    session_id: "abc",
    project: "finapp sk-ant-api03-AbCdEf0123456789xyzXYZ",
    cwd: "~/x?token=abcd1234efgh",
    message: "PGPASSWORD=hunter2hunter",
    tool_name: "Bash",
    preview: "curl -H 'Authorization: Bearer abcdef1234567890XYZ' https://x.test",
    description: "usa --password=topsecret123",
  });
  const all = JSON.stringify(ev);
  for (const leak of ["sk-ant", "abcd1234efgh", "hunter2hunter", "abcdef1234567890XYZ", "topsecret123"]) {
    assert.ok(!all.includes(leak), `se coló ${leak}`);
  }
  assert.equal(ev.preview, "curl -H 'Authorization: Bearer [oculto]' https://x.test");
});

test("limpia caracteres invisibles y marca el recorte de una vista previa enorme", () => {
  const ev = parsed({
    type: "permission_request",
    session_id: "abc",
    tool_name: "Bash",
    preview: "echo ‮txt.exe " + "x".repeat(5000) + " fin",
  });
  assert.ok(ev.preview.includes("[U+202E]"));
  assert.equal(ev.previewTruncated, true);
  assert.ok(ev.preview.endsWith("fin"));
  assert.ok(ev.preview.length < 2100);
});

test("respeta el aviso de recorte que ya hizo el cliente", () => {
  assert.equal(parsed({ type: "permission_request", session_id: "a", tool_name: "Bash", preview: "ls", truncated: true }).previewTruncated, true);
  assert.equal(parsed({ type: "permission_request", session_id: "a", tool_name: "Bash", preview: "ls", truncated: "sí" }).previewTruncated, false);
});

test("recorta campos largos y descarta caracteres raros en detail", () => {
  const ev = parsed({
    type: "notification",
    session_id: "abc",
    project: "p".repeat(300),
    cwd: "c".repeat(900),
    detail: "idle prompt!!" + "z".repeat(100),
    message: "m".repeat(2000),
    description: "d".repeat(900),
  });
  assert.ok(ev.project.length <= 100);
  assert.ok(ev.cwd!.length <= 300);
  assert.match(ev.detail, /^[A-Za-z0-9_.:-]{1,60}$/);
  assert.ok(ev.message.length <= 300);
  assert.ok(ev.description.length <= 200);
});

test("campos desconocidos se ignoran", () => {
  const ev = parsed({ type: "stop", session_id: "abc", token_hash: "x", user_id: "otro", approvals_enabled: true });
  assert.ok(!("user_id" in ev) && !("token_hash" in ev));
});

// --- summarizeEvent ----------------------------------------------------------------------------------------

const ev = (over: Partial<ParsedEvent>): ParsedEvent => ({
  type: "stop", sessionId: "s", project: "finapp", cwd: null, detail: "", message: "", toolName: "", preview: "", previewTruncated: false, description: "", ...over,
});

test("resúmenes en español para cada tipo de evento", () => {
  assert.equal(summarizeEvent(ev({ type: "session_start", detail: "startup" })), "Sesión iniciada");
  assert.equal(summarizeEvent(ev({ type: "session_start", detail: "resume" })), "Sesión reanudada");
  assert.equal(summarizeEvent(ev({ type: "session_end", detail: "logout" })), "Cerró la sesión de Claude");
  assert.equal(summarizeEvent(ev({ type: "session_end", detail: "other" })), "Sesión terminada");
  assert.equal(summarizeEvent(ev({ type: "stop", message: "Actualicé 6 archivos" })), "Actualicé 6 archivos");
  assert.equal(summarizeEvent(ev({ type: "stop" })), "Terminó de responder");
  assert.equal(summarizeEvent(ev({ type: "stop_failure", detail: "rate_limit", message: "API Error: Rate limit reached" })), "Falló (rate_limit): API Error: Rate limit reached");
  assert.equal(summarizeEvent(ev({ type: "notification", detail: "idle_prompt", message: "Claude is waiting" })), "Claude is waiting");
  assert.equal(summarizeEvent(ev({ type: "notification", detail: "idle_prompt" })), "idle_prompt");
  assert.equal(summarizeEvent(ev({ type: "permission_request", toolName: "Bash", preview: "npm test\nsegunda línea" })), "Bash: npm test");
});

// --- mergeSession ------------------------------------------------------------------------------------------

const AT = "2026-10-04T15:00:00.000Z";
const ctx = { userId: "u1", deviceId: "d1", atIso: AT, summary: "resumen" };

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  user_id: "u1", session_id: "s", device_id: "d1", project: "finapp", cwd: "~/finapp", status: "trabajando",
  last_summary: null, started_at: "2026-10-04T14:00:00.000Z", last_event_at: "2026-10-04T14:30:00.000Z", ended_at: null, ...over,
});

test("una sesión nueva nace con el estado que corresponde al primer evento", () => {
  assert.equal(mergeSession(null, ev({ type: "session_start" }), ctx).status, "trabajando");
  assert.equal(mergeSession(null, ev({ type: "stop" }), ctx).status, "esperando");
  assert.equal(mergeSession(null, ev({ type: "permission_request" }), ctx).status, "trabajando");
  const ended = mergeSession(null, ev({ type: "session_end" }), ctx);
  assert.equal(ended.status, "terminada");
  assert.equal(ended.ended_at, AT);
  assert.equal(mergeSession(null, ev({ type: "stop" }), ctx).started_at, AT);
});

test("Stop deja la sesión esperando y guarda el resumen; StopFailure la marca con error", () => {
  const stopped = mergeSession(session(), ev({ type: "stop" }), ctx);
  assert.equal(stopped.status, "esperando");
  assert.equal(stopped.last_summary, "resumen");
  assert.equal(stopped.last_event_at, AT);
  assert.equal(mergeSession(session(), ev({ type: "stop_failure" }), ctx).status, "error");
});

test("actividad (permiso pedido, aviso de permiso) devuelve la sesión a trabajando; idle_prompt a esperando", () => {
  const waiting = session({ status: "esperando" });
  assert.equal(mergeSession(waiting, ev({ type: "permission_request" }), ctx).status, "trabajando");
  assert.equal(mergeSession(waiting, ev({ type: "notification", detail: "permission_prompt" }), ctx).status, "trabajando");
  assert.equal(mergeSession(session(), ev({ type: "notification", detail: "idle_prompt" }), ctx).status, "esperando");
  assert.equal(mergeSession(session({ status: "error" }), ev({ type: "notification", detail: "auth_success" }), ctx).status, "error");
});

test("SessionEnd termina la sesión y un evento tardío no la resucita", () => {
  const ended = mergeSession(session(), ev({ type: "session_end" }), ctx);
  assert.equal(ended.status, "terminada");
  assert.equal(ended.ended_at, AT);
  const late = mergeSession(ended, ev({ type: "stop" }), { ...ctx, atIso: "2026-10-04T15:00:05.000Z" });
  assert.deepEqual(late, ended);
});

test("SessionStart sobre una sesión terminada la reanuda sin perder su inicio original", () => {
  const ended = session({ status: "terminada", ended_at: "2026-10-04T14:40:00.000Z" });
  const resumed = mergeSession(ended, ev({ type: "session_start", detail: "resume" }), ctx);
  assert.equal(resumed.status, "trabajando");
  assert.equal(resumed.ended_at, null);
  assert.equal(resumed.started_at, ended.started_at);
});

test("el proyecto y la carpeta se actualizan solo si el evento los trae", () => {
  const withProject = mergeSession(session(), ev({ type: "stop", project: "otro", cwd: "~/otro" }), ctx);
  assert.equal(withProject.project, "otro");
  assert.equal(withProject.cwd, "~/otro");
  const without = mergeSession(session(), ev({ type: "stop", project: "", cwd: null }), ctx);
  assert.equal(without.project, "finapp");
  assert.equal(without.cwd, "~/finapp");
});

// --- planNotice ----------------------------------------------------------------------------------------------

const none = { hasPendingApproval: false };

test("un permiso pendiente avisa con proyecto, herramienta y comando en una línea", () => {
  const n = planNotice(ev({ type: "permission_request", toolName: "Bash", preview: "vercel env add VITE_SUPABASE_URL production" }), { approvalCreated: true, ...none });
  assert.deepEqual(n, {
    kind: "claude",
    title: "Claude pide permiso · finapp",
    body: "Bash: vercel env add VITE_SUPABASE_URL production",
    url: "/claude",
  });
});

test("un permiso sin aprobación creada (modo ausente apagado) no avisa", () => {
  assert.equal(planNotice(ev({ type: "permission_request", toolName: "Bash", preview: "ls" }), { approvalCreated: false, ...none }), null);
});

test("el aviso nunca pasa de una línea corta (se ve en la pantalla bloqueada)", () => {
  const n = planNotice(ev({ type: "permission_request", toolName: "Bash", preview: "a\n".repeat(200) + "b".repeat(500) }), { approvalCreated: true, ...none })!;
  assert.ok(!n.body!.includes("\n"));
  assert.ok(n.body!.length <= 120);
  assert.ok(n.title.length <= 120);
});

test("permission_prompt avisa solo si no hay ya una aprobación pendiente de esa sesión", () => {
  const e = ev({ type: "notification", detail: "permission_prompt", message: "Claude needs your permission" });
  assert.equal(planNotice(e, { approvalCreated: false, hasPendingApproval: true }), null);
  assert.deepEqual(planNotice(e, { approvalCreated: false, hasPendingApproval: false }), {
    kind: "claude", title: "Claude espera permiso · finapp", body: "Claude needs your permission", url: "/claude",
  });
});

test("idle_prompt, diálogos de MCP y agentes que esperan avisan; el resto no", () => {
  for (const detail of ["idle_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]) {
    const n = planNotice(ev({ type: "notification", detail, message: "msg" }), { approvalCreated: false, ...none });
    assert.equal(n?.kind, "claude", detail);
  }
  for (const detail of ["auth_success", "elicitation_complete", "quota_auto_resume_fired", "test", ""]) {
    assert.equal(planNotice(ev({ type: "notification", detail }), { approvalCreated: false, ...none }), null, detail);
  }
});

test("una falla avisa con el tipo de error; los demás eventos no avisan", () => {
  const n = planNotice(ev({ type: "stop_failure", detail: "rate_limit", message: "API Error: Rate limit reached" }), { approvalCreated: false, ...none });
  assert.equal(n?.title, "Claude falló · finapp");
  assert.match(n!.body!, /rate_limit/);
  for (const type of ["session_start", "session_end", "stop"] as const) assert.equal(planNotice(ev({ type }), { approvalCreated: false, ...none }), null, type);
});

test("sin proyecto el aviso usa un nombre genérico", () => {
  const n = planNotice(ev({ type: "stop_failure", project: "", detail: "unknown" }), { approvalCreated: false, ...none });
  assert.equal(n?.title, "Claude falló · Claude Code");
});
