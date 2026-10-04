// Operaciones de escritura sobre el vault vía GitHub: crear, cambiar de estado y mover tareas.
// Cada una lee el archivo fresco, aplica el cambio (tasks.ts) y escribe con el sha leído. Si alguien se
// adelantó (409/422) relee y REAPLICA la operación sobre el texto nuevo, máximo 3 intentos.
// Puro respecto de Deno: recibe un `RepoFiles` (GitHub real o uno falso en las pruebas).
import { GitHubConflict, type RepoFiles } from "./github.ts";
import { folderOfPath, isTaskFile } from "./docs.ts";
import { isFolderSlug } from "./taxonomy.ts";
import {
  appendBlock, applyStatus, buildTaskBlock, dropBlock, parseMeta, pendientesHeader, takeBlock, TaskNotFoundError,
  type NewTask, type StatusResult, type TaskRef, type TaskStatus,
} from "./tasks.ts";

export const MAX_ATTEMPTS = 3;

/** Error de uso (entrada inválida, configuración faltante…) con el código HTTP que corresponde. */
export class VaultError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "VaultError";
    this.status = status;
  }
}

/** La tarea ya se copió al destino pero no se pudo quitar del origen: queda duplicada, nunca perdida. */
export class PartialMoveError extends Error {
  dest: FileWrite;
  constructor(dest: FileWrite, cause: unknown) {
    super(`La tarea se copió al destino pero no se pudo quitar del origen: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PartialMoveError";
    this.dest = dest;
  }
}

export type FileWrite = { path: string; text: string; sha: string };

/** Solo se escriben .md de 20-projects (el espacio de tareas); nada de rutas raras que mande el cliente. */
export function assertTaskPath(path: unknown): string {
  if (
    typeof path !== "string" || path.length > 300 || !isTaskFile(path) ||
    path.includes("\\") || /[\u0000-\u001f]/.test(path) || path.split("/").some((p) => p === ".." || p === "" || p === ".")
  ) {
    throw new VaultError("Ruta de tarea inválida", 400);
  }
  return path;
}

export const pendientesPath = (folder: string): string => `20-projects/${folder}/pendientes.md`;

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);
const titleOfRaw = (raw: string) => short(parseMeta(raw.replace(/^\s*- \[.\]\s+/, "")).text);
const commit = (action: string, title: string) => `wabid: ${action}${title ? `: ${title}` : ""}`;

/**
 * Lee → transforma → escribe con el sha leído. `mutate` recibe el texto actual (null si el archivo no existe)
 * y devuelve el nuevo, o null para no cambiar nada. Ante conflicto relee y vuelve a llamar a `mutate`.
 */
export async function updateFile(
  repo: RepoFiles,
  path: string,
  mutate: (current: string | null) => string | null,
  message: string,
  attempts = MAX_ATTEMPTS,
): Promise<{ changed: boolean; text: string; sha: string }> {
  for (let attempt = 1; ; attempt++) {
    const cur = await repo.getFile(path);
    const next = mutate(cur ? cur.text : null);
    if (next === null || (cur && next === cur.text)) return { changed: false, text: cur?.text ?? "", sha: cur?.sha ?? "" };
    try {
      const put = await repo.putFile(path, next, cur ? cur.sha : null, message);
      return { changed: true, text: next, sha: put.sha };
    } catch (e) {
      if (e instanceof GitHubConflict && attempt < attempts) continue;
      throw e;
    }
  }
}

// --- Crear -----------------------------------------------------------------------------------------
export async function opCreateTask(
  repo: RepoFiles,
  args: { folder: string; label: string; task: NewTask },
): Promise<{ write: FileWrite; line: number }> {
  if (!isFolderSlug(args.folder)) throw new VaultError("Carpeta inválida", 400);
  let block: string[];
  try {
    block = buildTaskBlock(args.task);
  } catch (e) {
    throw new VaultError(e instanceof Error ? e.message : "Tarea inválida", 400);
  }
  const path = pendientesPath(args.folder);
  const st: { line: number } = { line: 0 };
  const r = await updateFile(repo, path, (cur) => {
    const a = appendBlock(cur, block, pendientesHeader(args.label));
    st.line = a.firstLine;
    return a.text;
  }, commit(`nueva tarea en ${args.folder}`, titleOfRaw(block[0])));
  return { write: { path, text: r.text, sha: r.sha }, line: st.line };
}

// --- Cambiar de estado -----------------------------------------------------------------------------
export async function opSetStatus(
  repo: RepoFiles,
  args: { path: string; ref: TaskRef; status: TaskStatus; today: string },
): Promise<{ write: FileWrite; line: number; raw: string; changed: boolean }> {
  const path = assertTaskPath(args.path);
  const st: { r?: StatusResult } = {};
  const verbo = args.status === "completed" ? "completar tarea" : args.status === "pending" ? "reabrir tarea" : `tarea a ${args.status}`;
  const r = await updateFile(repo, path, (cur) => {
    if (cur === null) throw new TaskNotFoundError();
    st.r = applyStatus(cur, args.ref, args.status, args.today);
    return st.r.changed ? st.r.text : null;
  }, commit(verbo, titleOfRaw(args.ref.raw)));
  if (!st.r) throw new TaskNotFoundError();
  // Si no hubo cambio, `text`/`sha` son los vigentes en GitHub: el llamador reindexa con ellos.
  return { write: { path, text: r.text, sha: r.sha }, line: st.r.line, raw: st.r.raw, changed: r.changed };
}

// --- Mover -----------------------------------------------------------------------------------------
/**
 * Mueve la tarea con su detalle y subtareas a `20-projects/<carpeta>/pendientes.md`.
 * Escribe PRIMERO en el destino y después quita del origen (como Norte): si algo falla a la mitad
 * queda duplicada, nunca perdida.
 */
export async function opMoveTask(
  repo: RepoFiles,
  args: { path: string; ref: TaskRef; toFolder: string; toLabel: string },
): Promise<{ source: FileWrite; dest: FileWrite; destLine: number }> {
  const path = assertTaskPath(args.path);
  if (!isFolderSlug(args.toFolder)) throw new VaultError("Carpeta de destino inválida", 400);
  if (folderOfPath(path) === args.toFolder) throw new VaultError("Ya está en esa carpeta", 400);

  const src = await repo.getFile(path);
  if (!src) throw new TaskNotFoundError();
  const { block } = takeBlock(src.text, args.ref);
  const title = titleOfRaw(args.ref.raw);

  const destPath = pendientesPath(args.toFolder);
  const st: { line: number } = { line: 0 };
  const dest = await updateFile(repo, destPath, (cur) => {
    const a = appendBlock(cur, block, pendientesHeader(args.toLabel));
    st.line = a.firstLine;
    return a.text;
  }, commit(`mover tarea a ${args.toFolder}`, title));
  const destWrite: FileWrite = { path: destPath, text: dest.text, sha: dest.sha };

  try {
    const source = await updateFile(repo, path, (cur) => {
      if (cur === null) return null;
      // Releer y comparar: si el bloque cambió desde que se copió (alguien agregó una subtarea o detalle),
      // quitarlo borraría líneas que no se copiaron. Mejor dejarla duplicada.
      let ahora: string[];
      try {
        ahora = takeBlock(cur, args.ref).block;
      } catch (e) {
        if (e instanceof TaskNotFoundError) {
          // Sin la línea exacta: o la quitaron (listo), o la editaron (p. ej. cambió de estado). Si su texto
          // sigue en el archivo, fue editada: se avisa en vez de dejar la copia duplicada en silencio.
          const titulo = parseMeta(args.ref.raw.replace(/^\s*- \[.\]\s+/, "")).text;
          if (titulo && cur.includes(titulo)) throw new Error("la tarea cambió en el origen mientras se movía");
          return null; // ya no está en el origen
        }
        throw e;
      }
      if (ahora.length !== block.length || ahora.some((l, i) => l !== block[i])) {
        throw new Error("la tarea cambió en el origen mientras se movía");
      }
      const d = dropBlock(cur, args.ref);
      return d.removed ? d.text : null;
    }, commit(`sacar tarea movida a ${args.toFolder}`, title));
    return { source: { path, text: source.text, sha: source.sha }, dest: destWrite, destLine: st.line };
  } catch (e) {
    throw new PartialMoveError(destWrite, e);
  }
}
