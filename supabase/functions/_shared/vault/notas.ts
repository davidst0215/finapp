// Notas de proyecto por voz: «anota en novafondos que decidimos cesión de 0,02 % mensual».
// Van AL FINAL de `20-projects/<carpeta>/notas.md`, una línea por nota con la fecha y la hora de Lima:
//   - 2026-10-11 14:30 · decidimos cesión de 0,02 % mensual
// Nunca se escribe en las fichas curadas de `60-wiki/proyectos/*` (las mantiene otro proceso). El archivo se indexa como `nota`
// (classifyPath) y no tiene casillas, así que no aparece como tarea en Norte.
// Puro respecto de Deno: recibe un `RepoFiles` (GitHub real o uno falso en las pruebas). Se prueba en Node (notas.test.ts).
import type { RepoFiles } from "./github.ts";
import { type FileWrite, updateFile, VaultError } from "./ops.ts";
import { isFolderSlug } from "./taxonomy.ts";
import { appendBlock } from "./tasks.ts";

/** Una nota más larga que esto es un dictado desbocado, no una nota: se rechaza (nunca se recorta en silencio). */
export const MAX_NOTA = 500;
export const MENSAJE_NOTA_LARGA = "La nota es muy larga; dímela más corta.";

export const notasPath = (folder: string): string => `20-projects/${folder}/notas.md`;

/** Valor de una clave del frontmatter: tal cual si es una palabra simple; entre comillas si lleva signos que YAML interpretaría. */
const yaml = (s: string): string => {
  const t = s.replace(/[\x00-\x1f"]+/g, " ").replace(/\s+/g, " ").trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(t) ? t : `"${t}"`;
};

/**
 * Encabezado de un `notas.md` NUEVO: frontmatter con `cliente` y `proyecto` (como las fichas, para que el filtro por cliente de
 * vault_search lo encuentre) y el título. Un archivo que ya existe conserva el suyo: nunca se reescribe.
 */
export function notasHeader(label: string, meta: { cliente?: string | null; proyecto?: string | null } = {}): string {
  const fm = ["type: notas"];
  if (meta.cliente?.trim()) fm.push(`cliente: ${yaml(meta.cliente)}`);
  if (meta.proyecto?.trim()) fm.push(`proyecto: ${yaml(meta.proyecto)}`);
  return `---\n${fm.join("\n")}\n---\n# Notas — ${label}`;
}

/**
 * El texto de la nota es dato de David: una sola línea de texto plano. Sin saltos (una línea nueva podría abrir una casilla
 * `- [ ]` o un encabezado), sin caracteres de control y sin espacios de más. Tampoco activa sintaxis de Obsidian: `[[enlace]]`,
 * `![[incrustado]]` y las imágenes `![](url)` pierden su forma, y `%%comentario%%` deja de ocultar texto.
 * NO recorta: quien llama rechaza lo que pase de MAX_NOTA.
 */
export function limpiarNota(s: unknown): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ")
    .replace(/!+(?=\[)/g, "")
    .replace(/\[{2,}/g, "[")
    .replace(/\]{2,}/g, "]")
    .replace(/%{2,}/g, "%")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  const previo = existing !== null && existing.trim() === "" ? null : existing; // un archivo vacío se trata como nuevo
  if (previo !== null) {
    const base = previo.trimEnd();
    if (base.slice(base.lastIndexOf("\n") + 1).replace(/\r$/, "") === linea) return null;
  }
  return appendBlock(previo, [linea], header).text; // mismo trato que Norte y las tareas: salto del archivo, un solo salto final
}

const short = (s: string) => s.slice(0, 60);

/**
 * Lee `notas.md` fresco, agrega la línea y escribe con el sha leído. Si alguien escribió antes (409/422) relee y vuelve a agregar
 * sobre el texto nuevo, hasta MAX_ATTEMPTS: dos notas casi simultáneas quedan las dos. `changed: false` = la línea ya estaba al final.
 */
export async function opAnotar(
  repo: RepoFiles,
  args: { folder: string; label: string; linea: string; cliente?: string | null },
): Promise<{ write: FileWrite; changed: boolean }> {
  if (!isFolderSlug(args.folder)) throw new VaultError("Carpeta inválida", 400);
  const path = notasPath(args.folder);
  const header = notasHeader(args.label, { cliente: args.cliente, proyecto: args.folder }); // solo se usa si el archivo es nuevo
  const r = await updateFile(
    repo,
    path,
    (cur) => anexarNota(cur, args.linea, header),
    `wabid: nota en ${args.folder}: ${short(args.linea.replace(/^- \S+ \S+ · /, ""))}`,
  );
  return { write: { path, text: r.text, sha: r.sha }, changed: r.changed };
}
