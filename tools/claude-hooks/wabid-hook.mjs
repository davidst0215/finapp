#!/usr/bin/env node
// Wabid · puente entre los hooks de Claude Code y tu asistente. Node 18+, sin dependencias.
//
//   node wabid-hook.mjs           (lo llama Claude Code: lee el JSON del hook por stdin)
//   node wabid-hook.mjs setup     guarda la URL y el token de este dispositivo
//   node wabid-hook.mjs test      prueba la conexión y deja una sesión de prueba en la app
//
// Reglas que no se rompen:
//   1. Nunca decide por su cuenta. Solo imprime "allow"/"deny" (permisos) o "block" con el mensaje de David (Stop) si el celular lo dijo explícitamente.
//      Si Wabid no responde, falla o vence, no imprime nada y Claude Code sigue con su flujo normal.
//   2. No imprime nada en stdout salvo la decisión: en SessionStart y otros eventos todo lo que salga por
//      stdout llega al contexto de Claude.
//   3. Los secretos se redactan aquí, antes de salir de la laptop. El servidor vuelve a redactar.
//
// Formato de entrada y salida: https://code.claude.com/docs/en/hooks

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------------
// Redacción de secretos y limpieza de texto
// Espejo de supabase/functions/claude-events/redact.ts. Ambos pasan tools/claude-hooks/redaction-cases.json.
// ---------------------------------------------------------------------------------------------------------

const MARK = "[oculto]";
const PEM_MARK = "[clave privada oculta]";

const PREFIXED_TOKENS = [
  String.raw`sk-ant-[A-Za-z0-9_-]{16,}`,
  String.raw`sk-(?:proj-)?[A-Za-z0-9_-]{20,}`,
  String.raw`sk_[a-f0-9]{32,}`,
  String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`,
  String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
  String.raw`AIza[0-9A-Za-z_-]{35}`,
  String.raw`ya29\.[0-9A-Za-z_-]{20,}`,
  String.raw`[sr]k_(?:live|test)_[0-9A-Za-z]{16,}`,
  String.raw`npm_[A-Za-z0-9]{30,}`,
  String.raw`glpat-[A-Za-z0-9_-]{16,}`,
  String.raw`sbp_[a-f0-9]{30,}`,
  String.raw`sb_secret_[A-Za-z0-9_-]{16,}`,
  String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
  String.raw`EAA[A-Za-z0-9]{50,}`,
  String.raw`wbd\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}`,
];

const VALUE = String.raw`("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'&;|)]{4,})`;

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, PEM_MARK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MARK],
  [new RegExp(String.raw`\b(?:${PREFIXED_TOKENS.join("|")})`, "g"), MARK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{12,}/gi, `$1 ${MARK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s@\/]+@/gi, `$1${MARK}@`],
  [/(\bsshpass\s+(?:-\w+\s+)*-p\s*)(?!\[oculto\])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, `$1${MARK}`],
  [/(\becho\s+(?:-n\s+)?)("[^"\n]*"|'[^'\n]*'|[^\s|"']+)(?=[ \t]*\|[^\n|]*--password-stdin)/gi, `$1${MARK}`],
  [/(\s(?:-u|--user)(?:[ \t]+|=))([^\s:"']+:)(?!\[oculto\])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, `$1$2${MARK}`],
  [/(\b(?:mysql|mariadb|mysqldump|psql|pg_dump|mongo|mongosh|sshpass)\b[^\n|;&]*?[ \t]-p)(?!\d+(?:\s|$))(?!\[oculto\])([^\s"'-][^\s"']{3,})/g, `$1${MARK}`],
  [/(\bauthorization["']?[ \t]*[:=][ \t]*[A-Za-z][\w-]*[ \t]+)(?!\[oculto\])[^\s"']{4,}/gi, `$1${MARK}`],
  [
    new RegExp(
      String.raw`(--?(?:password|passwd|pass|token|secret|api-?key|access-?key|auth-?token|client-?secret|private-?key)(?:=|[ \t]+))(?!\[oculto\]|-)("[^"\n]*"|'[^'\n]*'|\S+)`,
      "gi",
    ),
    `$1${MARK}`,
  ],
  [
    new RegExp(
      String.raw`((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)["']?[ \t]*[=:][ \t]*)(?!\[oculto\]|Bearer\b|Basic\b)${VALUE}`,
      "gi",
    ),
    `$1${MARK}`,
  ],
  [/(\bauthorization["']?[ \t]*[:=][ \t]*)(?!\[oculto\]|[A-Za-z][\w-]*[ \t]+\S)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'&;|)]{4,})/gi, `$1${MARK}`],
  [new RegExp(String.raw`([A-Z0-9]_KEY[ \t]*=[ \t]*)(?!\[oculto\])${VALUE}`, "g"), `$1${MARK}`],
];

export function redactSecrets(text) {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

const normalizeNewlines = (text) => text.replace(/\r\n?/g, "\n");
const markInvisible = (text) =>
  text.replace(INVISIBLE, (ch) => `[U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);

export const sanitizeText = (text) => markInvisible(normalizeNewlines(text));

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

function sliceHead(text, n) {
  const s = text.slice(0, n);
  return s.length > 0 && isHighSurrogate(s.charCodeAt(s.length - 1)) ? s.slice(0, -1) : s;
}
function sliceTail(text, n) {
  if (n <= 0) return "";
  const s = text.slice(-n);
  return s.length > 0 && isLowSurrogate(s.charCodeAt(0)) ? s.slice(1) : s;
}

export function clipMiddle(text, max, head, tail) {
  if (text.length <= max) return { text, truncated: false };
  const start = sliceHead(text, head);
  const end = sliceTail(text, tail);
  const omitted = text.length - start.length - end.length;
  return { text: `${start}\n[... ${omitted} caracteres omitidos ...]\n${end}`, truncated: true };
}

function clipText(text, max) {
  if (text.length <= max) return text;
  return sliceHead(text, Math.max(0, max - 1)) + "…";
}

const toOneLine = (text, max) => clipText(text.replace(/\s+/g, " ").trim(), max);

const INPUT_CAP = { max: 8000, head: 5000, tail: 3000 };

// Acotar → unificar saltos → redactar → marcar invisibles → recortar. Se redacta ANTES de recortar.
function normalizeForSending(text, limits) {
  const capped = clipMiddle(text, INPUT_CAP.max, INPUT_CAP.head, INPUT_CAP.tail);
  const clean = markInvisible(redactSecrets(normalizeNewlines(capped.text)));
  const clipped = clipMiddle(clean, limits.max, limits.head, limits.tail);
  return { text: clipped.text, truncated: capped.truncated || clipped.truncated };
}

const oneLine = (value, max) => (typeof value === "string" ? toOneLine(sanitizeText(redactSecrets(value)), max) : "");

// ---------------------------------------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------------------------------------

// Reemplaza el inicio de la ruta por "~" si es la carpeta del usuario (más corto y no revela el usuario).
export function collapseHome(p, home) {
  if (typeof p !== "string" || typeof home !== "string" || !home) return p;
  const norm = (s) => s.replace(/\\/g, "/").toLowerCase();
  const a = norm(p);
  const b = norm(home);
  if (a.length !== p.length || b.length !== home.length || !a.startsWith(b)) return p;
  const next = p[home.length];
  return next === undefined || next === "/" || next === "\\" ? "~" + p.slice(home.length) : p;
}

// Nombre corto de la carpeta de trabajo. Un worktree de agente (<repo>/.claude/worktrees/<nombre>) se
// identifica por repo y nombre, porque la última carpeta sola no distingue una sesión de otra.
export function projectFromCwd(cwd) {
  if (typeof cwd !== "string") return "";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return "";
  const i = parts.lastIndexOf("worktrees");
  if (i >= 2 && parts[i - 1] === ".claude" && parts[i + 1]) return clipText(`${parts[i - 2]} · ${parts[i + 1]}`, 60);
  return clipText(parts[parts.length - 1], 60);
}

// ---------------------------------------------------------------------------------------------------------
// Vista previa de lo que Claude pide permiso para hacer
// ---------------------------------------------------------------------------------------------------------

const COMMAND_LIMITS = { max: 2000, head: 1400, tail: 500 };
const NO_DETAIL = "(sin detalle)";

const str = (v) => (typeof v === "string" ? v : "");

function shortValue(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return oneLine(s, 120);
}

function genericPreview(toolInput) {
  const entries = Object.entries(toolInput ?? {}).slice(0, 6);
  if (entries.length === 0) return NO_DETAIL;
  return clipText(entries.map(([k, v]) => `${oneLine(k, 40)}: ${shortValue(v)}`).join("\n"), 600);
}

// Devuelve { preview, truncated, description? }. Nunca incluye el contenido de archivos que Claude escribe.
export function buildToolPreview(toolName, toolInput, home) {
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : {};
  const file = (p) => oneLine(collapseHome(str(p), home), 300);

  switch (toolName) {
    case "Bash":
    case "PowerShell": {
      const command = str(input.command);
      const description = oneLine(input.description, 200);
      const clipped = command ? normalizeForSending(command, COMMAND_LIMITS) : { text: NO_DETAIL, truncated: false };
      return { preview: clipped.text, truncated: clipped.truncated, ...(description ? { description } : {}) };
    }
    case "Write":
      return { preview: `${file(input.file_path)} (${str(input.content).length} caracteres)`, truncated: false };
    case "Edit": {
      const all = input.replace_all === true ? " (todas las coincidencias)" : "";
      return {
        preview: `${file(input.file_path)}\nReemplaza ${str(input.old_string).length} caracteres por ${str(input.new_string).length}${all}`,
        truncated: false,
      };
    }
    case "MultiEdit": {
      const n = Array.isArray(input.edits) ? input.edits.length : 0;
      return { preview: `${file(input.file_path)}\n${n} ediciones`, truncated: false };
    }
    case "NotebookEdit":
      return { preview: file(input.notebook_path), truncated: false };
    case "Read":
      return { preview: file(input.file_path), truncated: false };
    case "Glob":
    case "Grep":
      return { preview: `${oneLine(input.pattern, 200)}${input.path ? `\nen ${file(input.path)}` : ""}`, truncated: false };
    case "WebFetch":
      return { preview: `${oneLine(input.url, 300)}${input.prompt ? `\n${oneLine(input.prompt, 160)}` : ""}`, truncated: false };
    case "WebSearch":
      return { preview: oneLine(input.query, 300), truncated: false };
    case "Agent":
    case "Task":
      return { preview: `${oneLine(input.subagent_type, 60)}: ${oneLine(input.description, 200)}`, truncated: false };
    default:
      return { preview: genericPreview(input), truncated: false };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Entrada del hook → evento de Wabid
// ---------------------------------------------------------------------------------------------------------

// Preguntas y planes se contestan en la terminal: aprobarlos a ciegas desde el celular no tiene sentido.
const TERMINAL_ONLY_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
// En estos modos Claude Code no muestra diálogo de permiso: no hay nada que esperar.
const NO_PROMPT_MODES = new Set(["bypassPermissions", "auto", "dontAsk"]);
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

const token = (value, max) => (typeof value === "string" ? value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, max) : "");

// Devuelve el evento a enviar, o null si este evento no interesa o la entrada no es válida.
export function mapHookInput(input, { home } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;

  const common = {
    session_id: sessionId,
    project: projectFromCwd(input.cwd),
    cwd: oneLine(collapseHome(str(input.cwd), home), 300),
  };
  const withDetail = (type, detail, extra = {}) => ({
    type,
    ...common,
    ...(detail ? { detail } : {}),
    ...extra,
  });

  switch (input.hook_event_name) {
    case "SessionStart":
      // Una compactación no es una sesión nueva.
      return input.source === "compact" ? null : withDetail("session_start", token(input.source, 40));
    case "SessionEnd":
      return withDetail("session_end", token(input.reason, 40));
    case "Stop": {
      const message = oneLine(input.last_assistant_message, 280);
      return withDetail("stop", "", message ? { message } : {});
    }
    case "StopFailure": {
      const message = oneLine(input.last_assistant_message || input.error_details, 200);
      return withDetail("stop_failure", token(input.error, 40), message ? { message } : {});
    }
    case "Notification": {
      const message = oneLine(input.message, 200);
      return withDetail("notification", token(input.notification_type, 60), message ? { message } : {});
    }
    case "PermissionRequest": {
      const toolName = token(input.tool_name, 100);
      if (!toolName || TERMINAL_ONLY_TOOLS.has(toolName) || NO_PROMPT_MODES.has(input.permission_mode)) return null;
      const { preview, truncated, description } = buildToolPreview(toolName, input.tool_input, home);
      return withDetail("permission_request", "", {
        tool_name: toolName,
        preview,
        truncated,
        ...(description ? { description } : {}),
      });
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Respuesta que exige Claude Code (hooks reference → PermissionRequest decision control)
// ---------------------------------------------------------------------------------------------------------

export function buildPermissionOutput(status) {
  if (status === "aprobada") {
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
  }
  if (status === "denegada") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "David rechazó este permiso desde su celular (Wabid)." },
      },
    };
  }
  return null; // sin decisión: Claude Code muestra su diálogo normal
}

// Una sola línea que empieza con { y termina con }: así la reconoce Claude Code como JSON.
export const serializeOutput = (output) => JSON.stringify(output);

// ---------------------------------------------------------------------------------------------------------
// Configuración local (fuera del repo)
// ---------------------------------------------------------------------------------------------------------

const TOKEN_RE = /^wbd\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
const stripBom = (s) => (typeof s === "string" && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function configPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.WABID_HOOK_CONFIG) return env.WABID_HOOK_CONFIG;
  if (platform === "win32") {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Wabid", "claude-hook.json");
  }
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, ".config"), "wabid", "claude-hook.json");
}

// Devuelve { url, token } o null. Solo https: con http, un intermediario podría contestar "aprobado".
export function parseConfig(raw) {
  let data;
  try {
    data = JSON.parse(stripBom(raw));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { url, token: deviceToken } = data;
  if (typeof url !== "string" || typeof deviceToken !== "string" || !TOKEN_RE.test(deviceToken)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) return null;
  const config = { url: url.replace(/\/+$/, ""), token: deviceToken };
  // Opcional: cuántos minutos espera el hook Stop un mensaje del celular con el modo ausente activo.
  if (typeof data.stop_wait_minutes === "number") config.stopWaitMinutes = data.stop_wait_minutes;
  return config;
}

// ---------------------------------------------------------------------------------------------------------
// Hook Stop: entregar mensajes del celular (SPEC-claude-code-v2.md)
// Formato oficial (hooks reference → Stop decision control): exit 0 y {"decision":"block","reason":"..."}
// hace que Claude siga trabajando con `reason` como instrucción.
// ---------------------------------------------------------------------------------------------------------

export const STOP_POLL_MS = 3000;
// Con el modo ausente activo, CADA turno de Claude espera hasta este tiempo un mensaje del celular antes de terminar.
// Por eso el defecto es corto (2 min); `stop_wait_minutes: 0` en claude-hook.json lo apaga.
export const DEFAULT_STOP_WAIT_MINUTES = 2;
// El timeout del hook en settings es 900 s; la espera máxima deja margen para las consultas y la salida.
export const MAX_STOP_WAIT_MINUTES = 14;
export const STOP_HOOK_TIMEOUT_SECONDS = 900;
const CLAIM_TIMEOUT_MS = 5000;
// El aviso inicial del Stop es síncrono (bloquea el fin del turno): si Wabid tarda más, se sigue sin esperar nada.
const STOP_POST_TIMEOUT_MS = 3000;
const ACK_TRIES = 3;
const ACK_RETRY_MS = 250;
const CLAIM_MAX_CONSECUTIVE_ERRORS = 3;

// Minutos configurados -> milisegundos, con tope. Un valor inválido cae al defecto; 0 desactiva la espera.
export function stopWaitMs(config) {
  const m = config && config.stopWaitMinutes;
  const minutes = typeof m === "number" && Number.isFinite(m) && m >= 0 ? Math.min(m, MAX_STOP_WAIT_MINUTES) : DEFAULT_STOP_WAIT_MINUTES;
  return Math.round(minutes * 60_000);
}

export function buildStopOutput(text) {
  return { decision: "block", reason: `David te escribió desde su celular (Wabid). Sigue con esto:\n${text}` };
}

// Confirma la entrega. Un fallo no se oculta del todo (se reintenta), pero nunca rompe el hook: lo peor es que el
// mensaje vuelva a la cola tras 60 s.
async function ackMessage(config, fetchImpl, messageId, sleep) {
  if (!UUID_RE.test(messageId)) return false;
  for (let i = 0; i < ACK_TRIES; i++) {
    try {
      await api(config, fetchImpl, "POST", `/device/messages/${encodeURIComponent(messageId)}/ack`, {}, CLAIM_TIMEOUT_MS);
      return true;
    } catch {
      if (i < ACK_TRIES - 1) await sleep(ACK_RETRY_MS);
    }
  }
  return false;
}

const claimMessage = (config, fetchImpl, sessionId) =>
  api(config, fetchImpl, "POST", `/device/sessions/${encodeURIComponent(sessionId)}/messages/next`, {}, CLAIM_TIMEOUT_MS);

// Devuelve el JSON de salida del hook Stop o null (dejar terminar). Falla abierto: ante cualquier error Claude termina normal.
export async function handleStop({ sessionId, away, config, fetchImpl, now, sleep, env = {} }) {
  // Las sesiones que lanza el runner del celular no esperan mensajes: terminan y reportan.
  if (env.WABID_RUNNER === "1") return null;
  const deadline = now() + (away ? stopWaitMs(config) : 0);
  let errors = 0;
  for (;;) {
    let answer;
    try {
      answer = await claimMessage(config, fetchImpl, sessionId);
      errors = 0;
    } catch {
      if (++errors >= CLAIM_MAX_CONSECUTIVE_ERRORS) return null;
      answer = null;
    }
    const text = answer && answer.message && typeof answer.message.text === "string" ? answer.message.text : "";
    // Fase 1 de la entrega hecha (el mensaje está 'entregando' en Wabid): quien llama escribe stdout y luego confirma.
    if (text) return { output: buildStopOutput(text), messageId: typeof answer.message.id === "string" ? answer.message.id : "" };
    // Sin modo ausente (o apagado mientras esperaba) o sin tiempo: solo se entrega lo que ya estaba en cola.
    const stillAway = answer ? answer.away === true : true;
    if (!stillAway || now() >= deadline) return null;
    await sleep(Math.min(STOP_POLL_MS, Math.max(0, deadline - now())));
  }
}

function loadConfig() {
  try {
    return parseConfig(readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Conversación con Wabid
// ---------------------------------------------------------------------------------------------------------

const EVENT_TIMEOUT_MS = 4000;
const PERMISSION_POST_TIMEOUT_MS = 4000; // si Wabid tarda más, mejor que Claude Code pregunte en la terminal
const POLL_TIMEOUT_MS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function api(config, fetchImpl, method, route, body, timeoutMs) {
  const res = await fetchImpl(`${config.url}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-wabid-device-token": config.token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error", // una redirección podría reenviar el token a otro host
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`); // nunca incluir cabeceras ni cuerpo: ahí va el token
  return await res.json();
}

export const postEvent = (config, fetchImpl, event, timeoutMs = EVENT_TIMEOUT_MS) =>
  api(config, fetchImpl, "POST", "/device/events", event, timeoutMs);

const getApprovalStatus = (config, fetchImpl, id) =>
  api(config, fetchImpl, "GET", `/device/approvals/${encodeURIComponent(id)}`, undefined, POLL_TIMEOUT_MS);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sondea hasta que el celular decida o venza. Devuelve "aprobada", "denegada" o null (= no decidir).
// Un fallo de red o una respuesta rara nunca cuenta como aprobación.
export async function waitForDecision({
  approval,
  fetchStatus,
  sleep = defaultSleep,
  now = Date.now,
  graceMs = 6000,
  maxConsecutiveErrors = 5,
}) {
  const interval = Math.min(10000, Math.max(1000, Number(approval.poll_interval_ms) || 2000));
  const budget = Number.isFinite(approval.expires_in_ms) ? approval.expires_in_ms : 120000;
  const deadline = now() + budget + graceMs; // el servidor decide cuándo vence; esto es solo el tope
  let errors = 0;
  while (now() < deadline) {
    await sleep(interval);
    let answer;
    try {
      answer = await fetchStatus(approval.id);
      errors = 0;
    } catch {
      if (++errors >= maxConsecutiveErrors) return null;
      continue;
    }
    const status = answer && answer.status;
    if (status === "aprobada" || status === "denegada") return status;
    if (status === "vencida") return null;
  }
  return null;
}

// Procesa un evento de hook. Devuelve la línea JSON a imprimir en stdout, o null (no imprimir nada).
export async function runHook({ raw, config, fetchImpl = fetch, home, now = Date.now, sleep = defaultSleep, log = () => {}, env = process.env, onOutput }) {
  let input;
  try {
    input = JSON.parse(stripBom(raw));
  } catch {
    return null;
  }
  const event = mapHookInput(input, { home });
  if (!event) return null;
  if (!config) {
    log("sin configuración: ejecuta `node wabid-hook.mjs setup`");
    return null;
  }

  const isPermission = event.type === "permission_request";
  let response;
  try {
    response = await postEvent(
      config,
      fetchImpl,
      event,
      isPermission ? PERMISSION_POST_TIMEOUT_MS : event.type === "stop" ? STOP_POST_TIMEOUT_MS : EVENT_TIMEOUT_MS,
    );
  } catch (e) {
    log(`no se pudo enviar el evento: ${e instanceof Error ? e.message : "error"}`);
    return null;
  }
  if (event.type === "stop") {
    const delivery = await handleStop({ sessionId: event.session_id, away: response && response.away === true, config, fetchImpl, now, sleep, env });
    if (!delivery) return null;
    const line = serializeOutput(delivery.output);
    // Entrega en dos fases: primero se escribe stdout (onOutput) y SOLO después se confirma. Si el hook muere en medio,
    // Wabid reencola el mensaje a los 60 s en vez de darlo por entregado.
    if (onOutput) await onOutput(line);
    await ackMessage(config, fetchImpl, delivery.messageId, sleep);
    return line;
  }
  if (!isPermission) return null;

  const approval = response && response.approval;
  if (!approval || typeof approval.id !== "string" || !UUID_RE.test(approval.id)) return null;

  const decision = await waitForDecision({
    approval,
    fetchStatus: (id) => getApprovalStatus(config, fetchImpl, id),
    now,
    sleep,
  });
  const output = buildPermissionOutput(decision);
  return output ? serializeOutput(output) : null;
}

// ---------------------------------------------------------------------------------------------------------
// Línea de comandos
// ---------------------------------------------------------------------------------------------------------

const log = (message) => process.stderr.write(`wabid-hook: ${message}\n`);

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(""); // nadie está enviando JSON
    const chunks = [];
    const finish = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function writeStdout(text) {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

// Tope duro del proceso: 140 s en general; en Stop, la espera máxima de mensajes más margen (nunca pasa de 870 s).
export function hardLimitMs(raw, config) {
  let name = "";
  try {
    name = JSON.parse(stripBom(raw)).hook_event_name;
  } catch {
    /* entrada inválida: tope general */
  }
  return name === "Stop" ? stopWaitMs(config) + 30_000 : 140_000;
}

async function hookMode() {
  const raw = await readStdin(5000);
  if (!raw.trim()) {
    log("sin datos en stdin; Claude Code lo ejecuta solo. Ayuda: node wabid-hook.mjs help");
    return;
  }
  const config = loadConfig();
  // Tope duro: ningún evento debe dejar un proceso colgado. Salimos antes que el timeout del hook en settings
  // (150 s; el Stop que espera mensajes tiene 900 s) para no ser cancelados a media escritura.
  setTimeout(() => process.exit(0), hardLimitMs(raw, config)).unref();
  let wrote = false;
  const out = await runHook({
    raw,
    config,
    home: os.homedir(),
    log,
    onOutput: async (line) => {
      wrote = true;
      await writeStdout(line + "\n");
    },
  });
  if (out && !wrote) await writeStdout(out + "\n");
}

// En una terminal pregunta; con datos por tubería (una respuesta por línea) lee todo stdin de una vez.
async function readAnswers(prompts) {
  if (process.stdin.isTTY) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answers = [];
    for (const prompt of prompts) answers.push((await rl.question(prompt)).trim());
    rl.close();
    return answers;
  }
  const lines = (await readStdin(10000)).split(/\r?\n/).map((line) => line.trim());
  return prompts.map((_, i) => lines[i] ?? "");
}

async function setup() {
  const [url, deviceToken] = await readAnswers([
    "URL de Wabid (la muestra la app al conectar la laptop): ",
    "Token del dispositivo: ",
  ]);

  const config = parseConfig(JSON.stringify({ url, token: deviceToken }));
  if (!config) {
    log("la URL (https) o el token no tienen el formato esperado; no se guardó nada");
    process.exitCode = 1;
    return;
  }
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  // 0o600 aplica en Linux/macOS; en Windows no hace nada y la protección son los permisos de %LOCALAPPDATA% (carpeta del usuario).
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`Configuración guardada en ${file}`);
  await selfTest();
}

async function selfTest() {
  const config = loadConfig();
  if (!config) {
    log(`no hay configuración válida en ${configPath()}; ejecuta \`node wabid-hook.mjs setup\``);
    process.exitCode = 1;
    return;
  }
  try {
    const ping = await api(config, fetch, "GET", "/device/ping", undefined, 8000);
    const device = ping.device ?? {};
    console.log(`Conectado como "${device.name}". Aprobaciones desde el celular: ${device.approvals_enabled ? "ACTIVADAS" : "desactivadas"}.`);
    const session_id = `prueba-${Date.now()}`;
    const common = { session_id, project: "Prueba de conexión", cwd: "~" };
    await postEvent(config, fetch, { type: "session_start", ...common, detail: "startup" }, 8000);
    await postEvent(config, fetch, { type: "notification", ...common, detail: "test", message: "Conexión de la laptop verificada" }, 8000);
    await postEvent(config, fetch, { type: "session_end", ...common, detail: "other" }, 8000);
    console.log('Listo: abre Wabid > Claude Code y verás la sesión "Prueba de conexión".');
  } catch (e) {
    log(`la prueba falló: ${e instanceof Error ? e.message : "error"} (revisa la URL, el token y que el dispositivo no esté revocado)`);
    process.exitCode = 1;
  }
}

function help() {
  console.log(`Wabid · hook de Claude Code
  node wabid-hook.mjs setup   guarda la URL y el token de este dispositivo
  node wabid-hook.mjs test    prueba la conexión
Sin argumentos lo ejecuta Claude Code como hook. Instalación: tools/claude-hooks/README.md
Configuración: ${configPath()}`);
}

async function main() {
  switch (process.argv[2]) {
    case "setup":
      return setup();
    case "test":
      return selfTest();
    case "help":
    case "--help":
    case "-h":
      return help();
    default:
      return hookMode();
  }
}

// Solo se ejecuta como programa (no al importarlo desde wabid-runner.mjs ni desde las pruebas).
const RUN_AS_SCRIPT = (() => {
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (process.env.WABID_HOOK_TEST !== "1" && RUN_AS_SCRIPT) {
  // Un hook jamás debe romper la sesión de Claude Code: cualquier error se registra y se sale con 0.
  const isHook = !["setup", "test", "help", "--help", "-h"].includes(process.argv[2] ?? "");
  main()
    .catch((e) => {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      if (!isHook) process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
}
