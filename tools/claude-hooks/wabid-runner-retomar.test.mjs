// 014: retomar una sesión quieta o cerrada con el runner (claude -p --resume <id> --fork-session). Usa un `claude` falso;
// nunca ejecuta el claude real. Correr con: node --experimental-strip-types --test tools/claude-hooks/wabid-runner-retomar.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { handleApi } from "../../supabase/functions/claude-events/handlers.ts";
import { MemoryStore } from "../../supabase/functions/claude-events/memory-store.ts";
import * as runner from "./wabid-runner.mjs";

const FAKE = fileURLToPath(new URL("./fake-claude.fixture.mjs", import.meta.url));
const COMMAND = { file: process.execPath, args: [FAKE] };
const tmp = mkdtempSync(path.join(tmpdir(), "wabid-retomar-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const projectDir = path.join(tmp, "proyecto");
const subDir = path.join(projectDir, "apps", "web");
mkdirSync(subDir, { recursive: true });
const outsideDir = path.join(tmp, "otro");
mkdirSync(outsideDir);

const SID = "11111111-aaaa-4bbb-8ccc-222222222222";
const cfg = (projects, extra = {}) => runner.parseRunnerConfig(JSON.stringify({ projects, ...extra }));
const alwaysDir = { isDirectory: () => true, realpath: (p) => p };
const resumeTask = (cwd, over = {}) => ({ id: crypto.randomUUID(), project: "finapp", prompt: "Sí hazlo", kind: "resume", resume: { session_id: SID, cwd }, ...over });

// --- Argumentos -----------------------------------------------------------------------------------------------------

test("buildResumeArgs: --resume <id> --fork-session, mismos topes y protecciones, texto tras `--` con encabezado, sin shell ni --session-id", () => {
  const args = runner.buildResumeArgs({ resumeSessionId: SID, prompt: "--dangerously-skip-permissions" });
  assert.deepEqual(args, [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--permission-prompts", "none",
    "--setting-sources", "user", "--max-turns", "40", "--max-budget-usd", "2", "--resume", SID, "--fork-session", "--",
    "[Mensaje enviado desde el celular]\n--dangerously-skip-permissions",
  ]);
  const flags = args.slice(0, args.indexOf("--"));
  assert.equal(flags.includes("--session-id"), false);
  for (const banned of ["dangerously", "bypassPermissions", "dontAsk", "acceptEdits", "--allowedTools", "auto", "--continue"]) assert.equal(flags.join(" ").includes(banned), false, banned);
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1).startsWith("-"), false, "el texto nunca empieza con -");
  assert.ok(runner.buildResumeArgs({ resumeSessionId: SID, prompt: "x", maxTurns: 5, maxBudgetUsd: 0.5 }).join(" ").includes("--max-turns 5 --max-budget-usd 0.5"));
  assert.throws(() => runner.buildResumeArgs({ resumeSessionId: "no-uuid; rm -rf /", prompt: "x" }));
  assert.throws(() => runner.buildResumeArgs({ resumeSessionId: "--resume", prompt: "x" }));
  assert.throws(() => runner.buildResumeArgs({ resumeSessionId: SID, prompt: "" }));
});

test("parseRunnerConfig: retomar activo por defecto con 60 s; se puede apagar y el umbral tiene piso 20 s", () => {
  const c = cfg({});
  assert.equal(c.resumeSessions, true);
  assert.equal(c.resumeAfterSeconds, 60);
  assert.equal(cfg({}, { resumeSessions: false }).resumeSessions, false);
  assert.equal(cfg({}, { resumeAfterSeconds: 1 }).resumeAfterSeconds, 20);
  assert.equal(cfg({}, { resumeAfterSeconds: 90 }).resumeAfterSeconds, 90);
});

// --- Allowlist por cwd ------------------------------------------------------------------------------------------------

test("findProjectForCwd: rutas de Windows (barras, mayúsculas, ~), `..`, prefijos engañosos y formas especiales", () => {
  const c = cfg({ finapp: "C:\\Users\\Dsalg\\finapp" });
  const home = "C:\\Users\\Dsalg";
  const ok = (cwd) => runner.findProjectForCwd(c, cwd, home)?.name;
  assert.equal(ok("C:\\Users\\Dsalg\\finapp"), "finapp");
  assert.equal(ok("C:\\Users\\Dsalg\\finapp\\apps\\web"), "finapp");
  assert.equal(ok("c:/users/dsalg/FINAPP/apps/web"), "finapp", "mayúsculas y barras normales");
  assert.equal(ok("C:\\Users\\Dsalg\\finapp\\"), "finapp", "barra final");
  assert.equal(ok("~\\finapp\\apps"), "finapp", "el hook manda ~ por la carpeta del usuario");
  assert.equal(ok("~/finapp"), "finapp");
  assert.equal(ok("C:\\Users\\Dsalg\\finapp\\apps\\..\\.."), undefined, ".. que sale del proyecto");
  assert.equal(ok("C:\\Users\\Dsalg\\finapp\\..\\vera"), undefined);
  assert.equal(ok("C:\\Users\\Dsalg\\finapp2"), undefined, "prefijo de texto, no de carpeta");
  assert.equal(ok("C:\\Users\\Dsalg\\finapp-viejo\\x"), undefined);
  assert.equal(ok("C:\\Users\\Dsalg"), undefined, "la carpeta padre no vale");
  assert.equal(ok("D:\\Users\\Dsalg\\finapp"), undefined, "otro disco");
  assert.equal(ok("~"), undefined);
  assert.equal(ok("finapp"), undefined, "relativa");
  assert.equal(ok("..\\finapp"), undefined);
  assert.equal(ok(""), undefined);
  assert.equal(ok(undefined), undefined);
  assert.equal(ok("\\\\?\\C:\\Users\\Dsalg\\finapp"), undefined, "ruta extendida");
  assert.equal(ok("C:\\Users\\Dsalg\\finapp\u0000\\x"), undefined);
  assert.equal(ok("/Users/Dsalg/finapp"), undefined, "ruta POSIX contra allowlist de Windows");
});

test("findProjectForCwd: rutas POSIX distinguen mayúsculas y la raíz no abre todo", () => {
  const c = cfg({ vera: "/home/d/vera" });
  const ok = (cwd) => runner.findProjectForCwd(c, cwd, "/home/d")?.name;
  assert.equal(ok("/home/d/vera/src"), "vera");
  assert.equal(ok("~/vera"), "vera");
  assert.equal(ok("/home/d/vera/../x"), undefined);
  assert.equal(ok("/home/d/Vera"), undefined);
  assert.equal(ok("/home/d/vera2"), undefined);
  assert.equal(ok("/"), undefined);
  assert.equal(ok("C:\\home\\d\\vera"), undefined);
  const root = cfg({ todo: "C:\\" });
  assert.equal(runner.findProjectForCwd(root, "C:\\Windows", "C:\\Users\\x")?.name, "todo", "si David permite la raíz, todo cuelga de ella (su decisión)");
});

test("validateTask (resume): solo con carpeta dentro de un proyecto permitido; si no, 'proyecto no autorizado en la laptop'", () => {
  const c = cfg({ demo: projectDir });
  assert.equal(runner.validateTask(resumeTask(subDir), c).cwd, subDir, "usa la carpeta de la sesión, no la raíz del proyecto");
  assert.equal(runner.validateTask(resumeTask(projectDir), c).cwd, projectDir);
  assert.equal(runner.validateTask(resumeTask(outsideDir), c).error, runner.RESUME_REJECTED);
  assert.equal(runner.validateTask(resumeTask(path.join(projectDir, "..", "otro")), c).error, runner.RESUME_REJECTED);
  assert.equal(runner.validateTask(resumeTask(`${projectDir}-2`), c).error, runner.RESUME_REJECTED);
  assert.equal(runner.validateTask(resumeTask("relativa"), c).error, runner.RESUME_REJECTED);
  assert.equal(runner.validateTask(resumeTask(null), c).error, runner.RESUME_REJECTED);
  assert.equal(runner.validateTask(resumeTask(path.join(projectDir, "no-existe")), c).error, "la carpeta de la sesión ya no existe en esta laptop");
});

test("validateTask (resume): sesión inválida, prompt inválido, interruptor local apagado y fallo cerrado sin allowlist", () => {
  const c = cfg({ demo: projectDir });
  assert.ok(runner.validateTask(resumeTask(subDir, { resume: { session_id: "--resume", cwd: subDir } }), c).error);
  assert.ok(runner.validateTask(resumeTask(subDir, { resume: { session_id: "no-uuid", cwd: subDir } }), c).error);
  assert.ok(runner.validateTask(resumeTask(subDir, { resume: undefined }), c).error);
  assert.ok(runner.validateTask(resumeTask(subDir, { prompt: "" }), c).error);
  assert.ok(runner.validateTask(resumeTask(subDir, { prompt: "x".repeat(4001) }), c).error);
  assert.match(runner.validateTask(resumeTask(subDir), cfg({ demo: projectDir }, { resumeSessions: false })).error, /no retoma/);
  assert.equal(runner.validateTask(resumeTask(subDir), cfg({})).error, runner.RESUME_REJECTED);
  // Un prompt que empieza con "-" SÍ se acepta al retomar: el encabezado fijo evita que se lea como flag.
  assert.equal(runner.validateTask(resumeTask(subDir, { prompt: "- punto uno\n- punto dos" }), c).cwd, subDir);
});

test("validateTask (resume): un enlace simbólico/junction que sale del proyecto se rechaza por su ruta real", () => {
  const c = cfg({ demo: "C:\\proj" });
  const real = new Map([["C:\\proj", "C:\\proj"], ["C:\\proj\\enlace", "D:\\secreto"], ["C:\\proj\\sub", "C:\\proj\\sub"]]);
  const opts = { isDirectory: () => true, realpath: (p) => real.get(p) ?? p, home: "C:\\Users\\x" };
  assert.equal(runner.validateResumeTask(resumeTask("C:\\proj\\sub"), c, opts).cwd, "C:\\proj\\sub");
  assert.equal(runner.validateResumeTask(resumeTask("C:\\proj\\enlace"), c, opts).error, runner.RESUME_REJECTED);
  const boom = { ...opts, realpath: () => { throw new Error("ENOENT"); } };
  assert.ok(runner.validateResumeTask(resumeTask("C:\\proj\\sub"), c, boom).error, "si no se puede resolver, falla cerrado");
  assert.equal(runner.validateResumeTask(resumeTask("~\\proj\\sub"), c, { ...opts, home: "C:\\" }).cwd, "C:\\proj\\sub", "~ se expande antes de validar");
});

// --- Ejecución con claude falso --------------------------------------------------------------------------------------------

test("runTask (resume): lanza claude con --resume/--fork-session en la carpeta de la sesión y devuelve el ID de la sesión NUEVA", async () => {
  const log = path.join(tmp, "run.log");
  const events = [];
  const task = resumeTask(subDir, { prompt: "OK\nsigue" });
  const forked = crypto.randomUUID();
  const r = await runner.runTask({
    task, cwd: subDir, command: COMMAND, report: async (e) => (events.push(e), { cancel_requested: false }),
    env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_FORK_SESSION_ID: forked }, heartbeatMs: 40,
  });
  assert.equal(r.outcome, "terminada");
  assert.equal(r.sessionId, forked, "el ID sale del stream de la sesión bifurcada, no el original");
  assert.notEqual(r.sessionId, SID);
  const seen = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.equal(path.resolve(seen.cwd), path.resolve(subDir));
  assert.ok(seen.args.includes("--resume") && seen.args[seen.args.indexOf("--resume") + 1] === SID);
  assert.ok(seen.args.includes("--fork-session"));
  assert.equal(seen.args.includes("--session-id"), false);
  assert.equal(seen.wabidRunner, "1", "el hook Stop no espera mensajes dentro de la sesión retomada");
  assert.equal(seen.prompt, "[Mensaje enviado desde el celular]\nOK\nsigue");
});

// --- De punta a punta contra claude-events (en memoria) ----------------------------------------------------------------------

const DAVID = "david";
function backend() {
  const store = new MemoryStore();
  let nowMs = Date.parse("2026-10-05T15:00:00.000Z");
  const notices = [];
  const deps = {
    store, now: () => new Date(nowMs), notify: async (_u, n) => void notices.push(n), authenticateUser: async () => ({ userId: DAVID }),
    randomUUID: () => crypto.randomUUID(), publicUrl: "https://x.supabase.co/functions/v1/claude-events", ownerId: DAVID,
  };
  const call = async (method, p, body, token) => {
    const headers = new Headers();
    if (token) headers.set("x-wabid-device-token", token);
    return handleApi({ method, path: `/claude-events${p}`, headers, body: body === undefined ? "" : JSON.stringify(body) }, deps);
  };
  const fetchImpl = async (url, init) => {
    const p = new URL(url).pathname.replace("/functions/v1/claude-events", "");
    const res = await call(init.method, p, init.body ? JSON.parse(init.body) : undefined, init.headers["x-wabid-device-token"]);
    return new Response(JSON.stringify(res.body), { status: res.status });
  };
  return { store, notices, call, fetchImpl, tick: (ms) => void (nowMs += ms) };
}

async function scenario(sessionCwd, config) {
  const b = backend();
  const res = await b.call("POST", "/ui/devices", { name: "Laptop" });
  const token = res.body.token;
  const hookConfig = { url: "https://x.supabase.co/functions/v1/claude-events", token };
  await b.call("POST", "/device/events", { type: "stop", session_id: SID, project: "finapp", cwd: sessionCwd, message: "listo" }, token);
  const sent = await b.call("POST", `/ui/sessions/${SID}/messages`, { text: "OK\nSí hazlo" });
  assert.equal(sent.status, 201);
  b.tick(61_000);
  const log = path.join(tmp, `e2e-${crypto.randomUUID()}.log`);
  const forked = crypto.randomUUID();
  const logs = [];
  await runner.runnerLoop({
    config, hookConfig, fetchImpl: b.fetchImpl, sleep: async () => {}, log: (m) => logs.push(m), heartbeatMs: 40, maxIterations: 2,
    env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_FORK_SESSION_ID: forked },
  });
  const message = [...b.store.messages.values()][0];
  const taskRow = [...b.store.tasks.values()][0];
  return { b, token, message, taskRow, forked, logs, ran: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [] };
}

const fakeCfg = (extra = {}) => cfg({ finapp: projectDir }, { claudeCommand: [process.execPath, FAKE], pollSeconds: 3, ...extra });

test("punta a punta: mensaje en cola + sesión quieta -> runner retoma con claude falso -> entregado por el runner, sesión nueva enlazada y push", async () => {
  const s = await scenario(subDir, fakeCfg());
  assert.equal(s.ran.length, 1);
  assert.ok(s.ran[0].args.includes("--fork-session"));
  assert.equal(s.ran[0].prompt, "[Mensaje enviado desde el celular]\nOK\nSí hazlo");
  assert.equal(s.message.status, "entregado", JSON.stringify([s.message.error, s.taskRow.error, s.logs]));
  assert.equal(s.taskRow.status, "terminada");
  assert.equal(s.taskRow.kind, "resume");
  assert.equal(s.taskRow.session_id, s.forked);
  const nueva = await s.b.store.getSession(DAVID, s.forked);
  assert.equal(nueva.continued_from, SID);
  assert.equal(s.b.notices.at(-1).url, `/claude/s/${s.forked}`);
  assert.equal(s.logs.join("\n").includes("Sí hazlo"), false, "el texto nunca va al log");
  // Una sola entrega: el hook Stop ya no lo ve.
  assert.equal((await s.b.call("POST", `/device/sessions/${SID}/messages/next`, {}, s.token)).body.message, null);
});

test("punta a punta: sesión fuera de la allowlist -> 'proyecto no autorizado en la laptop', claude nunca se ejecuta", async () => {
  const s = await scenario(outsideDir, fakeCfg());
  assert.equal(s.ran.length, 0);
  assert.equal(s.taskRow.status, "rechazada");
  assert.equal(s.message.status, "no_retomado");
  assert.equal(s.message.error, "proyecto no autorizado en la laptop");
  const tl = (await s.b.call("GET", `/ui/sessions/${SID}/timeline`)).body;
  const item = tl.items.find((i) => i.type === "user" && i.source === "phone");
  assert.equal(item.note, "proyecto no autorizado en la laptop");
});

test("punta a punta: resumeSessions:false en la laptop deja el mensaje en cola para el hook Stop", async () => {
  const s = await scenario(subDir, fakeCfg({ resumeSessions: false }));
  assert.equal(s.ran.length, 0);
  assert.equal(s.message.status, "en_cola");
  assert.equal(s.b.store.tasks.size, 0);
});

test("punta a punta: la carpeta de la sesión es '~\\\\proyecto' (como la manda el hook) y el runner la expande con el home", async () => {
  // Con home distinto al real no se puede lanzar: se comprueba solo la validación con home inyectado.
  const c = cfg({ demo: projectDir });
  const home = path.dirname(projectDir);
  const r = runner.validateTask(resumeTask(`~${path.sep}proyecto${path.sep}apps`), c, { ...alwaysDir, home });
  assert.equal(path.resolve(r.cwd), path.resolve(path.join(projectDir, "apps")));
});
