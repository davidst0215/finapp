// Frases sobre tareas para el agente. Las arma el código (sin segunda llamada al modelo). `resumenTareas` y
// `resumenGeneral` son lo que se ve en pantalla; las variantes `voz*` dicen solo la primera y "y N más", porque la voz
// se cobra por carácter y no pasa de ~100. Puro.
import { cortoVoz, paraVoz } from "../voz.ts";
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

/** La frase de una lista de tareas. `items` ya viene armado; `mostradas` es cuántas se nombran. */
function plantilla(kind: ListKind, n: number, label: string, items: string, mostradas: number): string {
  return kind === "overdue" ? `Tienes ${n} ${plural(n, "tarea vencida", "tareas vencidas")}: ${items}.`
    : kind === "today" ? `Para hoy tienes ${n} ${plural(n, "tarea", "tareas")}: ${items}.`
    : kind === "inbox" ? `Tienes ${n} en el cajón. ${n > mostradas ? (mostradas === 1 ? "La primera" : "Las primeras") : plural(n, "Es", "Son")}: ${items}.`
    : `En ${label} tienes ${n} ${plural(n, "pendiente", "pendientes")}: ${items}.`;
}

const sinTareas = (kind: ListKind, label: string) =>
  kind === "overdue" ? "No tienes tareas vencidas."
    : kind === "today" ? "No tienes tareas para hoy."
    : kind === "inbox" ? "El cajón está vacío."
    : `No hay pendientes en ${label}.`;

export function resumenTareas(kind: ListKind, tasks: ViewTask[], opts: OpcionesLista = {}): string {
  const n = tasks.length;
  const label = opts.projectLabel ?? "ese proyecto";
  if (n === 0) return sinTareas(kind, label);
  // Se muestran hasta 3 (o las que quepan): lo demás se resume con "y N más".
  const largo = opts.texto ?? 70;
  for (let max = opts.max ?? 3; max >= 1; max--) {
    const items = tasks.slice(0, max)
      .map((t) => (kind === "project" ? corto(t.text, largo) : `${corto(t.text, largo)}, de ${hablado(t)}`))
      .join("; ");
    const out = plantilla(kind, n, label, items, max) + (n > max ? ` Y ${n - max} más.` : "");
    if (out.length <= (opts.presupuesto ?? 340) || max === 1) return out;
  }
  return "";
}

const PRESUPUESTO_VOZ = 96; // por debajo de VOZ_MAX: la frase entera cabe y conserva su «Y N más.»
const MAX_PROYECTO_VOZ = 24;

/**
 * Lo que se dice: cuántas hay y solo la primera, con «Y N más». El resto se ve en pantalla.
 * Todo se mide YA CONVERTIDO a palabras (un monto o un % crece al hablarse: "S/ 1,200" son 8 caracteres y "mil doscientos
 * soles" son 20): el título y el proyecto se convierten y recortan antes, y el título recibe lo que sobra del presupuesto.
 */
export function vozTareas(kind: ListKind, tasks: ViewTask[], opts: Pick<OpcionesLista, "projectLabel"> = {}): string {
  const n = tasks.length;
  const primera = tasks[0];
  if (!primera) return sinTareas(kind, opts.projectLabel ?? "ese proyecto");
  const label = cortoVoz(paraVoz(opts.projectLabel ?? "ese proyecto"), MAX_PROYECTO_VOZ);
  const proyecto = cortoVoz(paraVoz(hablado(primera)), MAX_PROYECTO_VOZ);
  const resto = n > 1 ? ` Y ${n - 1} más.` : "";
  const frase = (titulo: string) => plantilla(kind, n, label, kind === "project" ? titulo : `${titulo}, de ${proyecto}`, 1) + resto;
  const sitio = PRESUPUESTO_VOZ - frase("").length;
  return frase(cortoVoz(paraVoz(primera.text), Math.max(sitio, 10)));
}

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
 * Los dos títulos (ya convertidos a palabras) recortados a `largo`. Si por tener el mismo inicio quedan idénticos
 * ("Preparar la presentación…" de dos proyectos), se muestran desde la palabra anterior a la primera que difiere.
 * Títulos idénticos enteros no tienen palabra que difiera: se devuelven completos (recortados a `largo`) y los distingue
 * el proyecto (ver vozCual).
 */
function titulosDistintos(a: string, b: string, largo: number): [string, string] {
  const ca = corto(a, largo), cb = corto(b, largo);
  if (ca !== cb || a === b) return [ca, cb];
  const wa = a.split(/\s+/), wb = b.split(/\s+/);
  let i = 0;
  while (i < wa.length && i < wb.length && wa[i] === wb[i]) i++;
  const desde = Math.max(0, i - 1);
  return [corto(wa.slice(desde).join(" "), largo), corto(wb.slice(desde).join(" "), largo)];
}

/**
 * Pregunta de aclaración para decir: dos opciones como máximo, en UNA sola pregunta que siempre cierra con «?».
 * Todo se presupuesta YA CONVERTIDO a palabras (un monto en el título crece al hablarse). En el mismo proyecto este se
 * dice una sola vez ("¿Cuál en Acme Ventas: A o B?"); en proyectos distintos cada opción lleva el suyo, con nombres
 * acotados; si los títulos son idénticos los distingue solo el proyecto ("¿La de TDV o la de Maquimas?"), que también es
 * la salida si ni así cupiera.
 */
export function vozCual(tasks: ViewTask[]): string {
  const [a, b] = tasks;
  if (!a || !b) return "¿Cuál de ellas?";
  const de = tasks.length > 2 ? ` de las ${tasks.length}` : "";
  const ta0 = paraVoz(a.text), tb0 = paraVoz(b.text);
  const pa = cortoVoz(paraVoz(hablado(a)), 18), pb = cortoVoz(paraVoz(hablado(b)), 18);
  const mismo = hablado(a) === hablado(b);
  if (ta0 === tb0) return mismo ? `Tienen el mismo título en ${pa}: ¿cuál${de}?` : `¿La de ${pa} o la de ${pb}?`;
  let pregunta = "";
  for (let largo = 34; largo >= 10; largo -= 4) {
    const [ta, tb] = titulosDistintos(ta0, tb0, largo);
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
