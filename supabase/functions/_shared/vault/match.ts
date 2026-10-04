// Encuentra una tarea a partir de lo que dice David ("completa lo de validar la bolsa"). Puro.
// Todas las palabras útiles de la consulta deben aparecer en el texto de la tarea (o, con menos peso, en su
// proyecto). Si dos tareas quedan igual de cerca no se adivina: se devuelven para preguntar.
import { classify, tokenMatch, tokens, type Config } from "./taxonomy.ts";
import type { TaskRow } from "./types.ts";

// Palabras de orden ("completa", "márcala como hecha"…) que no describen la tarea.
const COMMAND_WORDS = new Set([
  "completa", "completar", "completada", "completado", "marca", "marcar", "marcala", "hecha", "hecho", "termina", "terminar",
  "termine", "termino", "terminada", "terminado", "listo", "lista", "cierra", "cerrar", "cierro", "reabre", "reabrir", "reabro",
  "empieza", "empezar", "empece", "arranca", "arrancar", "como", "ya", "que", "lo", "esto", "eso", "esa", "ese", "se", "me", "te",
  "por", "favor", "estado", "pasa", "pasar", "cambia", "cambiar", "curso", "ayuda", "necesito", "falla", "fallida",
]);

export const queryTokens = (q: string): string[] => tokens(q).filter((t) => !COMMAND_WORDS.has(t));

export type TaskMatch = { row: TaskRow; score: number };
export type FindResult =
  | { kind: "one"; match: TaskMatch }
  | { kind: "many"; matches: TaskMatch[] }
  | { kind: "none" };

export const MIN_SCORE = 0.6;
const CLOSE = 0.15;

function scoreRow(q: string[], row: TaskRow, cfg: Config): number {
  const text = tokens(row.text);
  const info = classify(row.folder, cfg);
  const place = [...tokens(info.project), ...(info.frente ? tokens(info.frente) : []), ...tokens(row.folder)];
  let inText = 0;
  let inPlace = 0;
  for (const t of q) {
    if (text.some((x) => tokenMatch(t, x))) inText++;
    else if (place.some((x) => tokenMatch(t, x))) inPlace++;
  }
  if (inText === 0) return 0; // solo coincidir en el proyecto no identifica una tarea
  let s = (inText + 0.6 * inPlace) / q.length;
  if (q.length >= 2 && text.join(" ").includes(q.join(" "))) s += 0.15; // frase seguida
  return Math.min(s, 1.2);
}

/** Mejor coincidencia entre `rows`; prefiere vencer antes y mayor prioridad cuando hay empate. */
export function findTask(query: unknown, rows: TaskRow[], cfg: Config): FindResult {
  const q = queryTokens(typeof query === "string" ? query : "");
  if (!q.length) return { kind: "none" };
  const scored = rows
    .map((row) => ({ row, score: scoreRow(q, row, cfg) }))
    .filter((m) => m.score >= MIN_SCORE)
    .sort((a, b) =>
      b.score - a.score ||
      (a.row.due ?? a.row.scheduled ?? "9999").localeCompare(b.row.due ?? b.row.scheduled ?? "9999") ||
      b.row.priority - a.row.priority ||
      a.row.line - b.row.line
    );
  if (!scored.length) return { kind: "none" };
  const top = scored[0];
  const close = scored.slice(1).filter((m) => m.score >= top.score - CLOSE);
  if (!close.length) return { kind: "one", match: top };
  return { kind: "many", matches: [top, ...close].slice(0, 4) };
}
