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
//   - Retomar (014): un mensaje del celular que quedó esperando a una sesión quieta o cerrada llega como tarea "resume".
//     Se ejecuta `claude -p --resume <id> --fork-session`: continúa esa conversación en una sesión NUEVA (no choca con una
//     terminal que siga abierta). La carpeta de la sesión debe estar DENTRO de un proyecto permitido de la allowlist local.
//   - Nunca usa --dangerously-skip-permissions ni modos que salten permisos. Lo que la tarea pida pasa por el
//     hook PermissionRequest de Wabid (tarjeta en el celular, con el modo ausente activo); sin respuesta, se deniega.
//
// Formato de `claude -p` y de los eventos stream-json: https://code.claude.com/docs/en/headless

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, clipMiddle, collapseHome, configPath, parseConfig, redactSecrets, sanitizeText } from "./wabid-hook.mjs";

export const MAX_PROMPT_CHARS = 4000;
export const DEFAULT_MAX_MINUTES = 30;
export const DEFAULT_POLL_SECONDS = 10;
// Topes por tarea (--max-turns / --max-budget-usd, ambos solo en modo -p). Conservadores; se suben en el json local.
export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_MAX_BUDGET_USD = 2;
// Cuánto espera un mensaje del celular (con la sesión quieta/cerrada) antes de que el runner lo retome. Rango que acepta el servidor.
export const DEFAULT_RESUME_AFTER_SECONDS = 60;
// El prompt de retomar lleva siempre este encabezado: Claude sabe de dónde viene el mensaje y el texto nunca empieza con "-".
export const RESUME_PROMPT_HEADER = "[Mensaje enviado desde el celular]";
export const RESUME_REJECTED = "proyecto no autorizado en la laptop";
// --permission-prompts none existe desde esta versión de Claude Code (docs: cli-reference).
export const MIN_CLAUDE_VERSION = [2, 1, 259];
// Si tras matar el proceso `close` no llega en este tiempo, se fuerza y se sigue con la siguiente tarea.
const FORCE_AFTER_KILL_MS = 10_000;
// Tras un cierre forzado se espera un poco antes de tomar otra tarea, para que el sistema libere el árbol de procesos.
const FORCE_SETTLE_MS = 5000;
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
  const out = {
    projects: new Map(),
    claudeCommand: null,
    maxMinutes: DEFAULT_MAX_MINUTES,
    pollSeconds: DEFAULT_POLL_SECONDS,
    maxTurns: DEFAULT_MAX_TURNS,
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
    resumeSessions: true,
    resumeAfterSeconds: DEFAULT_RESUME_AFTER_SECONDS,
    problems: [],
  };
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
  out.maxTurns = Math.round(clamp(data.maxTurns, 1, 200, DEFAULT_MAX_TURNS));
  out.maxBudgetUsd = clamp(data.maxBudgetUsd, 0.1, 50, DEFAULT_MAX_BUDGET_USD);
  out.maxMinutes = clamp(data.maxMinutes, 1, 120, DEFAULT_MAX_MINUTES);
  out.pollSeconds = clamp(data.pollSeconds, 3, 120, DEFAULT_POLL_SECONDS);
  out.resumeSessions = data.resumeSessions !== false; // interruptor local: false = este runner no retoma sesiones
  out.resumeAfterSeconds = Math.round(clamp(data.resumeAfterSeconds, 20, 3600, DEFAULT_RESUME_AFTER_SECONDS));
  return out;
}

// La allowlist: solo se resuelve lo que está EXACTAMENTE en el archivo. Map evita trucos como "__proto__".
export function resolveProject(config, name) {
  return typeof name === "string" && config.projects.has(name) ? config.projects.get(name) : null;
}

// --- Carpeta de una sesión dentro de la allowlist (retomar) -------------------------------------------------------------
// La carpeta viene del servidor (la reportó el hook, con el inicio recortado a "~"): NO es de confianza. Se expande, se
// normaliza (.., barras, mayúsculas en Windows) y debe quedar igual o DENTRO de la ruta de algún proyecto permitido.
export function expandHome(p, home = os.homedir()) {
  if (typeof p !== "string") return null;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const join = /^[A-Za-z]:|^\\\\/.test(home) ? path.win32 : path.posix;
    return join.join(home, p.slice(2));
  }
  return p;
}

// { win, norm } o null si la ruta no es absoluta o es de las formas especiales de Windows (\\?\, \\.\).
function normalizeAbs(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 1000 || p.includes("\u0000")) return null;
  if (p.startsWith("\\\\?\\") || p.startsWith("\\\\.\\") || p.startsWith("//?/") || p.startsWith("//./")) return null;
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")) return { win: true, norm: path.win32.resolve(p).toLowerCase() };
  if (p.startsWith("/")) return { win: false, norm: path.posix.resolve(p) };
  return null;
}

function isInside(child, parent) {
  if (!child || !parent || child.win !== parent.win) return false;
  const sep = child.win ? "\\" : "/";
  const base = parent.norm.endsWith(sep) ? parent.norm : parent.norm + sep;
  return child.norm === parent.norm || child.norm.startsWith(base);
}

// realpath en Windows puede devolver la forma extendida (\\?\C:\x, \\?\UNC\srv\share): es la MISMA carpeta. Solo para rutas ya
// resueltas por el sistema; la cwd que llega del servidor con esa forma se sigue rechazando (normalizeAbs).
export function stripExtendedPrefix(p) {
  if (typeof p !== "string") return p;
  if (/^\\\\\?\\UNC\\/i.test(p)) return "\\\\" + p.slice(8);
  if (/^\\\\\?\\[A-Za-z]:\\/.test(p)) return p.slice(4);
  return p;
}

// Devuelve { name, dir } del proyecto permitido que contiene `cwd`, o null. Solo lexical (el caso real se confirma con realpath).
export function findProjectForCwd(config, cwd, home = os.homedir()) {
  const target = normalizeAbs(expandHome(cwd, home));
  if (!target) return null;
  for (const [name, dir] of config.projects) {
    if (isInside(target, normalizeAbs(dir))) return { name, dir };
  }
  return null;
}

// Un prompt que empieza con "-" se rechaza además de ir detrás de `--` (defensa en profundidad contra inyección de flags).
export const isValidPrompt = (p) =>
  typeof p === "string" && p.trim().length >= 1 && p.length <= MAX_PROMPT_CHARS && !p.includes("\u0000") && !p.trimStart().startsWith("-");

// --- Lectura en caliente de la allowlist ---------------------------------------------------------------------------
// Se vuelve a leer el archivo cuando cambia (mtime/tamaño): `remove` revoca un proyecto sin reiniciar el runner.
// Falla cerrado: sin archivo, o con un archivo roto, no hay proyectos permitidos.
export function createConfigReloader(file, { stat = statSync, read = readFileSync, exists = existsSync } = {}) {
  let sig = null;
  let current = parseRunnerConfig("{}");
  return function getConfig() {
    if (!exists(file)) {
      sig = null;
      current = parseRunnerConfig("{}");
      return current;
    }
    let s;
    try {
      s = stat(file);
    } catch {
      return current;
    }
    const next = `${s.mtimeMs}:${s.size}`;
    if (next !== sig) {
      try {
        current = parseRunnerConfig(read(file, "utf8"));
        sig = next;
      } catch {
        /* lectura a medias: se reintenta en la próxima vuelta */
      }
    }
    return current;
  };
}

// --- Versión de claude ------------------------------------------------------------------------------------------------
export function parseClaudeVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function versionAtLeast(v, min = MIN_CLAUDE_VERSION) {
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

// Corre `claude --version` (sin shell) y devuelve { ok, version?, error? }.
export function checkClaudeVersion(command, { spawnImpl = nodeSpawn, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    if (!command || command.error) return resolve({ ok: false, error: command?.error ?? "claude no encontrado" });
    let out = "";
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    let child;
    try {
      child = spawnImpl(command.file, [...command.args, "--version"], { stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: `No se pudo ejecutar claude --version (${e?.code ?? "error"})` });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ya terminó */
      }
      done({ ok: false, error: "claude --version no respondió" });
    }, timeoutMs);
    child.stdout?.on("data", (c) => (out += c.toString("utf8")));
    child.on("error", (e) => done({ ok: false, error: `No se pudo ejecutar claude --version (${e?.code ?? "error"})` }));
    child.on("close", () => {
      const v = parseClaudeVersion(out);
      const need = MIN_CLAUDE_VERSION.join(".");
      if (!v) return done({ ok: false, error: `No pude leer la versión de claude (se necesita ${need} o superior)` });
      if (!versionAtLeast(v)) return done({ ok: false, version: v.join("."), error: `Claude Code ${v.join(".")} es muy viejo: se necesita ${need} o superior (--permission-prompts). Actualiza con \`claude update\`.` });
      done({ ok: true, version: v.join(".") });
    });
  });
}

// --- Un solo runner a la vez ---------------------------------------------------------------------------------------------
// Archivo de bloqueo con el pid. Si el pid anterior ya no existe, el bloqueo es viejo y se toma.
// Se guarda { pid, boot }: `boot` es la hora de arranque del sistema. Windows reusa pids tras reiniciar, así que un pid vivo
// con otro `boot` es un bloqueo viejo. Se crea con flag "wx" (falla si existe): dos arranques simultáneos no se pisan.
export const systemBootSeconds = (now = Date.now(), uptime = os.uptime()) => Math.round(now / 1000 - uptime);
const BOOT_TOLERANCE_S = 5; // now() - uptime() oscila un poco entre lecturas

export function acquireLock(file, { pid = process.pid, boot = systemBootSeconds(), isAlive, read = readFileSync, write = writeFileSync, remove = unlinkSync, mkdir = (d) => mkdirSync(d, { recursive: true }) } = {}) {
  const alive =
    isAlive ??
    ((p) => {
      try {
        process.kill(p, 0);
        return true;
      } catch (e) {
        return e && e.code === "EPERM";
      }
    });
  const readLock = () => {
    try {
      const raw = String(read(file, "utf8")).trim();
      const data = raw.startsWith("{") ? JSON.parse(raw) : { pid: Number.parseInt(raw, 10) }; // formato viejo: solo el pid
      return Number.isInteger(data.pid) ? data : null;
    } catch {
      return null;
    }
  };
  mkdir(path.dirname(file));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      write(file, JSON.stringify({ pid, boot }), { flag: "wx" });
      return {
        ok: true,
        release: () => {
          const cur = readLock();
          if (cur && cur.pid === pid) {
            try {
              remove(file);
            } catch {
              /* ya no está */
            }
          }
        },
      };
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    }
    // Existe: ¿sigue vivo ese runner? Mismo arranque del sistema Y pid vivo; si no, es un bloqueo viejo y se retira.
    const other = readLock();
    const sameBoot = other && typeof other.boot === "number" ? Math.abs(other.boot - boot) <= BOOT_TOLERANCE_S : false;
    if (other && other.pid !== pid && sameBoot && alive(other.pid)) return { ok: false, pid: other.pid };
    try {
      remove(file);
    } catch {
      /* otro runner lo retiró primero */
    }
  }
  return { ok: false, pid: null }; // perdió la carrera dos veces: otro runner está arrancando
}

// ---------------------------------------------------------------------------------------------------------
// Cómo se llama a claude
// ---------------------------------------------------------------------------------------------------------

// Todo lo fijo va antes de `--`; el prompt es el ÚNICO argumento posicional y va después (`claude -p "query"` es la
// forma documentada; `--` evita que un prompt se lea como flag). Spawn sin shell: sin interpolación.
// Fijos: stream-json para seguir el progreso, modo de permisos `default` (sin esto un -p puede arrancar en `auto`),
// `--permission-prompts none` (lo que pediría permiso se deniega y Claude sabe que no debe reintentar; los hooks
// PermissionRequest siguen decidiendo antes), topes de turnos y de gasto, y `--setting-sources user`: no carga los
// hooks, MCP ni permisos del .claude/ del proyecto (un repo no puede traer su propia configuración a la tarea).
// Ojo: las reglas `allow` GLOBALES de ~/.claude/settings.json de David siguen aplicando sin tarjeta en el celular.
export function buildClaudeArgs({ sessionId, prompt, maxTurns = DEFAULT_MAX_TURNS, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD }) {
  if (!UUID_RE.test(sessionId)) throw new Error("sessionId debe ser un UUID");
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("falta el prompt");
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "default",
    "--permission-prompts", "none",
    "--setting-sources", "user",
    "--max-turns", String(maxTurns),
    "--max-budget-usd", String(maxBudgetUsd),
    "--session-id", sessionId,
    "--",
    prompt,
  ];
}

// Retomar: igual que buildClaudeArgs pero `--resume <id> --fork-session` en lugar de `--session-id`. Verificado en
// https://code.claude.com/docs/en/cli-reference (--resume por ID, --fork-session "crea un ID de sesión nuevo en lugar de reusar
// el original"). El ID de la sesión nueva sale del evento system/init del stream. Sin --session-id (la doc no dice que se pueda
// combinar con --resume). El texto del celular va tras `--`, con un encabezado fijo: nunca empieza con "-".
export function buildResumeArgs({ resumeSessionId, prompt, maxTurns = DEFAULT_MAX_TURNS, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD }) {
  if (!UUID_RE.test(resumeSessionId)) throw new Error("la sesión a retomar debe ser un UUID");
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("falta el prompt");
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "default",
    "--permission-prompts", "none",
    "--setting-sources", "user",
    "--max-turns", String(maxTurns),
    "--max-budget-usd", String(maxBudgetUsd),
    "--resume", resumeSessionId,
    "--fork-session",
    "--",
    `${RESUME_PROMPT_HEADER}\n${prompt}`,
  ];
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
  // Windows con la instalación de npm: en el PATH solo hay un shim sin extensión (claude / claude.cmd) que spawn sin shell no
  // encuentra (ENOENT). El ejecutable real está dentro del paquete.
  if (platform === "win32" && env.APPDATA) {
    const npmExe = path.win32.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (exists(npmExe)) return { file: npmExe, args: [] };
  }
  const hint = platform === "win32" ? " Tampoco está en %APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe." : "";
  return { error: `No encuentro claude.exe en el PATH.${hint} Pon su ruta en claudeCommand de claude-runner.json (p. ej. "C:\\Users\\tu\\.local\\bin\\claude.exe").` };
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
export function killTree(child, { platform = process.platform, spawnImpl = nodeSpawn, force = false } = {}) {
  // `force`: segundo intento tras un cierre que no llegó; aunque el hijo directo ya no responda, se vuelve a ir por el árbol.
  if (!child || (!force && child.exitCode !== null) || child.pid === undefined) return;
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
  maxTurns = DEFAULT_MAX_TURNS,
  maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  signal,
  forceAfterMs = FORCE_AFTER_KILL_MS,
  forceSettleMs = FORCE_SETTLE_MS,
}) {
  const startedAt = Date.now();
  const sessionId = randomUUID();
  const tracker = new StreamTracker();
  let stderrTail = "";
  let timedOut = false;
  let cancelled = false;
  let spawnError = null;
  let forced = false;
  let aborted = false;

  const isResume = task.kind === "resume";
  const args = [
    ...command.args,
    ...(isResume
      ? buildResumeArgs({ resumeSessionId: task.resume.session_id, prompt: task.prompt, maxTurns, maxBudgetUsd })
      : buildClaudeArgs({ sessionId, prompt: task.prompt, maxTurns, maxBudgetUsd })),
  ];
  const child = spawnImpl(command.file, args, {
    cwd,
    // WABID_RUNNER=1: el hook Stop de Wabid no espera mensajes dentro de esta sesión.
    env: { ...env, WABID_RUNNER: "1", WABID_RUNNER_TASK: task.id },
    stdio: ["ignore", "pipe", "pipe"], // stdin cerrado: el prompt va como argumento posicional
    shell: false,
    windowsHide: true,
    detached: platform !== "win32",
  });
  onChild(child);

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
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

  // Mata el árbol y, si `close` no llega a tiempo (un nieto que retiene las tuberías), fuerza: mata el hijo,
  // destruye las tuberías y suelta la tarea para que el runner siga con la siguiente.
  let forceTimer = null;
  const stop = () => {
    killImpl(child, { platform });
    if (forceTimer) return;
    forceTimer = setTimeout(() => {
      forced = true;
      // Segundo intento sobre el árbol (taskkill /T /F en Windows; SIGTERM+SIGKILL al grupo en el resto), y se deja registro.
      log(`el proceso (pid ${child.pid}) no cerró ${Math.round(forceAfterMs / 1000)} s después de detenerlo: se vuelve a matar el árbol`);
      killImpl(child, { platform, force: true });
      try {
        child.kill();
      } catch {
        /* ya terminó */
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveDone(null);
    }, forceAfterMs);
  };
  const onAbort = () => {
    aborted = true;
    stop();
  };
  if (signal) signal.aborted ? onAbort() : signal.addEventListener("abort", onAbort, { once: true });
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
  if (forceTimer) clearTimeout(forceTimer);
  signal?.removeEventListener("abort", onAbort);
  if (buffered.trim()) tracker.feed(buffered);
  if (forced) await new Promise((r) => setTimeout(r, forceSettleMs));

  // Al retomar, el ID de la sesión nueva lo decide claude (sale del stream); si no llegó a emitirlo no se inventa uno.
  const base = { sessionId: tracker.sessionId ?? (isResume ? null : sessionId), durationMs: Date.now() - startedAt };
  if (forced) return { outcome: "fallida", error: `claude no terminó tras detenerlo (${Math.round(forceAfterMs / 1000)} s): se forzó el cierre`, ...base };
  if (aborted) return { outcome: "fallida", error: "El runner se detuvo (cierre de sesión o apagado)", ...base };
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
export function validateTask(task, config, { isDirectory = (p) => existsSync(p) && statSync(p).isDirectory(), realpath = (p) => realpathSync.native(p), home = os.homedir() } = {}) {
  if (!task || typeof task !== "object" || typeof task.id !== "string" || !UUID_RE.test(task.id)) return { error: "Tarea inválida" };
  if (task.kind === "resume") return validateResumeTask(task, config, { isDirectory, realpath, home });
  const cwd = resolveProject(config, task.project);
  if (!cwd) return { error: "Proyecto fuera de la lista permitida de esta laptop" };
  if (!isValidPrompt(task.prompt)) return { error: "Prompt inválido (vacío, demasiado largo o empieza con «-»)" };
  if (!isDirectory(cwd)) return { error: "La carpeta del proyecto no existe en esta laptop" };
  return { cwd };
}

// Retomar: la sesión debe ser un UUID, el prompt válido, y su carpeta (la que reportó el hook) debe estar DENTRO de un proyecto de
// la allowlist local. Si no: "proyecto no autorizado en la laptop" (el servidor lo muestra en el chat). Devuelve { cwd } o { error }.
export function validateResumeTask(task, config, { isDirectory, realpath, home }) {
  const r = task.resume;
  if (!config.resumeSessions) return { error: "esta laptop no retoma sesiones (resumeSessions: false)" };
  if (!r || typeof r !== "object" || typeof r.session_id !== "string" || !UUID_RE.test(r.session_id)) return { error: "sesión a retomar inválida" };
  // Aquí el "-" inicial no importa: el texto siempre va detrás de `--` y del encabezado fijo (buildResumeArgs).
  if (typeof task.prompt !== "string" || task.prompt.trim().length < 1 || task.prompt.length > MAX_PROMPT_CHARS || task.prompt.includes("\u0000")) return { error: "mensaje inválido (vacío o demasiado largo)" };
  const raw = typeof r.cwd === "string" ? r.cwd : "";
  const match = findProjectForCwd(config, raw, home);
  if (!match) return { error: RESUME_REJECTED };
  // Se lanza con la ruta ya normalizada (sin `..` ni barras mezcladas): la que se validó es la que se usa.
  const expanded = expandHome(raw, home);
  const cwd = (normalizeAbs(expanded).win ? path.win32 : path.posix).resolve(expanded);
  if (!isDirectory(cwd)) return { error: "la carpeta de la sesión ya no existe en esta laptop" };
  // Enlaces simbólicos y junctions: la ruta real de la carpeta también debe quedar dentro de la ruta real del proyecto.
  try {
    const real = normalizeAbs(stripExtendedPrefix(realpath(cwd)));
    const root = normalizeAbs(stripExtendedPrefix(realpath(match.dir)));
    if (!isInside(real, root)) return { error: RESUME_REJECTED };
  } catch {
    return { error: "la carpeta de la sesión ya no existe en esta laptop" };
  }
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

// `getConfig()` se llama AQUÍ, justo antes de validar: un `remove` hecho mientras la tarea esperaba en cola la rechaza.
export async function handleTask({ task, getConfig, command, checkVersion = async () => ({ ok: true }), hookConfig, fetchImpl = fetch, sleep, log = () => {}, env = process.env, platform = process.platform, spawnImpl, killImpl, heartbeatMs, onChild, signal, forceAfterMs }) {
  const report = (event) => api(hookConfig, fetchImpl, "POST", `/device/tasks/${encodeURIComponent(task.id)}/events`, event, 8000);
  const config = getConfig();

  const valid = validateTask(task, config);
  if (valid.error) {
    log(`tarea rechazada: ${valid.error}`);
    await reportWithRetry(report, { type: "finish", outcome: "rechazada", error: valid.error }, sleep).catch(() => {});
    return { outcome: "rechazada" };
  }
  const refuse = async (error) => {
    await reportWithRetry(report, { type: "finish", outcome: "fallida", error }, sleep).catch(() => {});
    return { outcome: "fallida" };
  };
  if (command.error) return refuse(command.error);
  const version = await checkVersion();
  if (!version.ok) return refuse(version.error);

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
    signal,
    forceAfterMs,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
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

// `getConfig` (o `config` fijo, para pruebas) se evalúa en CADA vuelta: la allowlist que se reporta y contra la que
// se valida es siempre la actual del archivo.
export async function runnerLoop({ config, getConfig = () => config, hookConfig, fetchImpl = fetch, sleep = defaultSleep, log = () => {}, signal, env = process.env, platform = process.platform, spawnImpl, killImpl, heartbeatMs, onChild, forceAfterMs, maxIterations = Infinity, versionCheck = checkClaudeVersion }) {
  let command = resolveClaudeCommand({ config: getConfig(), env, platform });
  if (command.error) log(command.error);
  // La versión se comprueba una vez al arrancar y de nuevo antes de cada tarea mientras no haya salido bien.
  let versionState = null;
  const checkVersion = async () => {
    if (command.error) {
      command = resolveClaudeCommand({ config: getConfig(), env, platform });
      if (command.error) return { ok: false, error: command.error };
    }
    if (!versionState || !versionState.ok) versionState = await versionCheck(command, spawnImpl ? { spawnImpl } : {});
    return versionState;
  };
  const first = await checkVersion();
  log(first.ok ? `claude ${first.version ?? ""} listo`.trim() : `claude no está listo: ${first.error}`);

  let failures = 0;
  for (let i = 0; i < maxIterations && !(signal && signal.aborted); i++) {
    const cfg = getConfig();
    let task = null;
    try {
      const res = await api(hookConfig, fetchImpl, "POST", "/device/tasks/next", { projects: [...cfg.projects.keys()], resume: cfg.resumeSessions, resume_after_seconds: cfg.resumeAfterSeconds }, 8000);
      task = res && res.task ? res.task : null;
      failures = 0;
    } catch (e) {
      failures++;
      log(`no se pudo consultar a Wabid: ${e instanceof Error ? e.message : "error"}`);
      await sleep(Math.min(60, cfg.pollSeconds * 2 ** Math.min(failures, 3)) * 1000);
      continue;
    }
    if (task) {
      if (command.error) command = resolveClaudeCommand({ config: cfg, env, platform });
      await handleTask({ task, getConfig, command, checkVersion, hookConfig, fetchImpl, sleep, log, env, platform, spawnImpl, killImpl, heartbeatMs, onChild, signal, forceAfterMs });
      continue; // otra consulta enseguida: puede haber más en cola
    }
    await sleep(cfg.pollSeconds * 1000);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Línea de comandos
// ---------------------------------------------------------------------------------------------------------

const log = (m) => process.stderr.write(`${new Date().toISOString()} wabid-runner: ${m}\n`);

export const runnerLockPath = (env = process.env, platform = process.platform, home = os.homedir()) =>
  path.join(path.dirname(runnerConfigPath(env, platform, home)), "claude-runner.lock");

function saveProjects(file, mutate) {
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
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
  const file = runnerConfigPath();
  const getConfig = createConfigReloader(file);
  const config = getConfig();

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
    console.log(`Permitido: ${a} -> ${dir}  (${file})`);
    return console.log("Cuidado: dentro de ese proyecto Claude puede editar archivos. No agregues el repo de Wabid (finapp): una tarea podría modificar estos scripts.");
  }
  if (cmd === "remove") {
    if (!a) return void (process.exitCode = 1, console.error("Uso: node wabid-runner.mjs remove <nombre>"));
    saveProjects(file, (p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== a)));
    return console.log(`Quitado: ${a} (el runner en marcha lo deja de aceptar en su próxima vuelta, sin reiniciar)`);
  }
  if (cmd === "check") {
    for (const p of config.problems) console.log(`aviso: ${p}`);
    const hook = existsSync(configPath()) ? parseConfig(readFileSync(configPath(), "utf8")) : null;
    console.log(`Conexión con Wabid (${configPath()}): ${hook ? "configurada" : "FALTA: corre `node wabid-hook.mjs setup`"}`);
    const c = resolveClaudeCommand({ config });
    console.log(`claude: ${c.error ?? [c.file, ...c.args].join(" ")}`);
    const v = await checkClaudeVersion(c);
    console.log(`versión: ${v.ok ? `${v.version} (>= ${MIN_CLAUDE_VERSION.join(".")})` : `PROBLEMA: ${v.error}`}`);
    if (!v.ok) process.exitCode = 1;
    console.log(`Proyectos permitidos: ${[...config.projects.keys()].join(", ") || "(ninguno)"}`);
    console.log(`Topes por tarea: ${config.maxMinutes} min · ${config.maxTurns} turnos · US$ ${config.maxBudgetUsd}`);
    console.log(config.resumeSessions ? `Retomar sesiones quietas: sí, tras ${config.resumeAfterSeconds} s en cola (solo carpetas dentro de los proyectos permitidos)` : "Retomar sesiones quietas: NO (resumeSessions: false)");
    return;
  }
  if (cmd !== undefined && cmd !== "run") return void (process.exitCode = 1, console.error("Comandos: run (por defecto), list, add, remove, check"));

  const hookConfig = existsSync(configPath()) ? parseConfig(readFileSync(configPath(), "utf8")) : null;
  if (!hookConfig) return void (process.exitCode = 1, log(`sin conexión configurada en ${configPath()}: corre \`node wabid-hook.mjs setup\``));
  const lock = acquireLock(runnerLockPath());
  if (!lock.ok) return void (process.exitCode = 1, log(`ya hay un runner corriendo (pid ${lock.pid}); no arranco otro`));
  for (const p of config.problems) log(`configuración: ${p}`);
  if (config.projects.size === 0) log(`no hay proyectos permitidos todavía: node wabid-runner.mjs add <nombre> <ruta>`);

  const controller = new AbortController();
  // Cierre de sesión (SIGHUP; SIGBREAK en Windows), Ctrl+C o apagado: se aborta la tarea en curso (se mata su árbol y se
  // reporta fallida) y se sale. Si algo se cuelga, se sale igual a los 30 s.
  const shutdown = () => {
    controller.abort();
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(sig, shutdown);
    } catch {
      /* esa señal no existe en este sistema */
    }
  }
  process.on("exit", () => lock.release());
  log(`listo: consultando a Wabid cada ${config.pollSeconds} s (${config.projects.size} proyectos permitidos)`);
  await runnerLoop({ getConfig, hookConfig, log, signal: controller.signal });
  lock.release();
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
