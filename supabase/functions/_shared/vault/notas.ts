// Notas de proyecto por voz: «anota en novafondos que decidimos cesión de 0,02 % mensual».
// Van AL FINAL de `20-projects/<carpeta>/notas.md`, una línea por nota con la fecha y la hora de Lima:
//   - 2026-10-11 14:30 · decidimos cesión de 0,02 % mensual
// Nunca se escribe en las fichas curadas de `60-wiki/proyectos/*` (las mantiene otro proceso). El archivo se indexa como `nota`
// (classifyPath) y no tiene casillas, así que no aparece como tarea en Norte.
// Puro respecto de Deno: recibe un `RepoFiles` (GitHub real o uno falso en las pruebas). Se prueba en Node (notas.test.ts).
import type { RepoFiles } from "./github.ts";
import { type FileWrite, updateFile, VaultError } from "./ops.ts";
import { isFolderSlug } from "./taxonomy.ts";
import { detectEol } from "./tasks.ts";

/** Una nota más larga que esto es un dictado desbocado, no una nota. */
export const MAX_NOTA = 500;

export const notasPath = (folder: string): string => `20-projects/${folder}/notas.md`;
export const notasHeader = (label: string): string => `# Notas — ${label}`;

/**
 * El texto de la nota es dato de David: una sola línea de texto plano. Sin saltos (una línea nueva podría abrir una casilla
 * `- [ ]` o un encabezado), sin caracteres de control y sin espacios de más.
 */
export function limpiarNota(s: unknown, max = MAX_NOTA): string {
  const t = String(s ?? "")
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
  return t.replace(/[\uD800-\uDBFF]$/, "").trimEnd(); // el corte no deja medio emoji
}

/** `2026-10-11` + 870 minutos desde la medianoche de Lima → «- 2026-10-11 14:30 · texto». */
export function lineaNota(texto: string, hoy: string, minutos: number): string {
  const m = Math.min(Math.max(Math.floor(minutos), 0), 1439);
  const hora = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `- ${hoy} ${hora} · ${texto}`;
}

/**
 * Texto nuevo del archivo con `linea` al final, o null si no hay nada que escribir (la misma línea ya es la última: un reintento del
 * cliente no la duplica). Respeta lo que ya hay: solo quita el espacio sobrante del final, conserva el salto de línea del archivo
 * (CRLF si lo usa) y deja uno solo al terminar. Archivo inexistente o vacío → se crea con su encabezado.
 */
export function anexarNota(existing: string | null, linea: string, header: string): string | null {
  if (existing === null || existing.trim() === "") return `${header}\n\n${linea}\n`;
  const eol = detectEol(existing);
  const base = existing.trimEnd();
  const ultima = base.slice(base.lastIndexOf("\n") + 1).replace(/\r$/, "");
  if (ultima === linea) return null;
  return base + eol + linea + eol;
}

const short = (s: string) => s.slice(0, 60);

/**
 * Lee `notas.md` fresco, agrega la línea y escribe con el sha leído. Si alguien escribió antes (409/422) relee y vuelve a agregar
 * sobre el texto nuevo, hasta MAX_ATTEMPTS: dos notas casi simultáneas quedan las dos. `changed: false` = la línea ya estaba al final.
 */
export async function opAnotar(
  repo: RepoFiles,
  args: { folder: string; label: string; linea: string },
): Promise<{ write: FileWrite; changed: boolean }> {
  if (!isFolderSlug(args.folder)) throw new VaultError("Carpeta inválida", 400);
  const path = notasPath(args.folder);
  const r = await updateFile(
    repo,
    path,
    (cur) => anexarNota(cur, args.linea, notasHeader(args.label)),
    `wabid: nota en ${args.folder}: ${short(args.linea.replace(/^- \S+ \S+ · /, ""))}`,
  );
  return { write: { path, text: r.text, sha: r.sha }, changed: r.changed };
}
