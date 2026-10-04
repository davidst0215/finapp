// Parser y escritor de tareas del vault (sintaxis del plugin Obsidian Tasks).
// Replica el contrato de Norte (pendientes-app/server.js) para que Wabid y Norte se vean entre sí:
//   estados  [ ] pendiente · [/] en curso · [x] hecha (✅ AAAA-MM-DD) · [?] necesita ayuda · [-] fallida
//   metadata 📅 vence · ⏳ programada · 🔁 recurrencia · ⛔ depende de · 🆔 id · ⏫🔼🔽 prioridad
//   tags     #conjunto/<quien> · #fathom · #destino/<carpeta>
//   detalle  bullet indentado pegado a la tarea · subtareas = checkbox con más indentación
// Puro (sin globals de Deno): se prueba en Node con `node --experimental-strip-types --test`.
import { isIsoDate } from "./fechas.ts";

export type TaskStatus = "pending" | "in-progress" | "completed" | "need-help" | "failed";
export type Level = "alto" | "medio" | "bajo";
export type Priority = 0 | 1 | 2 | 3;

// --- Contrato de Norte (copiado de server.js; no cambiar sin cambiar Norte) -------------------
export const RE_TASK = /^(\s*)- \[([ xX/?\-])\]\s+(.*)$/;
export const RE_SHARED = /#conjunto(?:\/([^\s#]+))?/u;
export const RE_SHARED_G = /\s*#conjunto(?:\/[^\s#]+)?/gu;
export const RE_SUGGEST = /#destino\/([\w-]+)/u;
export const RE_SUGGEST_G = /\s*#destino\/[\w-]+/gu;
export const RE_SOURCE_G = /\s*#fathom\b/gu;
// Bullet indentado que NO es checkbox = detalle de la tarea de arriba.
export const RE_NOTE = /^\s+- (?!\[[ xX/?\-]\][ \t])(.+)$/;

const STATUS_CHAR: Record<string, TaskStatus> = {
  " ": "pending", "/": "in-progress", x: "completed", X: "completed", "?": "need-help", "-": "failed",
};
const CHAR_FOR_STATUS: Record<TaskStatus, string> = {
  pending: " ", "in-progress": "/", completed: "x", "need-help": "?", failed: "-",
};
export const STATUSES = Object.keys(CHAR_FOR_STATUS) as TaskStatus[];
export const isStatus = (v: unknown): v is TaskStatus => typeof v === "string" && v in CHAR_FOR_STATUS;

const LEVEL_TO_EMOJI: Record<Level, string> = { alto: "⏫", medio: "🔼", bajo: "🔽" };
const LEVEL_NUM: Record<Level | "", Priority> = { alto: 3, medio: 2, bajo: 1, "": 0 };
export const isLevel = (v: unknown): v is Level => v === "alto" || v === "medio" || v === "bajo";

// Los emojis de metadata en el texto romperían el parseo de la línea. Flag `u` obligatorio:
// sin él 🔺 y 📅 comparten surrogate y la regex los parte.
const RE_TASK_EMOJI = /[🔺⏫🔼🔽⏬📅⏳🛫✅➕🛬🔁⛔🆔]/gu;

function emojiToLevel(text: string): Level | "" {
  if (/[🔺⏫]/u.test(text)) return "alto";
  if (/🔼/u.test(text)) return "medio";
  if (/[🔽⏬]/u.test(text)) return "bajo";
  return "";
}

export type TaskMeta = {
  text: string;
  level: Level | "";
  priority: Priority;
  due: string | null;
  scheduled: string | null;
  doneOn: string | null;
  recurring: string | null;
  dependencies: string[];
  taskId: string | null;
  shared: boolean;
  sharedWith: string | null;
  suggest: string | null;
  source: "fathom" | null;
};

export function parseMeta(body: string): TaskMeta {
  const level = emojiToLevel(body);
  const grab = (emoji: string): string | null => (body.match(new RegExp(emoji + "\\s*(\\d{4}-\\d{2}-\\d{2})")) || [])[1] || null;
  const recurring = /🔁\s*([^📅⏳🛫✅🔺⏫🔼🔽⏬]+)/u.exec(body);
  const blocked = (body.match(/⛔\s*([^\s]+)/u) || [])[1];
  const taskId = (body.match(/🆔\s*([^\s]+)/u) || [])[1];
  const sh = RE_SHARED.exec(body);
  const sg = RE_SUGGEST.exec(body);
  const text = body
    .replace(/[🔺⏫🔼🔽⏬]/gu, "")
    .replace(/(📅|⏳|🛫|✅|➕|🛬)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/🔁\s*[^📅⏳🛫✅🔺⏫🔼🔽⏬]+/gu, "")
    .replace(/[⛔🆔]\s*[^\s]+/gu, "")
    .replace(RE_SHARED_G, "")
    .replace(RE_SUGGEST_G, "")
    .replace(RE_SOURCE_G, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return {
    text,
    level,
    priority: LEVEL_NUM[level],
    due: grab("📅"),
    scheduled: grab("⏳"),
    doneOn: grab("✅"),
    recurring: recurring ? recurring[1].trim() : null,
    dependencies: blocked ? blocked.split(",") : [],
    taskId: taskId || null,
    shared: !!sh,
    sharedWith: sh && sh[1] ? sh[1] : null,
    suggest: sg ? sg[1] : null,
    source: /#fathom\b/u.test(body) ? "fathom" : null,
  };
}

export type ParsedTask = TaskMeta & {
  /** Índice de la línea (base 0) dentro del archivo. */
  line: number;
  indent: number;
  /** Línea de la tarea de primer nivel a la que pertenece (subtareas); null si es de primer nivel. */
  parentLine: number | null;
  status: TaskStatus;
  /** Línea completa, sin salto de línea. */
  raw: string;
  /** Detalle: bullets indentados contiguos, unidos con espacio. */
  note: string | null;
};

// --- Documento como líneas + saltos: reescribir no toca los saltos de las líneas que no cambian -----
export type Doc = { lines: string[]; eols: string[] };

/** `eols[i]` es el salto que sigue a `lines[i]` ("" en la última línea si el archivo no termina en salto). */
export function splitDoc(text: string): Doc {
  const parts = text.split(/(\r\n|\n)/);
  const lines: string[] = [];
  const eols: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]);
    eols.push(parts[i + 1] ?? "");
  }
  return { lines, eols };
}

export function joinDoc(doc: Doc): string {
  let out = "";
  for (let i = 0; i < doc.lines.length; i++) out += doc.lines[i] + doc.eols[i];
  return out;
}

/** Salto que se usa al agregar líneas: CRLF si el archivo tiene alguno (igual que Norte), si no LF. */
export const detectEol = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

function removeLines(doc: Doc, start: number, end: number): Doc {
  const lines = doc.lines.slice(0, start).concat(doc.lines.slice(end));
  const eols = doc.eols.slice(0, start).concat(doc.eols.slice(end));
  // Si se quitó el final del archivo, el nuevo final hereda "sin salto" solo si el original tampoco lo tenía.
  if (end >= doc.lines.length && doc.eols[doc.eols.length - 1] === "" && eols.length > 0) eols[eols.length - 1] = "";
  return { lines, eols };
}

// --- Lectura ---------------------------------------------------------------------------------
function makeTask(m: RegExpExecArray, line: number, raw: string): ParsedTask {
  return {
    ...parseMeta(m[3]),
    line,
    indent: m[1].length,
    parentLine: null,
    status: STATUS_CHAR[m[2]] || "pending",
    raw,
    note: null,
  };
}

/** Todas las tareas de un archivo, en orden. Ignora los bloques de código y reproduce las reglas de Norte. */
export function parseTasks(text: string): ParsedTask[] {
  const { lines } = splitDoc(text);
  const out: ParsedTask[] = [];
  let parent: ParsedTask | null = null;
  let noteTarget: ParsedTask | null = null; // solo las líneas CONTIGUAS bajo una tarea cuentan como detalle
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      noteTarget = null;
      continue;
    }
    if (inFence) continue;
    const m = RE_TASK.exec(line);
    if (!m) {
      const n = RE_NOTE.exec(line);
      if (n && noteTarget) {
        noteTarget.note = (noteTarget.note ? noteTarget.note + " " : "") + n[1].trim();
        continue;
      }
      noteTarget = null;
      continue;
    }
    const task = makeTask(m, i, line);
    if (task.indent > 0 && parent) {
      task.parentLine = parent.line; // checkbox indentado = subtarea del último de primer nivel
    } else {
      parent = task;
    }
    out.push(task);
    noteTarget = task;
  }
  return out;
}

// --- Ubicar una tarea en un texto que pudo cambiar desde que se indexó -------------------------
export class TaskNotFoundError extends Error {
  constructor(message = "La tarea cambió o ya no existe. Sincroniza e inténtalo de nuevo.") {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

export type TaskRef = { line: number; raw: string };

/**
 * Índice actual de la tarea. Se confía en `raw`, no en el número de línea: si otra edición desplazó
 * líneas, se busca la misma línea exacta (la más cercana si se repite). null si ya no existe.
 */
export function locateTask(lines: string[], ref: TaskRef): number | null {
  if (ref.line >= 0 && ref.line < lines.length && lines[ref.line] === ref.raw) return ref.line;
  let best: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === ref.raw && (best === null || Math.abs(i - ref.line) < Math.abs(best - ref.line))) best = i;
  }
  return best;
}

/** Fin (exclusivo) de la tarea con su detalle y sus subtareas: todo lo más indentado que ella. */
export function taskBlockEnd(lines: string[], lineNo: number): number {
  const m = RE_TASK.exec(lines[lineNo] || "");
  if (!m) throw new TaskNotFoundError("La línea no es una tarea");
  const base = m[1].length;
  let end = lineNo + 1;
  while (end < lines.length) {
    const l = lines[end];
    const sub = RE_TASK.exec(l);
    if (sub ? sub[1].length > base : RE_NOTE.test(l) && l.search(/\S/) > base) end++;
    else break;
  }
  return end;
}

// --- Escritura -------------------------------------------------------------------------------
/** Cambia el estado de una línea. Estampa ✅ al completar y la quita (todas las copias) al reabrir. */
export function setStatusLine(line: string, status: TaskStatus, today: string): string {
  if (!RE_TASK.test(line)) return line;
  let next = line.replace(/^(\s*- )\[[ xX/?\-]\]/, `$1[${CHAR_FOR_STATUS[status]}]`);
  if (status === "completed") {
    if (!/✅/u.test(next)) next = next.trimEnd() + ` ✅ ${today}`;
  } else {
    next = next.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/gu, "");
  }
  return next;
}

export type StatusResult = { text: string; line: number; raw: string; changed: boolean };

export function applyStatus(text: string, ref: TaskRef, status: TaskStatus, today: string): StatusResult {
  const doc = splitDoc(text);
  const idx = locateTask(doc.lines, ref);
  if (idx === null) throw new TaskNotFoundError();
  if (!RE_TASK.test(doc.lines[idx])) throw new TaskNotFoundError("La línea no es una tarea");
  const next = setStatusLine(doc.lines[idx], status, today);
  if (next === doc.lines[idx]) return { text, line: idx, raw: next, changed: false };
  doc.lines[idx] = next;
  return { text: joinDoc(doc), line: idx, raw: next, changed: true };
}

/** Texto seguro para una línea de Tasks: sin saltos, sin emojis de metadata, sin # que abra un tag, sin checkbox al inicio. */
export function cleanText(s: unknown, max = 300): string {
  return String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(RE_TASK_EMOJI, "")
    .replace(/(^|\s)#+(?=[\w/-])/g, "$1") // solo el # que abre un tag; "PR #42" → "PR 42", "C#" se queda
    .replace(/^\s*(?:[-*]\s+)?(?:\[[ xX/?\-]\]\s*)?/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max)
    .replace(/[.\s]+$/, ""); // un pendiente no lleva punto final
}

/** Persona → etiqueta de tag: "Juan Pablo" → "juan-pablo". */
export function slugPerson(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim()
    .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 30);
}

export type NewTask = {
  text: string;
  level?: Level | "" | null;
  /** AAAA-MM-DD */
  due?: string | null;
  /** true → #conjunto; "Daniel" → #conjunto/daniel */
  shared?: boolean | string | null;
  note?: string | null;
};

/** Líneas de una tarea nueva, en el mismo orden que escribe Norte: texto, #conjunto, prioridad, 📅. */
export function buildTaskBlock(input: NewTask): string[] {
  const text = cleanText(input.text);
  if (!text) throw new Error("La tarea no tiene texto");
  let line = `- [ ] ${text}`;
  if (input.shared) {
    const who = typeof input.shared === "string" ? slugPerson(input.shared) : "";
    line += who ? ` #conjunto/${who}` : " #conjunto";
  }
  if (input.level) {
    if (!isLevel(input.level)) throw new Error(`Prioridad inválida: ${input.level}`);
    line += ` ${LEVEL_TO_EMOJI[input.level]}`;
  }
  if (input.due) {
    if (!isIsoDate(input.due)) throw new Error(`Fecha inválida: ${input.due}`);
    line += ` 📅 ${input.due}`;
  }
  const block = [line];
  const note = cleanText(input.note, 500);
  if (note) block.push(`    - ${note}`);
  return block;
}

/**
 * Agrega un bloque al final de un pendientes.md (`existing` null = el archivo no existe y se crea con
 * encabezado). Igual que Norte: quita el espacio final, respeta el salto del archivo y deja un solo salto final.
 * `firstLine` es el índice (base 0) de la primera línea del bloque en el texto resultante.
 */
export function appendBlock(existing: string | null, blockLines: string[], header: string): { text: string; firstLine: number } {
  if (existing === null) return { text: `${header}\n\n${blockLines.join("\n")}\n`, firstLine: 2 };
  const eol = detectEol(existing);
  const base = existing.trimEnd();
  if (base === "") return { text: blockLines.join(eol) + eol, firstLine: 0 };
  return { text: base + eol + blockLines.join(eol) + eol, firstLine: (base.match(/\n/g) ?? []).length + 1 };
}

export const pendientesHeader = (label: string) => `# Pendientes — ${label}`;

/**
 * Bloque listo para mudar a otra carpeta: la tarea + su detalle + sus subtareas, des-indentado a primer
 * nivel y sin el `#destino/…` (ya cumplió su función). No modifica el texto.
 */
export function takeBlock(text: string, ref: TaskRef): { block: string[]; line: number } {
  const { lines } = splitDoc(text);
  const idx = locateTask(lines, ref);
  if (idx === null) throw new TaskNotFoundError();
  const m = RE_TASK.exec(lines[idx]);
  if (!m) throw new TaskNotFoundError("La línea no es una tarea");
  const base = m[1].length;
  const end = taskBlockEnd(lines, idx);
  const block = lines.slice(idx, end).map((l) => l.slice(base));
  block[0] = block[0].replace(RE_SUGGEST_G, "");
  return { block, line: idx };
}

/** Quita la tarea con su detalle y subtareas. Si ya no está, no hace nada (`removed: false`). */
export function dropBlock(text: string, ref: TaskRef): { text: string; removed: boolean } {
  const doc = splitDoc(text);
  const idx = locateTask(doc.lines, ref);
  if (idx === null) return { text, removed: false };
  const end = taskBlockEnd(doc.lines, idx);
  return { text: joinDoc(removeLines(doc, idx, end)), removed: true };
}
