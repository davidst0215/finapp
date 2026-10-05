// Hook Stop: entregar mensajes del celular (SPEC-claude-code-v2.md). Correr con: node --test tools/claude-hooks/
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.WABID_HOOK_TEST = "1";
const hook = await import("./wabid-hook.mjs");

const HOME = "C:\\Users\\Dsalg";
const DEVICE_TOKEN = "wbd.3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const URL_BASE = "https://proyecto.supabase.co/functions/v1/claude-events";
const CONFIG = { url: URL_BASE, token: DEVICE_TOKEN };
const base = { session_id: "abc123", cwd: `${HOME}\\finapp`, transcript_path: "x.jsonl" };
const CLAIM = "POST /device/sessions/abc123/messages/next";

const stopInput = (extra = {}) => JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "listo", ...extra });

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, elapsed: () => t };
}

// routes: "MÉTODO /ruta" -> { status?, body? } | Error | () => lo mismo
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const key = `${init.method ?? "GET"} ${url.replace(URL_BASE, "")}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[key];
    if (!route) return new Response("{}", { status: 404 });
    const r = typeof route === "function" ? route() : route;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const run = (extra) => hook.runHook({ raw: stopInput(), config: CONFIG, home: HOME, env: {}, ...extra });

test("buildStopOutput usa el formato oficial decision:block + reason", () => {
  const out = hook.buildStopOutput("corre los tests");
  assert.equal(out.decision, "block");
  assert.ok(out.reason.includes("corre los tests"));
  assert.deepEqual(Object.keys(out).sort(), ["decision", "reason"]);
});

test("stopWaitMs: defecto 10 min, tope 14, 0 desactiva, inválido cae al defecto", () => {
  assert.equal(hook.stopWaitMs({}), 600_000);
  assert.equal(hook.stopWaitMs(null), 600_000);
  assert.equal(hook.stopWaitMs({ stopWaitMinutes: 3 }), 180_000);
  assert.equal(hook.stopWaitMs({ stopWaitMinutes: 99 }), 14 * 60_000);
  assert.equal(hook.stopWaitMs({ stopWaitMinutes: 0 }), 0);
  assert.equal(hook.stopWaitMs({ stopWaitMinutes: -1 }), 600_000);
  assert.equal(hook.stopWaitMs({ stopWaitMinutes: "5" }), 600_000);
});

test("parseConfig conserva stop_wait_minutes si es un número", () => {
  assert.equal(hook.parseConfig(JSON.stringify({ url: URL_BASE, token: DEVICE_TOKEN, stop_wait_minutes: 4 })).stopWaitMinutes, 4);
  assert.equal(hook.parseConfig(JSON.stringify({ url: URL_BASE, token: DEVICE_TOKEN })).stopWaitMinutes, undefined);
});

test("hardLimitMs: Stop espera más que los otros eventos y nunca pasa del timeout de 900 s", () => {
  assert.equal(hook.hardLimitMs(JSON.stringify({ hook_event_name: "Notification" }), CONFIG), 140_000);
  assert.equal(hook.hardLimitMs("no es json", CONFIG), 140_000);
  const stop = hook.hardLimitMs(stopInput(), { ...CONFIG, stopWaitMinutes: 99 });
  assert.equal(stop, 14 * 60_000 + 30_000);
  assert.ok(stop < hook.STOP_HOOK_TIMEOUT_SECONDS * 1000);
});

test("con un mensaje ya en cola lo entrega aunque el modo ausente esté apagado (sin esperar)", async () => {
  const { fetchImpl, calls } = makeFetch({
    "POST /device/events": { body: { ok: true, away: false } },
    [CLAIM]: { body: { message: { id: "m1", text: "ahora los tests" }, away: false } },
  });
  const clock = fakeClock();
  const out = await run({ fetchImpl, ...clock });
  assert.deepEqual(JSON.parse(out), hook.buildStopOutput("ahora los tests"));
  assert.equal(clock.elapsed(), 0);
  assert.deepEqual(calls.map((c) => c.key), ["POST /device/events", CLAIM]);
});

test("modo ausente apagado y sin mensajes: una consulta y termina sin esperar", async () => {
  const { fetchImpl, calls } = makeFetch({
    "POST /device/events": { body: { ok: true, away: false } },
    [CLAIM]: { body: { message: null, away: false } },
  });
  const clock = fakeClock();
  assert.equal(await run({ fetchImpl, ...clock }), null);
  assert.equal(clock.elapsed(), 0);
  assert.equal(calls.length, 2);
});

test("modo ausente: sondea cada 3 s y entrega el mensaje cuando llega", async () => {
  const answers = [null, null, null, { id: "m1", text: "llegó tarde" }];
  const { fetchImpl, calls } = makeFetch({
    "POST /device/events": { body: { ok: true, away: true } },
    [CLAIM]: () => ({ body: { message: answers.shift() ?? null, away: true } }),
  });
  const clock = fakeClock();
  assert.deepEqual(JSON.parse(await run({ fetchImpl, ...clock })), hook.buildStopOutput("llegó tarde"));
  assert.equal(clock.elapsed(), 9000, "tres esperas de 3 s");
  assert.equal(calls.filter((c) => c.key === CLAIM).length, 4);
});

test("modo ausente: espera como máximo stop_wait_minutes y luego deja terminar", async () => {
  const { fetchImpl, calls } = makeFetch({
    "POST /device/events": { body: { ok: true, away: true } },
    [CLAIM]: { body: { message: null, away: true } },
  });
  const clock = fakeClock();
  assert.equal(await run({ fetchImpl, config: { ...CONFIG, stopWaitMinutes: 1 }, ...clock }), null);
  assert.equal(clock.elapsed(), 60_000);
  assert.equal(calls.filter((c) => c.key === CLAIM).length, 21);
});

test("espera 0 minutos: no espera aunque el modo ausente esté activo", async () => {
  const { fetchImpl } = makeFetch({ "POST /device/events": { body: { ok: true, away: true } }, [CLAIM]: { body: { message: null, away: true } } });
  const clock = fakeClock();
  assert.equal(await run({ fetchImpl, config: { ...CONFIG, stopWaitMinutes: 0 }, ...clock }), null);
  assert.equal(clock.elapsed(), 0);
});

test("deja de esperar si el modo ausente se apaga mientras espera", async () => {
  const answers = [true, true, false];
  const { fetchImpl } = makeFetch({
    "POST /device/events": { body: { ok: true, away: true } },
    [CLAIM]: () => ({ body: { message: null, away: answers.shift() } }),
  });
  const clock = fakeClock();
  assert.equal(await run({ fetchImpl, ...clock }), null);
  assert.equal(clock.elapsed(), 6000);
});

test("entrega aunque stop_hook_active sea true (cada mensaje es de un solo uso: no hay bucle)", async () => {
  const { fetchImpl } = makeFetch({
    "POST /device/events": { body: { ok: true, away: false } },
    [CLAIM]: { body: { message: { id: "m2", text: "otra cosa" }, away: false } },
  });
  const out = await hook.runHook({ raw: stopInput({ stop_hook_active: true }), config: CONFIG, home: HOME, env: {}, fetchImpl, ...fakeClock() });
  assert.equal(JSON.parse(out).decision, "block");
});

test("falla abierto: error de red o 401 en la consulta no bloquea ni imprime", async () => {
  for (const claim of [new Error("red caída"), { status: 401, body: { error: "No autorizado" } }]) {
    const { fetchImpl } = makeFetch({ "POST /device/events": { body: { ok: true, away: true } }, [CLAIM]: claim });
    const clock = fakeClock();
    assert.equal(await run({ fetchImpl, ...clock }), null);
    assert.ok(clock.elapsed() <= 6000, "tras 3 errores seguidos se rinde");
  }
});

test("si no se pudo avisar el stop (Wabid caído) no consulta mensajes", async () => {
  const { fetchImpl, calls } = makeFetch({ "POST /device/events": new Error("caído") });
  assert.equal(await run({ fetchImpl, ...fakeClock() }), null);
  assert.equal(calls.length, 1);
});

test("dentro del runner (WABID_RUNNER=1) avisa el stop pero no reclama mensajes", async () => {
  const { fetchImpl, calls } = makeFetch({ "POST /device/events": { body: { ok: true, away: true } }, [CLAIM]: { body: { message: { id: "m", text: "x" } } } });
  assert.equal(await run({ fetchImpl, env: { WABID_RUNNER: "1" }, ...fakeClock() }), null);
  assert.deepEqual(calls.map((c) => c.key), ["POST /device/events"]);
});

test("el texto del mensaje nunca se escribe en el log del hook", async () => {
  const logs = [];
  const { fetchImpl } = makeFetch({
    "POST /device/events": { body: { ok: true, away: false } },
    [CLAIM]: { body: { message: { id: "m1", text: "clave: hunter2hunter2" }, away: false } },
  });
  await run({ fetchImpl, log: (m) => logs.push(m), ...fakeClock() });
  assert.equal(logs.join("\n").includes("hunter2"), false);
});
