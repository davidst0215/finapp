// Pruebas del runner con un `claude` falso (fake-claude.fixture.mjs). Nunca ejecuta el claude real.
// Incluye una prueba de punta a punta contra la lógica real de la función claude-events (en memoria).
// Correr con: node --experimental-strip-types --test tools/claude-hooks/wabid-runner.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { handleApi } from "../../supabase/functions/claude-events/handlers.ts";
import { MemoryStore } from "../../supabase/functions/claude-events/memory-store.ts";
import * as runner from "./wabid-runner.mjs";

const FAKE = fileURLToPath(new URL("./fake-claude.fixture.mjs", import.meta.url));
const COMMAND = { file: process.execPath, args: [FAKE] };
const DEVICE_TOKEN_OK = /^wbd\./;
const tmp = mkdtempSync(path.join(tmpdir(), "wabid-runner-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const projectDir = path.join(tmp, "proyecto");
mkdirSync(projectDir);

const fakeEnv = (extra = {}) => ({ ...process.env, ...extra });
const task = (prompt, over = {}) => ({ id: crypto.randomUUID(), project: "demo", prompt, ...over });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && alive(pid)) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

// --- Configuración y allowlist -----------------------------------------------------------------------------

test("parseRunnerConfig: proyectos válidos, defaults y topes", () => {
  const c = runner.parseRunnerConfig(JSON.stringify({ projects: { finapp: "C:\\Users\\Dsalg\\finapp", vera: "/home/d/vera" } }));
  assert.deepEqual([...c.projects], [["finapp", "C:\\Users\\Dsalg\\finapp"], ["vera", "/home/d/vera"]]);
  assert.equal(c.maxMinutes, 30);
  assert.equal(c.pollSeconds, 10);
  assert.deepEqual(c.problems, []);
  assert.equal(runner.parseRunnerConfig(JSON.stringify({ maxMinutes: 9999, pollSeconds: 0 })).maxMinutes, 120);
  assert.equal(runner.parseRunnerConfig(JSON.stringify({ pollSeconds: 0 })).pollSeconds, 3);
});

test("parseRunnerConfig descarta nombres raros y rutas relativas, y lo reporta", () => {
  const c = runner.parseRunnerConfig(JSON.stringify({ projects: { ok: "C:\\a", "../x": "C:\\b", rel: "carpeta\\relativa", "con;punto": "C:\\c", unc: "\\\\?\\C:\\d" } }));
  assert.deepEqual([...c.projects.keys()], ["ok"]);
  assert.equal(c.problems.length, 4);
});

test("parseRunnerConfig: JSON roto, BOM y estructura incorrecta", () => {
  assert.equal(runner.parseRunnerConfig("{ no").problems.length, 1);
  assert.equal(runner.parseRunnerConfig("[]").problems.length, 1);
  assert.equal(runner.parseRunnerConfig("\uFEFF" + JSON.stringify({ projects: { a: "C:\\a" } })).projects.size, 1);
});

test("resolveProject: solo lo que está en la lista; sin trucos de prototipo ni mayúsculas", () => {
  const c = runner.parseRunnerConfig(JSON.stringify({ projects: { Demo: "C:\\demo" } }));
  assert.equal(runner.resolveProject(c, "Demo"), "C:\\demo");
  for (const bad of ["demo", "__proto__", "constructor", "toString", "../Demo", "", null, undefined, 7, { toString: () => "Demo" }]) {
    assert.equal(runner.resolveProject(c, bad), null, String(bad));
  }
});

test("runnerConfigPath: variable de entorno, Windows y Linux", () => {
  assert.equal(runner.runnerConfigPath({ WABID_RUNNER_CONFIG: "x.json" }), "x.json");
  assert.equal(runner.runnerConfigPath({ LOCALAPPDATA: "C:\\Users\\D\\AppData\\Local" }, "win32"), "C:\\Users\\D\\AppData\\Local\\Wabid\\claude-runner.json");
  assert.equal(runner.runnerConfigPath({}, "linux", "/home/d"), "/home/d/.config/wabid/claude-runner.json");
});

test("isValidPrompt: 1 a 4000 caracteres, sin NUL", () => {
  assert.equal(runner.isValidPrompt("hola"), true);
  assert.equal(runner.isValidPrompt("x".repeat(4000)), true);
  for (const bad of ["", "   ", "x".repeat(4001), "a\u0000b", null, 5]) assert.equal(runner.isValidPrompt(bad), false);
});

// --- Argumentos de claude ------------------------------------------------------------------------------------

test("buildClaudeArgs: stream-json, modo default, sin prompt en los argumentos y sin saltarse permisos", () => {
  const sid = crypto.randomUUID();
  const args = runner.buildClaudeArgs({ sessionId: sid });
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--permission-prompts", "none", "--session-id", sid]);
  const text = args.join(" ");
  for (const banned of ["dangerously", "bypassPermissions", "dontAsk", "acceptEdits", "--allowedTools", "auto"]) assert.equal(text.includes(banned), false, banned);
  assert.throws(() => runner.buildClaudeArgs({ sessionId: "no-uuid; rm -rf /" }));
});

test("resolveClaudeCommand: PATH, .cmd rechazado, claudeCommand explícito", () => {
  const exists = (p) => p === "C:\\bin\\claude.exe";
  assert.deepEqual(runner.resolveClaudeCommand({ config: {}, env: { PATH: "C:\\otro;C:\\bin" }, platform: "win32", exists }), { file: "C:\\bin\\claude.exe", args: [] });
  assert.ok(runner.resolveClaudeCommand({ config: {}, env: { PATH: "C:\\otro" }, platform: "win32", exists }).error);
  assert.ok(runner.resolveClaudeCommand({ config: { claudeCommand: ["C:\\npm\\claude.cmd"] }, platform: "win32" }).error, "un .cmd no se puede lanzar sin shell");
  assert.deepEqual(runner.resolveClaudeCommand({ config: { claudeCommand: ["node", "C:\\x\\cli.js"] }, platform: "win32" }), { file: "node", args: ["C:\\x\\cli.js"] });
  assert.deepEqual(runner.resolveClaudeCommand({ config: {}, env: { PATH: "/usr/bin:/home/d/.local/bin" }, platform: "linux", exists: (p) => p === "/home/d/.local/bin/claude" }), { file: "/home/d/.local/bin/claude", args: [] });
});

// --- Salida stream-json -----------------------------------------------------------------------------------------

test("StreamTracker: sesión, último texto, avance y resultado; ignora basura y subagentes", () => {
  const t = new runner.StreamTracker("C:\\Users\\Dsalg");
  t.feed("no es json");
  t.feed(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }));
  t.feed(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "C:\\Users\\Dsalg\\finapp\\a.ts", old_string: "SECRETO", new_string: "x" } }] } }));
  assert.equal(t.progress, "Usa Edit: ~\\finapp\\a.ts", "nunca el contenido del archivo");
  t.feed(JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_9", message: { content: [{ type: "text", text: "texto de un subagente" }] } }));
  assert.equal(t.lastText, "");
  t.feed(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Listo." }] } }));
  assert.equal(t.lastText, "Listo.");
  t.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Fin", permission_denials: [1] }));
  assert.deepEqual(t.result, { isError: false, subtype: "success", text: "Fin", errors: [], denials: 1 });
  assert.equal(t.sessionId, "s-1");
});

test("summarizeToolUse redacta secretos del comando y recorta", () => {
  const s = runner.summarizeToolUse("Bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x " + "y".repeat(300) });
  assert.ok(s.startsWith("Usa Bash: "));
  assert.ok(!s.includes("abcdefghijklmnop1234"));
  assert.ok(s.length < 120);
  assert.equal(runner.summarizeToolUse("Agent", { prompt: "x" }), "Usa Agent");
});

// --- runTask con el claude falso ------------------------------------------------------------------------------------

const run = (prompt, extra = {}) => {
  const events = [];
  const t = task(prompt);
  return runner
    .runTask({ task: t, cwd: projectDir, command: COMMAND, report: async (e) => (events.push(e), { cancel_requested: false }), env: fakeEnv(), heartbeatMs: 40, ...extra })
    .then((r) => ({ ...r, events }));
};

test("OK: termina, redacta el resultado y manda avances redactados", async () => {
  const log = path.join(tmp, "ok.log");
  const r = await run("OK\nhaz el build", { env: fakeEnv({ FAKE_CLAUDE_LOG: log }) });
  assert.equal(r.outcome, "terminada");
  assert.match(r.result, /Hecho: todo bien/);
  assert.ok(!r.result.includes("sk-ant-api03"), "el resultado sale redactado");
  const progress = r.events.filter((e) => e.type === "progress" && e.message).map((e) => e.message);
  assert.ok(progress.length >= 1);
  assert.ok(progress.every((m) => !m.includes("sk-ant-api03")), progress.join("|"));
  const seen = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]);
  assert.equal(seen.prompt, "OK\nhaz el build", "el prompt llega por stdin");
  assert.equal(seen.args.includes("OK\nhaz el build"), false, "y nunca como argumento");
  assert.equal(seen.cwd.toLowerCase(), projectDir.toLowerCase());
  assert.equal(seen.wabidRunner, "1");
  assert.match(r.sessionId, /^[0-9a-f-]{36}$/);
});

test("DENIED: termina pero avisa cuántas acciones se denegaron", async () => {
  const r = await run("DENIED");
  assert.equal(r.outcome, "terminada");
  assert.match(r.result, /2 acciones sin permiso fueron denegadas/);
});

test("ERROR: un result con is_error es fallida con el motivo", async () => {
  const r = await run("ERROR");
  assert.equal(r.outcome, "fallida");
  assert.match(r.error, /boom/);
});

test("CRASH: salida distinta de 0 sin result es fallida, con stderr redactado", async () => {
  const r = await run("CRASH");
  assert.equal(r.outcome, "fallida");
  assert.match(r.error, /código 3/);
  assert.ok(!r.error.includes("sk-ant-api03"));
});

test("un ejecutable que no existe es fallida, no una excepción", async () => {
  const r = await run("OK", { command: { file: path.join(tmp, "no-existe.exe"), args: [] } });
  assert.equal(r.outcome, "fallida");
  assert.match(r.error, /No se pudo iniciar claude/);
});

test("tiempo máximo: mata el árbol de procesos (también el nieto) y reporta fallida", async () => {
  const pidFile = path.join(tmp, "hang.pid");
  const started = Date.now();
  const r = await run("HANG", { maxMs: 600, env: fakeEnv({ FAKE_PID_FILE: pidFile }) });
  assert.equal(r.outcome, "fallida");
  assert.match(r.error, /Tiempo máximo/);
  assert.ok(Date.now() - started < 8000);
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(await waitDead(grandchild), "el proceso nieto debe haber muerto");
});

test("cancelar: el latido recibe cancel_requested y mata el proceso", async () => {
  const pidFile = path.join(tmp, "cancel.pid");
  let beats = 0;
  const r = await runner.runTask({
    task: task("HANG"),
    cwd: projectDir,
    command: COMMAND,
    env: fakeEnv({ FAKE_PID_FILE: pidFile }),
    heartbeatMs: 50,
    maxMs: 30_000,
    report: async () => ({ cancel_requested: ++beats >= 4 }),
  });
  assert.equal(r.outcome, "cancelada");
  assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))));
});

test("un fallo de red en el latido no mata la tarea", async () => {
  let n = 0;
  const r = await runner.runTask({
    task: task("SLOW"),
    cwd: projectDir,
    command: COMMAND,
    env: fakeEnv(),
    heartbeatMs: 30,
    report: async () => {
      n++;
      throw new Error("sin red");
    },
  });
  assert.equal(r.outcome, "terminada");
  assert.ok(n >= 1);
});

test("sin shell: spawn recibe un arreglo de argumentos, shell:false y el prompt no está en ellos", async () => {
  let seen;
  const { spawn } = await import("node:child_process");
  const wrapped = (file, args, opts) => {
    seen = { file, args, opts };
    return spawn(file, args, opts);
  };
  const prompt = "OK\nrm -rf / && echo $(whoami) `id` --dangerously-skip-permissions";
  const r = await run(prompt, { spawnImpl: wrapped });
  assert.equal(r.outcome, "terminada");
  assert.equal(seen.opts.shell, false);
  assert.ok(Array.isArray(seen.args));
  assert.equal(seen.args.some((a) => a.includes("rm -rf") || a.includes("whoami")), false);
  assert.equal(seen.args.filter((a) => a.includes("dangerously")).length, 0, "ni siquiera el prompt malicioso llega como flag");
  assert.equal(seen.opts.env.WABID_RUNNER, "1");
});

// --- validateTask / handleTask -----------------------------------------------------------------------------------------

const config = () => runner.parseRunnerConfig(JSON.stringify({ projects: { demo: projectDir }, pollSeconds: 3, maxMinutes: 1 }));

test("validateTask: usa solo la ruta de la allowlist y rechaza el resto", () => {
  const c = config();
  assert.equal(runner.validateTask(task("hola"), c).cwd, projectDir);
  assert.ok(runner.validateTask(task("hola", { project: "otro" }), c).error);
  assert.ok(runner.validateTask(task("hola", { project: "C:\\Windows" }), c).error);
  assert.ok(runner.validateTask(task(""), c).error);
  assert.ok(runner.validateTask(task("x".repeat(4001)), c).error);
  assert.ok(runner.validateTask({ id: "no-uuid", project: "demo", prompt: "x" }, c).error);
  const missing = runner.parseRunnerConfig(JSON.stringify({ projects: { demo: path.join(tmp, "borrada") } }));
  assert.ok(runner.validateTask(task("hola"), missing).error);
});

// --- De punta a punta contra la función claude-events (en memoria) --------------------------------------------------------

const DAVID = "david";
function backend() {
  const store = new MemoryStore();
  let nowMs = Date.parse("2026-10-05T15:00:00.000Z");
  const notices = [];
  const deps = {
    store,
    now: () => new Date(nowMs),
    notify: async (_u, n) => void notices.push(n),
    authenticateUser: async () => ({ userId: DAVID }),
    randomUUID: () => crypto.randomUUID(),
    publicUrl: "https://x.supabase.co/functions/v1/claude-events",
    ownerId: DAVID,
  };
  const call = async (method, p, body, token) => {
    const headers = new Headers();
    if (token) headers.set("x-wabid-device-token", token);
    return handleApi({ method, path: `/claude-events${p}`, headers, body: body === undefined ? "" : JSON.stringify(body) }, deps);
  };
  // fetch falso que enruta a handleApi, como lo vería la laptop.
  const fetchImpl = async (url, init) => {
    const p = new URL(url).pathname.replace("/functions/v1/claude-events", "");
    const res = await call(init.method, p, init.body ? JSON.parse(init.body) : undefined, init.headers["x-wabid-device-token"]);
    return new Response(JSON.stringify(res.body), { status: res.status });
  };
  return { store, notices, call, fetchImpl, tick: (ms) => void (nowMs += ms) };
}

async function pairRunner(b) {
  const res = await b.call("POST", "/ui/devices", { name: "Laptop" });
  assert.match(res.body.token, DEVICE_TOKEN_OK);
  return { token: res.body.token, hookConfig: { url: "https://x.supabase.co/functions/v1/claude-events", token: res.body.token }, deviceId: res.body.device.id };
}


test("punta a punta: tarea del celular -> runner -> claude falso -> resultado y aviso", async () => {
  const b = backend();
  const hook = await pairRunner(b);
  await b.call("POST", "/device/tasks/next", { projects: ["demo"] }, hook.token); // el runner reporta sus nombres
  const created = await b.call("POST", "/ui/tasks", { project: "demo", prompt: "OK\nhaz el build" });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // Para que runnerLoop use el claude falso se inyecta por claudeCommand en la config.
  const cfg = runner.parseRunnerConfig(JSON.stringify({ projects: { demo: projectDir }, claudeCommand: [process.execPath, FAKE], pollSeconds: 3 }));
  const logs = [];
  await runner.runnerLoop({ config: cfg, hookConfig: hook.hookConfig, fetchImpl: b.fetchImpl, sleep: async () => {}, log: (m) => logs.push(m), env: fakeEnv(), heartbeatMs: 40, maxIterations: 2 });

  const row = [...b.store.tasks.values()][0];
  assert.equal(row.status, "terminada");
  assert.match(row.result, /Hecho: todo bien/);
  assert.ok(!row.result.includes("sk-ant-api03"));
  assert.ok(row.session_id);
  assert.equal(b.notices.length, 1);
  assert.equal(b.notices[0].kind, "claude");
  assert.equal(b.notices[0].url, "/claude");
  assert.equal(logs.join("\n").includes("haz el build"), false, "el prompt nunca va al log");
});

test("punta a punta: una tarea para un proyecto fuera de la allowlist local se rechaza en la laptop", async () => {
  const b = backend();
  const hook = await pairRunner(b);
  // Se salta la validación del servidor a propósito (p. ej. un servidor comprometido): la laptop debe rechazar igual.
  await b.store.insertTask({ task_id: crypto.randomUUID(), user_id: DAVID, device_id: hook.deviceId, project: "secreto", prompt: "OK", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  const t0 = [...b.store.tasks.values()][0];
  b.store.tasks.get(t0.task_id).created_at = "2026-10-05T14:59:00.000Z";
  b.store.tasks.get(t0.task_id).expires_at = "2026-10-05T20:00:00.000Z";
  const cfg = runner.parseRunnerConfig(JSON.stringify({ projects: { demo: projectDir }, claudeCommand: [process.execPath, FAKE] }));
  const log = path.join(tmp, "rechazo.log");
  await runner.runnerLoop({ config: cfg, hookConfig: hook.hookConfig, fetchImpl: b.fetchImpl, sleep: async () => {}, log: () => {}, env: fakeEnv({ FAKE_CLAUDE_LOG: log }), maxIterations: 2 });
  const row = [...b.store.tasks.values()][0];
  assert.equal(row.status, "rechazada");
  assert.match(row.error, /fuera de la lista/);
  assert.throws(() => readFileSync(log), "claude ni siquiera se lanzó");
});

test("punta a punta: cancelar desde el celular mata el proceso y deja la tarea cancelada", async () => {
  const b = backend();
  const hook = await pairRunner(b);
  await b.call("POST", "/device/tasks/next", { projects: ["demo"] }, hook.token);
  const created = (await b.call("POST", "/ui/tasks", { project: "demo", prompt: "HANG" })).body.task;
  const pidFile = path.join(tmp, "e2e-cancel.pid");
  const cfg = runner.parseRunnerConfig(JSON.stringify({ projects: { demo: projectDir }, claudeCommand: [process.execPath, FAKE], maxMinutes: 5 }));

  const looping = runner.runnerLoop({ config: cfg, hookConfig: hook.hookConfig, fetchImpl: b.fetchImpl, sleep: async () => {}, log: () => {}, env: fakeEnv({ FAKE_PID_FILE: pidFile }), heartbeatMs: 40, maxIterations: 2 });
  // Espera a que arranque y cancela como lo haría el celular.
  for (let i = 0; i < 100 && b.store.tasks.get(created.id).status !== "ejecutando"; i++) await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => setTimeout(r, 300));
  const cancel = await b.call("POST", `/ui/tasks/${created.id}/cancel`);
  assert.equal(cancel.body.task.cancel_requested, true);
  await looping;
  assert.equal(b.store.tasks.get(created.id).status, "cancelada");
  assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))));
  assert.equal(b.notices.length, 0);
});

test("el bucle se recupera de un fallo de red y sigue consultando", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error("sin red");
    return new Response(JSON.stringify({ task: null }), { status: 200 });
  };
  const sleeps = [];
  const logs = [];
  await runner.runnerLoop({ config: config(), hookConfig: { url: "https://x.supabase.co/functions/v1/claude-events", token: "wbd.3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq" }, fetchImpl, sleep: async (ms) => void sleeps.push(ms), log: (m) => logs.push(m), maxIterations: 3 });
  assert.equal(calls, 3);
  assert.ok(sleeps[0] > sleeps[1], "primero espera por el error, luego el intervalo normal");
  assert.equal(sleeps[1], 3000);
  assert.ok(logs.some((l) => l.includes("no se pudo consultar")));
});
