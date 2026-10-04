// Frases cortas para leer en voz alta sobre tareas. El agente las devuelve tal cual (sin segunda llamada al
// modelo): son deterministas y caben en los ~400 caracteres que lee el TTS. Puro.
import type { FolderInfo } from "./taxonomy.ts";
import type { ViewTask } from "./view.ts";

/** Recorta en el límite de una palabra, sin puntos suspensivos (la voz los lee raro). */
export function corto(s: string, max = 70): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, "");
}

/** "Acme › Ventas" → "Acme Ventas": la flecha no se pronuncia. */
export const hablado = (info: Pick<FolderInfo, "project" | "frente">): string =>
  info.frente ? `${info.project} ${info.frente}` : info.project;

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);

export type ListKind = "today" | "overdue" | "project" | "inbox";

export function resumenTareas(
  kind: ListKind,
  tasks: ViewTask[],
  opts: { projectLabel?: string; max?: number } = {},
): string {
  const n = tasks.length;
  const label = opts.projectLabel ?? "ese proyecto";
  if (n === 0) {
    return kind === "overdue" ? "No tienes tareas vencidas."
      : kind === "today" ? "No tienes tareas para hoy."
      : kind === "inbox" ? "El cajón está vacío."
      : `No hay pendientes en ${label}.`;
  }
  // Se muestran hasta 3 (o las que quepan): lo demás se resume con "y N más".
  for (let max = opts.max ?? 3; max >= 1; max--) {
    const shown = tasks.slice(0, max);
    const items = shown
      .map((t) => (kind === "project" ? corto(t.text) : `${corto(t.text)}, de ${hablado(t)}`))
      .join("; ");
    const resto = n > max ? ` Y ${n - max} más.` : "";
    const frase = kind === "overdue" ? `Tienes ${n} ${plural(n, "tarea vencida", "tareas vencidas")}: ${items}.`
      : kind === "today" ? `Para hoy tienes ${n} ${plural(n, "tarea", "tareas")}: ${items}.`
      : kind === "inbox" ? `Tienes ${n} en el cajón. ${n > max ? "Las primeras" : plural(n, "Es", "Son")}: ${items}.`
      : `En ${label} tienes ${n} ${plural(n, "pendiente", "pendientes")}: ${items}.`;
    const out = frase + resto;
    if (out.length <= 340 || max === 1) return out;
  }
  return "";
}

export function resumenGeneral(c: { open: number; overdue: number; today: number; inbox: number }): string {
  const partes = [
    `Tienes ${c.open} ${plural(c.open, "pendiente", "pendientes")}`,
    `${c.overdue} ${plural(c.overdue, "vencida", "vencidas")}`,
    `${c.today} para hoy`,
  ];
  const base = `${partes[0]}, ${partes[1]} y ${partes[2]}.`;
  return c.inbox > 0 ? `${base} Y ${c.inbox} ${plural(c.inbox, "espera", "esperan")} en el cajón.` : base;
}

export function preguntaCual(tasks: ViewTask[]): string {
  const items = tasks.slice(0, 3).map((t) => `${corto(t.text, 55)}, de ${hablado(t)}`).join("; o ");
  return `Encontré ${tasks.length} parecidas: ${items}. ¿Cuál?`;
}

export function preguntaDonde(options: FolderInfo[]): string {
  const nombres = options.slice(0, 5).map((o) => o.frente ?? o.project);
  const proyecto = options[0]?.project ?? "";
  const mismoProyecto = options.every((o) => o.project === proyecto);
  const lista = nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} o ${nombres[nombres.length - 1]}` : (nombres[0] ?? "");
  return mismoProyecto ? `¿En qué frente de ${proyecto}: ${lista}?` : `¿En cuál: ${options.slice(0, 5).map(hablado).join(", ")}?`;
}
