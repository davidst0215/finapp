#!/usr/bin/env node
// Wabid · runner de tareas. Corre en tu laptop (Node 18+, sin dependencias): pregunta a Wabid si lanzaste una
// tarea desde el celular y, si es así, ejecuta Claude Code en modo no interactivo (`claude -p`) en esa carpeta.
//
//   node wabid-runner.mjs            queda sondeando (lo arranca la tarea programada de instalar-runner.mjs)
//   node wabid-runner.mjs list       proyectos permitidos
//   node wabid-runner.mjs add <nombre> <ruta>     permite un proyecto (nombre -> ruta absoluta)
//   node wabid-runner.mjs remove <nombre>
//   node wabid-runner.mjs check      verifica la configuración y encuentra claude
//
// Seguridad (ver SPEC-claude-code-v2.md):
//   - La lista de proyectos permitidos (nombre -> ruta) vive SOLO en el archivo de configuración de esta laptop
//     (%LOCALAPPDATA%\Wabid\claude-runner.json). El celular manda un nombre; si no está en la lista, se rechaza aquí.
//   - Una tarea a la vez, con tiempo máximo (30 min por defecto) y kill del árbol de procesos.
//   - Sin shell: `spawn` con argumentos. El prompt entra por stdin (nunca como argumento: no hay interpolación
//     y un prompt que empiece con "-" no puede pasar por flag).
//   - Nunca usa --dangerously-skip-permissions ni modos que salten permisos. Lo que la tarea pida pasa por el
//     hook PermissionRequest de Wabid (tarjeta en el celular, con el modo ausente activo); sin respuesta, se deniega.
//
// Formato de `claude -p` y de los eventos stream-json: https://code.claude.com/docs/en/headless

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, clipMiddle, collapseHome, configPath, parseConfig, redactSecrets, sanitizeText } from "./wabid-hook.mjs";

export const MAX_PROMPT_CHARS = 4000;
export const DEFAULT_MAX_MINUTES = 30;
export const DEFAULT_POLL_SECONDS = 10;
const HEARTBEAT_MS = 5000;
const NAME_RE = /^[A-Za-z0-9._ -]{1,60}$/;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULT_LIMITS = { max: 1500, head: 1000, tail: 400 };

// ---------------------------------------------------------------------------------------------------------
// Configuración local y allowlist
// ---------------------------------------------------------------------------------------------------------

export function runnerConfigPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.WABID_RUNNER_CONFIG) return env.WABID_RUNNER_CONFIG;
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Wabid", "claude-runner.json");
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, ".config"), "wabid", "claude-runner.json");
}

const isAbsolutePath = (p) => typeof p === "string" && (path.win32.isAbsolute(p) || path.posix.isAbsolute(p)) && !p.startsWith("\\\\?\\");
const clamp = (n, min, max, fallback) => (typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback);

// Devuelve { projects: Map(nombre -> ruta absoluta), claudeCommand, maxMinutes, pollSeconds, problems: string[] }.
// Una entrada inválida se descarta (y se reporta en `problems`); nunca se "corrige" ni se adivina una ruta.
export function parseRunnerConfig(raw) {
  const out = { projects: new Map(), claudeCommand: null, maxMinutes: DEFAULT_MAX_MINUTES, pollSeconds: DEFAULT_POLL_SECONDS, problems: [] };
  let data;
  try {
    data = JSON.parse(typeof raw === "string" && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    out.problems.push("el archivo no es JSON válido");
    return out;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    out.problems.push("el archivo debe ser un objeto JSON");
    return out;
  }
  const projects = data.projects && typeof data.projects === "object" && !Array.isArray(data.projects) ? data.projects : {};
  for (const [name, dir] of Object.entries(projects)) {
    if (!NAME_RE.test(name)) out.problems.push(`nombre de proyecto inválido: "${name}"`);
    else if (!isAbsolutePath(dir)) out.problems.push(`"${name}": la ruta debe ser absoluta`);
    else out.projects.set(name, dir);
  }
  const cmd = data.claudeCommand;
  if (typeof cmd === "string" && cmd) out.claudeCommand = [cmd];
  else if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((x) => typeof x === "string" && x)) out.claudeCommand = [...cmd];
  out.maxMinutes = clamp(data.maxMinutes, 1, 120, DEFAULT_MAX_MINUTES);
  out.pollSeconds = clamp(data.pollSeconds, 3, 120, DEFAULT_POLL_SECONDS);
  return out;
}

// La allowlist: solo se resuelve lo que está EXACTAMENTE en el archivo. Map evita trucos como "__proto__".
export function resolveProject(config, name) {
  return typeof name === "string" && config.projects.has(name) ? config.projects.get(name) : null;
}

export const isValidPrompt = (p) => typeof p === "string" && p.trim().length >= 1 && p.length <= MAX_PROMPT_CHARS && !p.includes("\u0000");

// ---------------------------------------------------------------------------------------------------------
// Cómo se llama a claude
// ---------------------------------------------------------------------------------------------------------

// El prompt NO va aquí: entra por stdin. Fijos: stream-json para seguir el progreso, modo de permisos `default`
// (sin esto un -p puede arrancar en `auto`) y `--permission-prompts none` (lo que pediría permiso se deniega y
// Claude sabe que no debe reintentar; los hooks PermissionRequest siguen decidiendo antes).
export function buildClaudeArgs({ sessionId }) {
  if (!UUID_RE.test(sessionId)) throw new Error("sessionId debe ser un UUID");
  return ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--permission-prompts", "none", "--session-id", sessionId];
}

// Devuelve { file, args } (args = prefijo, para `node cli.js`) o { error }. Sin shell: un .cmd/.bat no se puede lanzar.
export function resolveClaudeCommand({ config, env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const explicit = config && config.claudeCommand;
  if (explicit) {
    const [file, ...args] = explicit;
    if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      return { error: `${file} es un script .cmd y no se puede lanzar sin shell. Usa claude.exe o ["node", "...\\cli.js"] en claudeCommand.` };
    }
    return { file, args };
  }
  const names = platform === "win32" ? ["claude.exe"] : ["claude"];
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH || env.Path || "").split(sep).filter(Boolean)) {
    for (const name of names) {
      const candidate = (platform === "win32" ? path.win32 : path.posix).join(dir, name);
      if (exists(candidate)) return { file: candidate, args: [] };
    }
  }
  return { error: 'No encuentro claude en el PATH. Pon su ruta en claudeCommand de claude-runner.json (p. ej. "C:\\\\Users\\\\tu\\\\.local\\\\bin\\\\claude.exe").' };
}

// ---------------------------------------------------------------------------------------------------------
// Salida stream-json -> progreso y resultado
// ---------------------------------------------------------------------------------------------------------

const oneLine = (text, max) => {
  const t = sanitizeText(redactSecrets(String(text))).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + "…" : t;
};

export const cleanOutput = (text, limits = RESULT_LIMITS) => clipMiddle(sanitizeText(redactSecrets(String(text))), limits.max, limits.head, limits.tail).text;

// "Usa Bash: npm run build" · "Lee ~\\finapp\\x.ts". Redactado; nunca incluye contenido de archivos.
export function summarizeToolUse(name, input, home = os.homedir()) {
  const tool = oneLine(name, 40);
  const i = input && typeof input === "object" ? input : {};
  const file = typeof i.file_path === "string" ? i.file_path : typeof i.notebook_path === "string" ? i.notebook_path : "";
  let detail = "";
  if ((name === "Bash" || name === "PowerShell") && typeof i.command === "string") detail = oneLine(i.command, 90);
  else if (file) detail = oneLine(collapseHome(file, home), 90);
  else if ((name === "Glob" || name === "Grep") && typeof i.pattern === "string") detail = oneLine(i.pattern, 60);
  return detail ? `Usa ${tool}: ${detail}` : `Usa ${tool}`;
}

export class StreamTracker {
  sessionId = null;
  progress = "";
  lastText = "";
  result = null;

  constructor(home = os.homedir()) {
    this.home = home;
  }

  feed(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!ev || typeof ev !== "object") return;
    if (typeof ev.session_id === "string" && SESSION_RE.test(ev.session_id)) this.sessionId = ev.session_id;

    if (ev.type === "assistant" && ev.parent_tool_use_id == null && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          this.lastText = block.text;
          this.progress = `Claude: ${oneLine(block.text, 140)}`;
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          this.progress = summarizeToolUse(block.name, block.input, this.home);
        }
      }
    } else if (ev.type === "result") {
      this.result = {
        isError: ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success"),
        subtype: typeof ev.subtype === "string" ? ev.subtype : "",
        text: typeof ev.result === "string" ? ev.result : "",
        errors: Array.isArray(ev.errors) ? ev.errors.filter((e) => typeof e === "string") : [],
        denials: Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Procesos
// ---------------------------------------------------------------------------------------------------------

// Mata el proceso y sus hijos (claude lanza bash/node). Windows: taskkill /T; resto: grupo de procesos.
export function killTree(child, { platform = process.platform, spawnImpl = nodeSpawn } = {}) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  try {
    if (platform === "win32") {
      const killer = spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
      killer.on?.("error", () => child.kill());
    } else {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ya terminó */
        }
      }, 3000).unref();
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* ya terminó */
    }
  }
}

// Ejecuta una tarea. `report(evento)` habla con Wabid y devuelve su respuesta ({ cancel_requested }).
// Devuelve { outcome: terminada|fallida|cancelada, result?, error?, sessionId, durationMs }.
export async function runTask({
  task,
  cwd,
  command,
  report,
  env = process.env,
  maxMs = DEFAULT_MAX_MINUTES * 60_000,
  heartbeatMs = HEARTBEAT_MS,
  platform = process.platform,
  spawnImpl = nodeSpawn,
  killImpl = killTree,
  onChild = () => {},
  log = () => {},
}) {
  const startedAt = Date.now();
  const sessionId = randomUUID();
  const tracker = new StreamTracker();
  let stderrTail = "";
  let timedOut = false;
  let cancelled = false;
  let spawnError = null;

  const args = [...command.args, ...buildClaudeArgs({ sessionId })];
  const child = spawnImpl(command.file, args, {
    cwd,
    // WABID_RUNNER=1: el hook Stop de Wabid no espera mensajes dentro de esta sesión.
    env: { ...env, WABID_RUNNER: "1", WABID_RUNNER_TASK: task.id },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: platform !== "win32",
  });
  onChild(child);

  const done = new Promise((resolve) => {
    child.on("error", (e) => {
      spawnError = e;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });

  child.stderr?.on("data", (c) => {
    stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
  });
  let buffered = "";
  child.stdout?.on("data", (c) => {
    buffered += c.toString("utf8");
    let nl;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      tracker.feed(buffered.slice(0, nl));
      buffered = buffered.slice(nl + 1);
    }
    if (buffered.length > 2_000_000) buffered = ""; // una línea absurda no debe crecer sin fin
  });
  child.stdin?.on("error", () => {}); // si claude muere antes de leer, no tumbar el runner
  child.stdin?.end(task.prompt);

  const stop = () => killImpl(child, { platform });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, maxMs);

  let lastSent = "";
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const message = tracker.progress && tracker.progress !== lastSent ? tracker.progress : undefined;
      const res = await report({ type: "progress", ...(message ? { message } : {}), ...(tracker.sessionId ? { session_id: tracker.sessionId } : {}) });
      if (message) lastSent = message;
      if (res && res.cancel_requested === true && !cancelled) {
        cancelled = true;
        stop();
      }
    } catch (e) {
      log(`latido: ${e instanceof Error ? e.message : "error"}`); // un fallo de red no mata la tarea; sin latido 3 min el servidor la da por fallida
    } finally {
      heartbeatBusy = false;
    }
  }, heartbeatMs);

  const code = await done;
  clearTimeout(timeout);
  clearInterval(heartbeat);
  if (buffered.trim()) tracker.feed(buffered);

  const base = { sessionId: tracker.sessionId ?? sessionId, durationMs: Date.now() - startedAt };
  if (cancelled) return { outcome: "cancelada", ...base };
  if (timedOut) return { outcome: "fallida", error: `Tiempo máximo (${Math.round(maxMs / 60_000)} min): se detuvo la tarea`, ...base };
  if (spawnError) return { outcome: "fallida", error: `No se pudo iniciar claude (${spawnError.code ?? "error"})`, ...base };

  const r = tracker.result;
  const denied = r && r.denials > 0 ? `\n[${r.denials} acciones sin permiso fueron denegadas: nadie las aprobó desde el celular]` : "";
  if (r) {
    const text = cleanOutput((r.text || tracker.lastText) + denied);
    if (r.isError) {
      const why = r.errors.length ? r.errors.join("; ") : r.subtype || "error";
      return { outcome: "fallida", error: oneLine(`Claude terminó con error: ${why}`, 280), ...(text ? { result: text } : {}), ...base };
    }
    return { outcome: "terminada", result: text || "(sin texto de respuesta)", ...base };
  }
  if (code === 0) return { outcome: "terminada", result: cleanOutput((tracker.lastText || "(sin texto de respuesta)") + denied), ...base };
  const tail = oneLine(stderrTail, 200);
  return { outcome: "fallida", error: `claude terminó con código ${code}${tail ? `: ${tail}` : ""}`, ...base };
}

// ---------------------------------------------------------------------------------------------------------
// Una tarea de Wabid, de punta a punta
// ---------------------------------------------------------------------------------------------------------

// Devuelve { cwd } o { error }. La ruta sale SOLO de la allowlist local.
export function validateTask(task, config, { isDirectory = (p) => existsSync(p) && statSync(p).isDirectory() } = {}) {
  if (!task || typeof task !== "object" || typeof task.id !== "string" || !UUID_RE.test(task.id)) return { error: "Tarea inválida" };
  const cwd = resolveProject(config, task.project);
  if (!cwd) return { error: "Proyecto fuera de la lista permitida de esta laptop" };
  if (!isValidPrompt(task.prompt)) return { error: "Prompt inválido" };
  if (!isDirectory(cwd)) return { error: "La carpeta del proyecto no existe en esta laptop" };
  return { cwd };
}

async function reportWithRetry(report, event, sleep, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await report(event);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000);
    }
  }
}

export async function handleTask({ task, config, command, hookConfig, fetchImpl = fetch, sleep, log = () => {}, env = process.env, platform = process.platform, spawnImpl, killImpl, heartbeatMs, onChild }) {
  const report = (event) => api(hookConfig, fetchImpl, "POST", `/device/tasks/${encodeURIComponent(task.id)}/events`, event, 8000);

  const valid = validateTask(task, config);
  if (valid.error) {
    log(`tarea rechazada: ${valid.error}`);
    await reportWithRetry(report, { type: "finish", outcome: "rechazada", error: valid.error }, sleep).catch(() => {});
    return { outcome: "rechazada" };
  }
  if (command.error) {
    await reportWithRetry(report, { type: "finish", outcome: "fallida", error: command.error }, sleep).catch(() => {});
    return { outcome: "fallida" };
  }

  // Avisar el inicio antes de lanzar: si Wabid no responde o la tarea ya no existe, no se ejecuta nada.
  let started;
  try {
    started = await report({ type: "start" });
  } catch (e) {
    log(`no se pudo avisar el inicio: ${e instanceof Error ? e.message : "error"}`);
    return { outcome: "fallida" };
  }
  if (!started || started.ok === false || started.cancel_requested === true) {
    await reportWithRetry(report, { type: "finish", outcome: "cancelada" }, sleep).catch(() => {});
    return { outcome: "cancelada" };
  }

  log(`ejecutando tarea en "${task.project}"`); // nunca el prompt
  const run = await runTask({
    task,
    cwd: valid.cwd,
    command,
    report,
    env,
    platform,
    spawnImpl,
    killImpl,
    heartbeatMs,
    onChild,
    maxMs: config.maxMinutes * 60_000,
    log,
  });
  try {
    await reportWithRetry(
      report,
      {
        type: "finish",
        outcome: run.outcome,
        session_id: run.sessionId,
        duration_ms: run.durationMs,
        ...(run.result ? { result: run.result } : {}),
        ...(run.error ? { error: run.error } : {}),
      },
      sleep,
    );
  } catch (e) {
    log(`no se pudo reportar el final: ${e instanceof Error ? e.message : "error"}`);
  }
  return run;
}

// ---------------------------------------------------------------------------------------------------------
// Bucle principal
// ---------------------------------------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runnerLoop({ config, hookConfig, fetchImpl = fetch, sleep = defaultSleep, log = () => {}, signal, env = process.env, platform = process.platform, spawnImpl, killImpl, heartbeatMs, onChild, maxIterations = Infinity }) {
  const command = resolveClaudeCommand({ config, env, platform });
  if (command.error) log(command.error);
  let failures = 0;
  for (let i = 0; i < maxIterations && !(signal && signal.aborted); i++) {
    let task = null;
    try {
      const res = await api(hookConfig, fetchImpl, "POST", "/device/tasks/next", { projects: [...config.projects.keys()] }, 8000);
      task = res && res.task ? res.task : null;
      failures = 0;
    } catch (e) {
      failures++;
      log(`no se pudo consultar a Wabid: ${e instanceof Error ? e.message : "error"}`);
      await sleep(Math.min(60, config.pollSeconds * 2 ** Math.min(failures, 3)) * 1000);
      continue;
    }
    if (task) {
      await handleTask({ task, config, command, hookConfig, fetchImpl, sleep, log, env, platform, spawnImpl, killImpl, heartbeatMs, onChild });
      continue; // otra consulta enseguida: puede haber más en cola
    }
    await sleep(config.pollSeconds * 1000);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Línea de comandos
// ---------------------------------------------------------------------------------------------------------

const log = (m) => process.stderr.write(`${new Date().toISOString()} wabid-runner: ${m}\n`);

function loadRunnerConfig() {
  const file = runnerConfigPath();
  if (!existsSync(file)) return { file, config: parseRunnerConfig("{}"), exists: false };
  return { file, config: parseRunnerConfig(readFileSync(file, "utf8")), exists: true };
}

function saveProjects(file, mutate) {
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      throw new Error(`${file} no es JSON válido; arréglalo a mano`);
    }
  }
  data.projects = mutate(data.projects && typeof data.projects === "object" ? data.projects : {});
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const { file, config } = loadRunnerConfig();

  if (cmd === "list") {
    for (const p of config.problems) console.log(`aviso: ${p}`);
    if (config.projects.size === 0) console.log(`Sin proyectos permitidos. Agrega uno: node wabid-runner.mjs add <nombre> <ruta>   (${file})`);
    for (const [name, dir] of config.projects) console.log(`${name}  ->  ${dir}`);
    return;
  }
  if (cmd === "add") {
    if (!NAME_RE.test(a ?? "") || !b) return void (process.exitCode = 1, console.error("Uso: node wabid-runner.mjs add <nombre> <ruta absoluta>"));
    const dir = path.resolve(b);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return void (process.exitCode = 1, console.error(`No existe la carpeta ${dir}`));
    saveProjects(file, (p) => ({ ...p, [a]: dir }));
    return console.log(`Permitido: ${a} -> ${dir}  (${file})`);
  }
  if (cmd === "remove") {
    if (!a) return void (process.exitCode = 1, console.error("Uso: node wabid-runner.mjs remove <nombre>"));
    saveProjects(file, (p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== a)));
    return console.log(`Quitado: ${a}`);
  }
  if (cmd === "check") {
    for (const p of config.problems) console.log(`aviso: ${p}`);
    const hook = existsSync(configPath()) ? parseConfig(readFileSync(configPath(), "utf8")) : null;
    console.log(`Conexión con Wabid (${configPath()}): ${hook ? "configurada" : "FALTA: corre `node wabid-hook.mjs setup`"}`);
    const c = resolveClaudeCommand({ config });
    console.log(`claude: ${c.error ?? [c.file, ...c.args].join(" ")}`);
    console.log(`Proyectos permitidos: ${[...config.projects.keys()].join(", ") || "(ninguno)"}  ·  máximo ${config.maxMinutes} min por tarea`);
    return;
  }
  if (cmd !== undefined && cmd !== "run") return void (process.exitCode = 1, console.error("Comandos: run (por defecto), list, add, remove, check"));

  const hookConfig = existsSync(configPath()) ? parseConfig(readFileSync(configPath(), "utf8")) : null;
  if (!hookConfig) return void (process.exitCode = 1, log(`sin conexión configurada en ${configPath()}: corre \`node wabid-hook.mjs setup\``));
  for (const p of config.problems) log(`configuración: ${p}`);
  if (config.projects.size === 0) log(`no hay proyectos permitidos todavía: node wabid-runner.mjs add <nombre> <ruta>`);

  const controller = new AbortController();
  let active = null;
  const shutdown = () => {
    controller.abort();
    if (active) killTree(active);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  log(`listo: consultando a Wabid cada ${config.pollSeconds} s (${config.projects.size} proyectos permitidos)`);
  await runnerLoop({ config, hookConfig, log, signal: controller.signal, onChild: (c) => (active = c) });
}

const RUN_AS_SCRIPT = (() => {
  try {
    return process.env.WABID_HOOK_TEST !== "1" && !!process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (RUN_AS_SCRIPT) {
  main()
    .catch((e) => {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
}
