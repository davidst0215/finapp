// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/handlers.test.ts
// Prueba el contrato HTTP de la función (dispositivo y app) contra un almacén en memoria con la misma
// semántica que la base: autenticación, aislamiento entre usuarios, ciclo de vida de una aprobación y avisos.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Notice } from "../_shared/notify.ts";
import { handleApi, LIMITS } from "./handlers.ts";
import type { ApiDeps } from "./handlers.ts";
import { MemoryStore } from "./memory-store.ts";

const BASE_URL = "https://proyecto.supabase.co/functions/v1/claude-events";
const START = Date.parse("2026-10-04T15:00:00.000Z");

// deno-lint-ignore no-explicit-any
type Json = any;

function setup() {
  const store = new MemoryStore();
  let nowMs = START;
  store.clock = () => new Date(nowMs).toISOString();
  const notices: { userId: string; notice: Notice }[] = [];
  const state = { user: "david" as string | null, notifyFails: false };

  const deps: ApiDeps = {
    store,
    now: () => new Date(nowMs),
    notify: async (userId, notice) => {
      if (state.notifyFails) throw new Error("push caído");
      notices.push({ userId, notice });
    },
    authenticateUser: async () => (state.user ? { userId: state.user } : null),
    randomUUID: () => crypto.randomUUID(),
    publicUrl: BASE_URL,
  };

  const call = async (method: string, path: string, opts: { body?: unknown; token?: string; rawBody?: string } = {}) => {
    const headers = new Headers();
    if (opts.token) headers.set("x-wabid-device-token", opts.token);
    const body = opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
    const res = await handleApi({ method, path: `/claude-events${path}`, headers, body }, deps);
    return res as { status: number; body: Json };
  };

  const ui = (method: string, path: string, body?: unknown) => call(method, `/ui${path}`, { body });
  const device = (token: string) => ({
    ping: () => call("GET", "/device/ping", { token }),
    event: (body: unknown) => call("POST", "/device/events", { token, body }),
    approval: (id: string) => call("GET", `/device/approvals/${id}`, { token }),
  });

  async function pair(name = "Laptop de David", approvals = false) {
    const res = await ui("POST", "/devices", { name });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    if (approvals) {
      const p = await ui("PATCH", `/devices/${res.body.device.id}`, { approvals_enabled: true });
      assert.equal(p.status, 200);
    }
    return { token: res.body.token as string, id: res.body.device.id as string, ...device(res.body.token) };
  }

  const tick = (ms: number) => {
    nowMs += ms;
  };

  return { store, notices, state, deps, call, ui, device, pair, tick, now: () => nowMs };
}

const SESSION = "11111111-aaaa-4bbb-8ccc-222222222222";
const ask = (over: Record<string, unknown> = {}) => ({
  type: "permission_request",
  session_id: SESSION,
  project: "finapp",
  cwd: "~\\finapp",
  tool_name: "Bash",
  preview: "vercel env add VITE_SUPABASE_URL production",
  description: "Agrega una variable",
  ...over,
});

// --- Autenticación del dispositivo ------------------------------------------------------------------------

test("sin token, con token mal formado, desconocido o con secreto equivocado → 401 idéntico", async () => {
  const t = setup();
  const d = await t.pair();
  const sameDeviceWrongSecret = d.token.slice(0, -1) + (d.token.endsWith("A") ? "B" : "A");
  const unknownDevice = "wbd.00000000-0000-4000-8000-000000000000." + d.token.split(".")[2];
  const results = [];
  for (const token of [undefined, "", "basura", d.token + "x", sameDeviceWrongSecret, unknownDevice, "Bearer " + d.token]) {
    results.push(await t.call("GET", "/device/ping", { token }));
  }
  for (const r of results) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "No autorizado" }, "el mensaje no debe revelar si el dispositivo existe");
  }
});

test("un dispositivo revocado deja de funcionar al instante", async () => {
  const t = setup();
  const d = await t.pair();
  assert.equal((await d.ping()).status, 200);
  assert.equal((await t.ui("DELETE", `/devices/${d.id}`)).status, 200);
  assert.equal((await d.ping()).status, 401);
  assert.equal((await d.event({ type: "stop", session_id: SESSION })).status, 401);
});

test("ping devuelve el nombre y si las aprobaciones están activas, y registra el último contacto", async () => {
  const t = setup();
  const d = await t.pair("Mi laptop", true);
  const r = await d.ping();
  assert.equal(r.status, 200);
  assert.equal(r.body.device.name, "Mi laptop");
  assert.equal(r.body.device.approvals_enabled, true);
  const row = await t.store.findDevice(d.id);
  assert.equal(row!.last_seen_at, new Date(START).toISOString());
});

test("el último contacto se actualiza como máximo cada 30 s (el sondeo no escribe en cada vuelta)", async () => {
  const t = setup();
  const d = await t.pair();
  await d.ping();
  t.tick(10_000);
  await d.ping();
  assert.equal((await t.store.findDevice(d.id))!.last_seen_at, new Date(START).toISOString());
  t.tick(25_000);
  await d.ping();
  assert.equal((await t.store.findDevice(d.id))!.last_seen_at, new Date(START + 35_000).toISOString());
});

// --- Emparejar y administrar dispositivos (app) -----------------------------------------------------------

test("emparejar devuelve el token una sola vez y guarda solo su hash", async () => {
  const t = setup();
  const res = await t.ui("POST", "/devices", { name: "Laptop de David" });
  assert.equal(res.status, 201);
  assert.match(res.body.token, /^wbd\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(res.body.url, BASE_URL);
  assert.equal(res.body.device.approvals_enabled, false, "las aprobaciones nacen apagadas");

  const stored = await t.store.findDevice(res.body.device.id);
  assert.match(stored!.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(res.body.token.split(".")[2]), "el secreto no se guarda");
  assert.ok(!JSON.stringify(res.body).includes(stored!.token_hash), "ni siquiera al emparejar sale el hash");
  assert.ok(!("token_hash" in res.body.device));

  const overview = JSON.stringify((await t.ui("GET", "/overview")).body);
  assert.ok(!overview.includes(res.body.token), "el token no vuelve a mostrarse");
  assert.ok(!overview.includes(stored!.token_hash), "el hash tampoco sale hacia la app");
  assert.ok(!overview.includes("token_hash"));
});

test("el nombre del dispositivo se limpia y tiene valor por defecto", async () => {
  const t = setup();
  assert.equal((await t.ui("POST", "/devices", {})).body.device.name, "Mi laptop");
  assert.equal((await t.ui("POST", "/devices", { name: "   " })).body.device.name, "Mi laptop");
  assert.ok((await t.ui("POST", "/devices", { name: "x".repeat(200) })).body.device.name.length <= 60);
  assert.equal((await t.ui("POST", "/devices", { name: 42 })).status, 400);
});

test("hay un tope de dispositivos activos; revocar libera cupo", async () => {
  const t = setup();
  const created = [];
  for (let i = 0; i < LIMITS.maxActiveDevices; i++) created.push(await t.pair(`Laptop ${i}`));
  const over = await t.ui("POST", "/devices", { name: "Una más" });
  assert.equal(over.status, 409);
  await t.ui("DELETE", `/devices/${created[0]!.id}`);
  assert.equal((await t.ui("POST", "/devices", { name: "Una más" })).status, 201);
});

test("activar y apagar las aprobaciones; apagarlas vence las pendientes", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const created = await d.event(ask());
  assert.equal(created.body.approval.status, "pendiente");
  const off = await t.ui("PATCH", `/devices/${d.id}`, { approvals_enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.device.approvals_enabled, false);
  assert.equal((await d.approval(created.body.approval.id)).body.status, "vencida");
});

test("PATCH valida el cuerpo y no toca dispositivos ajenos", async () => {
  const t = setup();
  const d = await t.pair();
  assert.equal((await t.ui("PATCH", `/devices/${d.id}`, {})).status, 400);
  assert.equal((await t.ui("PATCH", `/devices/${d.id}`, { approvals_enabled: "sí" })).status, 400);
  assert.equal((await t.ui("PATCH", `/devices/${d.id}`, { name: "" })).status, 400);
  assert.equal((await t.ui("PATCH", `/devices/${d.id}`, { name: "Nueva" })).body.device.name, "Nueva");
  t.state.user = "otro";
  assert.equal((await t.ui("PATCH", `/devices/${d.id}`, { approvals_enabled: true })).status, 404);
  assert.equal((await t.ui("DELETE", `/devices/${d.id}`)).status, 404);
  t.state.user = "david";
  assert.equal((await t.ui("DELETE", `/devices/${d.id}`)).status, 200);
  assert.equal((await t.ui("DELETE", `/devices/${d.id}`)).status, 404, "ya revocado");
});

test("todas las rutas de la app exigen usuario", async () => {
  const t = setup();
  const d = await t.pair();
  t.state.user = null;
  const id = "3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f";
  const calls = [
    t.ui("GET", "/overview"),
    t.ui("GET", `/sessions/${SESSION}/events`),
    t.ui("POST", "/devices", { name: "x" }),
    t.ui("PATCH", `/devices/${d.id}`, { approvals_enabled: true }),
    t.ui("DELETE", `/devices/${d.id}`),
    t.ui("POST", `/approvals/${id}/decision`, { decision: "aprobar" }),
  ];
  for (const r of await Promise.all(calls)) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "No autorizado" });
  }
});

test("el token de un dispositivo no sirve en las rutas de la app", async () => {
  const t = setup();
  const d = await t.pair();
  t.state.user = null;
  const res = await t.call("GET", "/ui/overview", { token: d.token });
  assert.equal(res.status, 401);
});

test("rutas inexistentes → 404 y método incorrecto → 405", async () => {
  const t = setup();
  assert.equal((await t.call("GET", "/nada")).status, 404);
  assert.equal((await t.call("GET", "/device/events")).status, 405);
  assert.equal((await t.call("POST", "/ui/overview")).status, 405);
});

// --- Eventos de sesión -------------------------------------------------------------------------------------

test("el ciclo de una sesión se refleja en la app: inicio, trabajo, fin", async () => {
  const t = setup();
  const d = await t.pair();
  assert.deepEqual((await d.event({ type: "session_start", session_id: SESSION, project: "finapp", cwd: "~\\finapp", detail: "startup" })).body, { ok: true });
  let s = (await t.ui("GET", "/overview")).body.sessions[0];
  assert.equal(s.id, SESSION);
  assert.equal(s.project, "finapp");
  assert.equal(s.status, "trabajando");

  t.tick(60_000);
  await d.event({ type: "stop", session_id: SESSION, message: "Actualicé 6 archivos" });
  s = (await t.ui("GET", "/overview")).body.sessions[0];
  assert.equal(s.status, "esperando");
  assert.equal(s.summary, "Actualicé 6 archivos");

  t.tick(60_000);
  await d.event({ type: "session_end", session_id: SESSION, detail: "other" });
  s = (await t.ui("GET", "/overview")).body.sessions[0];
  assert.equal(s.status, "terminada");
  assert.equal(s.ended_at, new Date(START + 120_000).toISOString());

  const events = (await t.ui("GET", `/sessions/${SESSION}/events`)).body.events;
  assert.deepEqual(events.map((e: Json) => e.kind), ["session_end", "stop", "session_start"], "más reciente primero");
});

test("un Stop tardío (los hooks asíncronos llegan desordenados) no resucita una sesión terminada", async () => {
  const t = setup();
  const d = await t.pair();
  await d.event({ type: "session_start", session_id: SESSION });
  await d.event({ type: "session_end", session_id: SESSION });
  await d.event({ type: "stop", session_id: SESSION, message: "tarde" });
  assert.equal((await t.ui("GET", "/overview")).body.sessions[0].status, "terminada");
});

test("cuerpos inválidos → 400 sin guardar nada", async () => {
  const t = setup();
  const d = await t.pair();
  const bad = [
    { rawBody: "no es json" },
    { rawBody: "[1,2]" },
    { body: { type: "otro", session_id: SESSION } },
    { body: { type: "stop", session_id: "tiene espacios" } },
    { body: { type: "permission_request", session_id: SESSION } },
  ];
  for (const b of bad) {
    const r = await t.call("POST", "/device/events", { token: d.token, ...b });
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal(t.store.sessions.size, 0);
  assert.equal(t.store.events.length, 0);
});

test("el servidor redacta secretos aunque el cliente no lo haya hecho", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  await d.event(
    ask({
      project: "finapp ghp_1234567890abcdefghijABCDEFGHIJ123456",
      preview: "curl -H 'Authorization: Bearer abcdef1234567890XYZ' https://x.test",
      description: "con --password=topsecret123",
    }),
  );
  await d.event({ type: "stop", session_id: SESSION, message: "PGPASSWORD=hunter2hunter" });
  const dump = JSON.stringify((await t.ui("GET", "/overview")).body) + JSON.stringify(t.store.events) + JSON.stringify(t.notices);
  for (const leak of ["ghp_1234", "abcdef1234567890XYZ", "topsecret123", "hunter2hunter"]) assert.ok(!dump.includes(leak), `se coló ${leak}`);
});

test("hay un tope de eventos por minuto y por dispositivo", async () => {
  const t = setup();
  const d = await t.pair();
  for (let i = 0; i < LIMITS.maxEventsPerMinute; i++) {
    assert.equal((await d.event({ type: "notification", session_id: SESSION, detail: "test" })).status, 200, `evento ${i}`);
  }
  assert.equal((await d.event({ type: "notification", session_id: SESSION, detail: "test" })).status, 429);
  t.tick(61_000);
  assert.equal((await d.event({ type: "notification", session_id: SESSION, detail: "test" })).status, 200);
});

test("SessionStart limpia lo antiguo del usuario (retención)", async () => {
  const t = setup();
  const d = await t.pair();
  await d.event({ type: "session_start", session_id: "vieja" });
  t.tick(40 * 24 * 3600_000);
  await d.event({ type: "session_start", session_id: "nueva" });
  assert.deepEqual([...t.store.sessions.keys()], ["david|nueva"]);
});

// --- Permisos ----------------------------------------------------------------------------------------------

test("con las aprobaciones apagadas el permiso se registra pero no se espera ni se avisa", async () => {
  const t = setup();
  const d = await t.pair("L", false);
  const r = await d.event(ask());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, approval: null, reason: "desactivada" });
  assert.equal(t.notices.length, 0);
  assert.equal(t.store.approvals.size, 0);
  assert.equal(t.store.events.at(-1)!.kind, "permission_request");
});

test("con las aprobaciones activas se crea una pendiente de 2 min y se avisa al celular una vez", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const r = await d.event(ask());
  assert.equal(r.status, 200);
  assert.deepEqual(
    { ...r.body.approval, id: "x" },
    { id: "x", status: "pendiente", expires_in_ms: 120_000, poll_interval_ms: 2000 },
  );
  assert.equal(t.notices.length, 1);
  assert.equal(t.notices[0]!.userId, "david");
  assert.deepEqual(t.notices[0]!.notice, {
    kind: "claude",
    title: "Claude pide permiso · finapp",
    body: "Bash: vercel env add VITE_SUPABASE_URL production",
    url: "/claude",
  });

  const overview = (await t.ui("GET", "/overview")).body;
  assert.equal(overview.pending.length, 1);
  assert.equal(overview.pending[0].id, r.body.approval.id);
  assert.equal(overview.pending[0].tool_name, "Bash");
  assert.equal(overview.pending[0].preview, "vercel env add VITE_SUPABASE_URL production");
  assert.equal(overview.pending[0].description, "Agrega una variable");
  assert.equal(overview.pending[0].project, "finapp");
  assert.equal(overview.pending[0].expires_in_ms, 120_000);
});

test("aprobar desde el celular: el dispositivo lo ve en su siguiente sondeo", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  assert.deepEqual((await d.approval(id)).body, { status: "pendiente", expires_in_ms: 120_000 });

  t.tick(30_000);
  const decided = await t.ui("POST", `/approvals/${id}/decision`, { decision: "aprobar" });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.approval.status, "aprobada");
  assert.deepEqual((await d.approval(id)).body, { status: "aprobada", expires_in_ms: 0 });

  const row = t.store.approvals.get(id)!;
  assert.equal(row.decided_by, "david", "queda quién decidió");
  assert.equal(row.decided_at, new Date(START + 30_000).toISOString(), "y cuándo");

  const overview = (await t.ui("GET", "/overview")).body;
  assert.equal(overview.pending.length, 0);
  assert.equal(overview.recent[0].status, "aprobada");
});

test("rechazar desde el celular", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  assert.equal((await t.ui("POST", `/approvals/${id}/decision`, { decision: "denegar" })).body.approval.status, "denegada");
  assert.equal((await d.approval(id)).body.status, "denegada");
});

test("una aprobación no se puede decidir dos veces ni cambiar de opinión", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  assert.equal((await t.ui("POST", `/approvals/${id}/decision`, { decision: "denegar" })).status, 200);
  const again = await t.ui("POST", `/approvals/${id}/decision`, { decision: "aprobar" });
  assert.equal(again.status, 409);
  assert.equal(again.body.status, "denegada");
  assert.equal((await d.approval(id)).body.status, "denegada");
});

test("vence sola a los 2 min: ni el celular puede aprobar tarde ni el dispositivo ve otra cosa", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  t.tick(LIMITS.approvalTtlMs - 1);
  assert.equal((await d.approval(id)).body.status, "pendiente");
  t.tick(1); // justo en el vencimiento
  const late = await t.ui("POST", `/approvals/${id}/decision`, { decision: "aprobar" });
  assert.equal(late.status, 409);
  assert.equal(late.body.status, "vencida");
  assert.equal((await d.approval(id)).body.status, "vencida");
  assert.equal(t.store.approvals.get(id)!.decided_by, null, "nadie decidió");
  assert.equal((await t.ui("GET", "/overview")).body.pending.length, 0);
});

test("el dispositivo ve 'vencida' aunque nadie haya abierto la app", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  t.tick(LIMITS.approvalTtlMs + 5_000);
  assert.equal((await d.approval(id)).body.status, "vencida");
});

test("la decisión pide 'aprobar' o 'denegar' y nada más", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  for (const body of [{}, { decision: "aprobada" }, { decision: "allow" }, { decision: true }, undefined]) {
    assert.equal((await t.ui("POST", `/approvals/${id}/decision`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(t.store.approvals.get(id)!.status, "pendiente");
});

test("aislamiento: otro usuario no ve ni decide mis aprobaciones", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  t.state.user = "intruso";
  const overview = (await t.ui("GET", "/overview")).body;
  assert.deepEqual([overview.pending, overview.recent, overview.sessions, overview.devices], [[], [], [], []]);
  assert.equal((await t.ui("POST", `/approvals/${id}/decision`, { decision: "aprobar" })).status, 404);
  assert.equal((await t.ui("GET", `/sessions/${SESSION}/events`)).body.events.length, 0);
  assert.equal(t.store.approvals.get(id)!.status, "pendiente", "intacta");
});

test("aislamiento: un dispositivo solo consulta sus propias aprobaciones", async () => {
  const t = setup();
  const a = await t.pair("A", true);
  const b = await t.pair("B", true);
  const id = (await a.event(ask())).body.approval.id;
  assert.equal((await b.approval(id)).status, 404);
  assert.equal((await a.approval(id)).status, 200);
  assert.equal((await a.approval("00000000-0000-4000-8000-000000000000")).status, 404);
});

test("hay un tope de aprobaciones pendientes; pasado el tope no se espera ni se avisa", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  for (let i = 0; i < LIMITS.maxPendingApprovals; i++) {
    assert.ok((await d.event(ask({ preview: `echo ${i}` }))).body.approval);
  }
  const noticesBefore = t.notices.length;
  const over = await d.event(ask({ preview: "echo de más" }));
  assert.deepEqual(over.body, { ok: true, approval: null, reason: "limite" });
  assert.equal(t.notices.length, noticesBefore);
});

test("terminar la sesión vence sus aprobaciones pendientes", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  await d.event({ type: "session_end", session_id: SESSION });
  assert.equal((await d.approval(id)).body.status, "vencida");
});

test("revocar el dispositivo vence sus pendientes", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  await t.ui("DELETE", `/devices/${d.id}`);
  assert.equal(t.store.approvals.get(id)!.status, "vencida");
});

test("si el aviso push falla, la aprobación igual queda creada", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  t.state.notifyFails = true;
  const r = await d.event(ask());
  assert.equal(r.status, 200);
  assert.ok(r.body.approval);
});

test("un comando recortado NO se puede aprobar desde el celular: se registra y se resuelve en la terminal", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const r = await d.event(ask({ preview: "echo " + "x".repeat(20_000) + " && fin" }));
  assert.deepEqual(r.body, { ok: true, approval: null, reason: "truncado" });
  assert.equal(t.store.approvals.size, 0);
  assert.equal(t.notices.length, 0);
  const flagged = await d.event(ask({ preview: "ls", truncated: true }));
  assert.equal(flagged.body.reason, "truncado", "también si el hook ya avisó que recortó");
});

test("una sesión es de un solo dispositivo: otro dispositivo no la toca ni la sobrescribe", async () => {
  const t = setup();
  const a = await t.pair("A", true);
  const b = await t.pair("B", true);
  await a.event({ type: "session_start", session_id: SESSION, project: "finapp" });
  const id = (await a.event(ask())).body.approval.id;
  for (const body of [{ type: "session_end", session_id: SESSION }, { type: "stop", session_id: SESSION, message: "x" }, ask()]) {
    assert.equal((await b.event(body)).status, 409);
  }
  assert.equal(t.store.sessions.get("david|" + SESSION)!.device_id, a.id);
  assert.equal(t.store.approvals.get(id)!.status, "pendiente", "la aprobación de A sigue viva");
  assert.equal((await a.event({ type: "session_end", session_id: SESSION })).status, 200);
  assert.equal(t.store.approvals.get(id)!.status, "vencida");
});

test("si el dispositivo dueño fue revocado, otro dispositivo (la laptop re-emparejada) toma la sesión", async () => {
  const t = setup();
  const a = await t.pair("A", true);
  await a.event({ type: "session_start", session_id: SESSION, project: "finapp" });
  await t.ui("DELETE", `/devices/${a.id}`);
  const b = await t.pair("B", true);
  assert.equal((await b.event({ type: "stop", session_id: SESSION, message: "sigo" })).status, 200);
  assert.equal(t.store.sessions.get("david|" + SESSION)!.device_id, b.id);
  assert.ok((await b.event(ask())).body.approval);
});

test("el tope de pendientes es por dispositivo, no por usuario", async () => {
  const t = setup();
  const a = await t.pair("A", true);
  const b = await t.pair("B", true);
  for (let i = 0; i < LIMITS.maxPendingApprovals; i++) await a.event(ask({ preview: `echo ${i}` }));
  assert.equal((await a.event(ask({ preview: "de más" }))).body.reason, "limite");
  assert.ok((await b.event(ask({ session_id: "otra", preview: "echo b" }))).body.approval, "B no se ve afectado por A");
});

test("hay un tope de sesiones nuevas por dispositivo y hora", async () => {
  const t = setup();
  const d = await t.pair();
  for (let i = 0; i < LIMITS.maxNewSessionsPerHour; i++) {
    assert.equal((await d.event({ type: "stop", session_id: `s${i}` })).status, 200);
    if (i % 100 === 99) t.tick(61_000);
  }
  assert.equal((await d.event({ type: "stop", session_id: "una-mas" })).status, 429);
  assert.equal((await d.event({ type: "stop", session_id: "s0" })).status, 200, "las sesiones existentes siguen");
  t.tick(3_700_000);
  assert.equal((await d.event({ type: "stop", session_id: "una-mas" })).status, 200);
});

test("un dispositivo ruidoso no inunda el celular: tope de avisos push por minuto", async () => {
  const t = setup();
  const d = await t.pair();
  for (let i = 0; i < LIMITS.maxNoticeEventsPerMinute + 10; i++) {
    await d.event({ type: "stop_failure", session_id: SESSION, project: "p", detail: "rate_limit" });
  }
  assert.ok(t.notices.length <= LIMITS.maxNoticeEventsPerMinute + 1, `avisos: ${t.notices.length}`);
  assert.ok(t.notices.length >= LIMITS.maxNoticeEventsPerMinute);
});

test("la poda también corre cada N eventos, no solo en session_start", async () => {
  const t = setup();
  const d = await t.pair();
  await d.event({ type: "stop", session_id: "vieja" });
  t.tick(40 * 24 * 3600_000);
  for (let i = 0; i < LIMITS.pruneEveryEvents; i++) await d.event({ type: "stop", session_id: "viva" });
  assert.ok(!t.store.sessions.has("david|vieja"));
});

// --- Avisos por notificaciones de Claude Code ------------------------------------------------------------------

test("permission_prompt avisa cuando no hay aprobación pendiente de esa sesión (para volver a la laptop)", async () => {
  const t = setup();
  const d = await t.pair("L", false);
  await d.event({ type: "notification", session_id: SESSION, project: "finapp", detail: "permission_prompt", message: "Claude needs your permission to use Bash" });
  assert.equal(t.notices.length, 1);
  assert.equal(t.notices[0]!.notice.title, "Claude espera permiso · finapp");
});

test("permission_prompt NO repite el aviso si ya hay una aprobación pendiente de esa sesión", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  await d.event(ask());
  assert.equal(t.notices.length, 1);
  await d.event({ type: "notification", session_id: SESSION, project: "finapp", detail: "permission_prompt", message: "Claude needs your permission" });
  assert.equal(t.notices.length, 1);
  await d.event({ type: "notification", session_id: "otra-sesion", project: "vera", detail: "permission_prompt", message: "Claude needs your permission" });
  assert.equal(t.notices.length, 2, "otra sesión sí avisa");
});

test("idle_prompt avisa y deja la sesión esperando; un Stop común no avisa", async () => {
  const t = setup();
  const d = await t.pair();
  await d.event({ type: "stop", session_id: SESSION, project: "finapp", message: "listo" });
  assert.equal(t.notices.length, 0);
  await d.event({ type: "notification", session_id: SESSION, project: "finapp", detail: "idle_prompt", message: "Claude is waiting for your input" });
  assert.equal(t.notices.length, 1);
  assert.equal(t.notices[0]!.notice.title, "Claude te espera · finapp");
});

test("una falla de Claude avisa y marca la sesión con error", async () => {
  const t = setup();
  const d = await t.pair();
  await d.event({ type: "stop_failure", session_id: SESSION, project: "reportes-tdv", detail: "rate_limit", message: "API Error: Rate limit reached" });
  assert.equal(t.notices[0]!.notice.title, "Claude falló · reportes-tdv");
  assert.equal((await t.ui("GET", "/overview")).body.sessions[0].status, "error");
});

// --- Vista general -------------------------------------------------------------------------------------------------

test("la vista general trae dispositivos, sesiones, pendientes y recientes sin datos sensibles", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  await t.ui("POST", `/approvals/${id}/decision`, { decision: "aprobar" });
  await d.event(ask({ preview: "ls" }));
  const o = (await t.ui("GET", "/overview")).body;
  assert.equal(o.now, new Date(START).toISOString());
  assert.equal(o.devices.length, 1);
  assert.equal(o.devices[0].name, "L");
  assert.equal(o.pending.length, 1);
  assert.equal(o.recent.length, 1);
  assert.equal(o.sessions.length, 1);
  const text = JSON.stringify(o);
  assert.ok(!text.includes("user_id") && !text.includes("token") && !text.includes("decided_by"));
});

test("las recientes solo cubren las últimas 24 h", async () => {
  const t = setup();
  const d = await t.pair("L", true);
  const id = (await d.event(ask())).body.approval.id;
  await t.ui("POST", `/approvals/${id}/decision`, { decision: "aprobar" });
  t.tick(25 * 3600_000);
  assert.equal((await t.ui("GET", "/overview")).body.recent.length, 0);
});
