// Da forma a las filas del índice para la UI y el agente: agrupa por Proyecto › Frente, ordena como Norte
// y calcula las etiquetas de fecha en hora de Lima. Puro: recibe `hoy`, nunca lee el reloj.
import { etiquetaFecha } from "./fechas.ts";
import { classify, INBOX_FOLDER, listDestinations, type Config, type FolderInfo, type Scope } from "./taxonomy.ts";
import type { TaskRow } from "./types.ts";
import type { TaskStatus } from "./tasks.ts";

/** Tarea abierta = todavía hay algo que hacer. Hecha y fallida salen de la lista. */
export const OPEN_STATUSES: TaskStatus[] = ["pending", "in-progress", "need-help"];
export const isOpen = (s: string): boolean => (OPEN_STATUSES as string[]).includes(s);

export type ViewTask = {
  id: string;
  path: string;
  line: number;
  raw: string;
  folder: string;
  scope: Scope;
  project: string;
  frente: string | null;
  label: string;
  text: string;
  status: TaskStatus;
  priority: 0 | 1 | 2 | 3;
  due: string | null;
  dueLabel: string | null;
  overdue: boolean;
  note: string | null;
  link: string | null;
  shared: boolean;
  sharedWith: string | null;
  suggest: string | null;
  suggestLabel: string | null;
  source: "fathom" | null;
  subtasks: { done: number; total: number } | null;
};

export type ViewGroup = {
  key: string;
  folder: string;
  scope: "trabajo" | "personal";
  project: string;
  frente: string | null;
  label: string;
  tasks: ViewTask[];
};

export type TasksView = {
  hoy: string;
  groups: ViewGroup[];
  inbox: ViewTask[];
  counts: { open: number; overdue: number; today: number; inbox: number };
  destinations: FolderInfo[];
  syncedAt: string | null;
};

/** "juan-pablo" → "Juan Pablo" (igual que cap() de Norte). */
export const capitalize = (s: string): string => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Detalle en texto plano: los links markdown [texto](https://…) quedan solo con su texto. */
export const plainNote = (note: string | null): string | null => {
  if (!note) return null;
  const t = note.replace(/\[([^\]]*)\]\(https?:\/\/[^)\s]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return t || null;
};

/** Primer link https del detalle (la grabación de Fathom, por ejemplo). */
export const firstLink = (note: string | null): string | null => {
  const m = note ? /\((https:\/\/[^\s)]+)\)/.exec(note) ?? /(https:\/\/[^\s)]+)/.exec(note) : null;
  return m ? m[1] : null;
};

export function toViewTask(
  row: TaskRow,
  cfg: Config,
  hoy: string,
  subtasks: { done: number; total: number } | null = null,
): ViewTask {
  const info = classify(row.folder, cfg);
  const open = isOpen(row.status);
  const ref = row.due ?? row.scheduled;
  const fecha = ref ? etiquetaFecha(ref, hoy, open) : null;
  const sug = row.suggest ? classify(row.suggest, cfg) : null;
  return {
    id: `${row.path}::${row.line}`,
    path: row.path,
    line: row.line,
    raw: row.raw,
    folder: row.folder,
    scope: info.scope,
    project: info.project,
    frente: info.frente,
    label: info.label,
    text: row.text,
    status: row.status,
    priority: (row.priority >= 0 && row.priority <= 3 ? row.priority : 0) as 0 | 1 | 2 | 3,
    due: ref,
    dueLabel: fecha ? fecha.label : null,
    overdue: fecha ? fecha.overdue : false,
    note: plainNote(row.note),
    link: firstLink(row.note),
    shared: row.shared,
    sharedWith: row.shared_with ? capitalize(row.shared_with) : null,
    suggest: row.suggest,
    suggestLabel: sug && sug.scope !== "cajon" ? sug.label : null,
    source: row.source === "fathom" ? "fathom" : null,
    subtasks,
  };
}

/** Prioridad alta primero, luego la fecha más próxima (sin fecha al final), luego el orden del archivo. */
export const byPriorityThenDue = (a: ViewTask, b: ViewTask): number =>
  b.priority - a.priority || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.line - b.line;

export function buildTasksView(rows: TaskRow[], cfg: Config, knownFolders: string[], hoy: string, syncedAt: string | null): TasksView {
  // Subtareas: solo cuentan para el avance de su tarea de primer nivel.
  const subs = new Map<string, { done: number; total: number }>();
  for (const r of rows) {
    if (r.parent_line === null) continue;
    const key = `${r.path}::${r.parent_line}`;
    const s = subs.get(key) ?? { done: 0, total: 0 };
    s.total++;
    if (r.status === "completed") s.done++;
    subs.set(key, s);
  }

  const open = rows
    .filter((r) => r.parent_line === null && isOpen(r.status))
    .map((r) => toViewTask(r, cfg, hoy, subs.get(`${r.path}::${r.line}`) ?? null));

  const inbox = open.filter((t) => t.folder === INBOX_FOLDER).sort(byPriorityThenDue);
  const work = open.filter((t) => t.folder !== INBOX_FOLDER);

  const byFolder = new Map<string, ViewTask[]>();
  for (const t of work) byFolder.set(t.folder, [...(byFolder.get(t.folder) ?? []), t]);

  // Orden de grupos: proyectos de trabajo como en la configuración, después personales por nombre
  // (listDestinations ya devuelve las carpetas en ese orden).
  const all = listDestinations(cfg, knownFolders);
  const dest = all.filter((d) => d.scope !== "cajon");
  const groups: ViewGroup[] = [];
  const seen = new Set<string>();
  const push = (info: FolderInfo) => {
    const tasks = byFolder.get(info.folder);
    if (!tasks || seen.has(info.folder)) return;
    seen.add(info.folder);
    groups.push({
      key: info.folder,
      folder: info.folder,
      scope: info.scope === "trabajo" ? "trabajo" : "personal",
      project: info.project,
      frente: info.frente,
      label: info.label,
      tasks: tasks.sort(byPriorityThenDue),
    });
  };
  dest.filter((d) => d.scope === "trabajo").forEach(push);
  dest.filter((d) => d.scope === "personal").forEach(push);
  // Carpetas con tareas pero fuera de `destinations` (no debería pasar): al final, como personales.
  for (const folder of byFolder.keys()) if (!seen.has(folder)) push(classify(folder, cfg));

  const inList = groups.flatMap((g) => g.tasks);
  return {
    hoy,
    groups,
    inbox,
    counts: {
      open: inList.length,
      overdue: inList.filter((t) => t.overdue).length,
      today: inList.filter((t) => t.due === hoy).length,
      inbox: inbox.length,
    },
    destinations: all,
    syncedAt,
  };
}
