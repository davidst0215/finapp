// Convierte el texto de un archivo del vault en las filas del índice (documento + tareas). Puro.
import { buildDoc, folderOfPath, isTaskFile } from "./docs.ts";
import { isIsoDate } from "./fechas.ts";
import { parseTasks, type ParsedTask } from "./tasks.ts";
import type { DocRow, TaskRow } from "./types.ts";

// Una fecha mal escrita en el vault (📅 2026-02-30) no debe tumbar la sincronización completa.
const okDate = (s: string | null): string | null => (s && isIsoDate(s) ? s : null);

export function toTaskRow(path: string, t: ParsedTask): TaskRow {
  return {
    path,
    line: t.line,
    folder: folderOfPath(path),
    raw: t.raw,
    text: t.text,
    status: t.status,
    priority: t.priority,
    due: okDate(t.due),
    scheduled: okDate(t.scheduled),
    done_on: okDate(t.doneOn),
    recurring: t.recurring,
    shared: t.shared,
    shared_with: t.sharedWith,
    suggest: t.suggest,
    source: t.source,
    note: t.note,
    indent: t.indent,
    parent_line: t.parentLine,
  };
}

/** Filas a indexar para un archivo: el documento (si se indexa) y sus tareas (solo en 20-projects). */
export function rowsForFile(path: string, text: string, sha: string): { doc: DocRow | null; tasks: TaskRow[] | null } {
  // Postgres no admite el carácter NUL en texto: un archivo raro no puede romper el lote entero.
  const limpio = text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
  return {
    doc: buildDoc(path, limpio, sha),
    tasks: isTaskFile(path) ? parseTasks(limpio).map((t) => toTaskRow(path, t)) : null,
  };
}
