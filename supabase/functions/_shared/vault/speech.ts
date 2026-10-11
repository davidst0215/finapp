// Frases sobre tareas para el agente. Las arma el código (sin segunda llamada al modelo). `resumenTareas` y
// `resumenGeneral` son lo que se ve en pantalla; las variantes `voz*` dicen solo la primera y "y N más", porque la voz
// se cobra por carácter y no pasa de ~100. Puro.
import { cortoVoz } from "../voz.ts";
import type { FolderInfo } from "./taxonomy.ts";
import type { ViewTask } from "./view.ts";

/** Recorta en el límite de una palabra, sin puntos suspensivos (la voz los lee raro). */
export const corto = (s: string, max = 70): string => cortoVoz(s, max);

/** "Acme › Ventas" → "Acme Ventas": la flecha no se pronuncia. */
export const hablado = (info: Pick<FolderInfo, "project" | "frente">): string =>
  info.frente ? `${info.project} ${info.frente}` : info.project;

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);

export type ListKind = "today" | "overdue" | "project" | "inbox";

type OpcionesLista = {
  projectLabel?: string;
  /** Cuántas tareas nombrar como máximo (se baja solo si la frase pasa de `presupuesto`). */
  max?: number;
  /** Largo máximo de cada tarea nombrada. */
  texto?: number;
  /** Largo máximo de la frase antes de nombrar una tarea menos. */
  presupuesto?: number;
};

export function resumenTareas(kind: ListKind, tasks: ViewTask[], opts: OpcionesLista = {}): string {
  const n = tasks.length;
  const label = opts.projectLabel ?? "ese proyecto";
  if (n === 0) {
    return kind === "overdue" ? "No tienes tareas vencidas."
      : kind === "today" ? "No tienes tareas para hoy."
      : kind === "inbox" ? "El cajón está vacío."
      : `No hay pendientes en ${label}.`;
  }
  // Se muestran hasta 3 (o las que quepan): lo demás se resume con "y N más".
  const largo = opts.texto ?? 70;
  for (let max = opts.max ?? 3; max >= 1; max--) {
    const shown = tasks.slice(0, max);
    const items = shown
      .map((t) => (kind === "project" ? corto(t.text, largo) : `${corto(t.text, largo)}, de ${hablado(t)}`))
      .join("; ");
    const resto = n > max ? ` Y ${n - max} más.` : "";
    const frase = kind === "overdue" ? `Tienes ${n} ${plural(n, "tarea vencida", "tareas vencidas")}: ${items}.`
      : kind === "today" ? `Para hoy tienes ${n} ${plural(n, "tarea", "tareas")}: ${items}.`
      : kind === "inbox" ? `Tienes ${n} en el cajón. ${n > max ? (max === 1 ? "La primera" : "Las primeras") : plural(n, "Es", "Son")}: ${items}.`
      : `En ${label} tienes ${n} ${plural(n, "pendiente", "pendientes")}: ${items}.`;
    const out = frase + resto;
    if (out.length <= (opts.presupuesto ?? 340) || max === 1) return out;
  }
  return "";
}

/** Lo que se dice: cuántas hay y solo la primera, con "y N más". El resto se ve en pantalla. */
export const vozTareas = (kind: ListKind, tasks: ViewTask[], opts: Pick<OpcionesLista, "projectLabel"> = {}): string =>
  resumenTareas(kind, tasks, { ...opts, max: 1, texto: 32 });

export function resumenGeneral(c: { open: number; overdue: number; today: number; inbox: number }, conCajon = true): string {
  const partes = [
    `Tienes ${c.open} ${plural(c.open, "pendiente", "pendientes")}`,
    `${c.overdue} ${plural(c.overdue, "vencida", "vencidas")}`,
    `${c.today} para hoy`,
  ];
  const base = `${partes[0]}, ${partes[1]} y ${partes[2]}.`;
  return conCajon && c.inbox > 0 ? `${base} Y ${c.inbox} ${plural(c.inbox, "espera", "esperan")} en el cajón.` : base;
}

const PRESUPUESTO_CUAL = 96; // por debajo de VOZ_MAX: la pregunta entera cabe y nunca pierde el «?»

/**
 * Los dos títulos recortados a `largo`. Si por tener el mismo inicio quedan idénticos ("Preparar la presentación…" de
 * dos proyectos), se muestran desde la palabra anterior a la primera que difiere.
 */
function titulosDistintos(a: string, b: string, largo: number): [string, string] {
  const ca = corto(a, largo), cb = corto(b, largo);
  if (ca !== cb) return [ca, cb];
  const wa = a.split(/\s+/), wb = b.split(/\s+/);
  let i = 0;
  while (i < wa.length && i < wb.length && wa[i] === wb[i]) i++;
  const desde = Math.max(0, i - 1);
  return [corto(wa.slice(desde).join(" "), largo), corto(wb.slice(desde).join(" "), largo)];
}

/**
 * Pregunta de aclaración para decir: dos opciones como máximo, en UNA sola pregunta que siempre cierra con «?».
 * El largo de cada opción se presupuesta para que quepan las dos: en el mismo proyecto este se dice una sola vez
 * ("¿Cuál en Acme Ventas: A o B?"); en proyectos distintos cada opción lleva el suyo, con nombres acotados; y si ni así
 * cupiera, se distingue solo por proyecto ("¿La de TDV o la de Maquimas?").
 */
export function vozCual(tasks: ViewTask[]): string {
  const [a, b] = tasks;
  if (!a || !b) return "¿Cuál de ellas?";
  const de = tasks.length > 2 ? ` de las ${tasks.length}` : "";
  const pa = corto(hablado(a), 18), pb = corto(hablado(b), 18);
  const mismo = hablado(a) === hablado(b);
  let pregunta = "";
  for (let largo = 34; largo >= 10; largo -= 4) {
    const [ta, tb] = titulosDistintos(a.text, b.text, largo);
    pregunta = mismo ? `¿Cuál${de} en ${pa}: ${ta} o ${tb}?` : `¿Cuál${de}: ${ta}, de ${pa}; o ${tb}, de ${pb}?`;
    if (pregunta.length <= PRESUPUESTO_CUAL) return pregunta;
  }
  return mismo ? pregunta : `¿La de ${pa} o la de ${pb}?`;
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
