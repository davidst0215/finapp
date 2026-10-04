// Taxonomía de carpetas del vault, igual que Norte (projects.config.json + server.js: loadConfig / classify):
//   TRABAJO  → proyecto que agrupa varios "frentes" (cada frente es una carpeta de 20-projects)
//   PERSONAL → cualquier otra carpeta, plana
//   CAJÓN    → bandeja de entrada sin categorizar (la llena el script de Fathom)
// La configuración real NO vive en el código (el repo es público): llega por la variable VAULT_PROJECTS_JSON
// con el mismo JSON que usa Norte. Sin ella todo se trata como personal y sigue funcionando.
// Puro: sin globals de Deno.

export const INBOX_FOLDER = "cajon-desastre";
export const INBOX_LABEL = "Cajón desastre";

export type Scope = "trabajo" | "personal" | "cajon";
export type WorkEntry = { carpeta: string; nombre: string };
/** Orden de las claves = orden de los proyectos en pantalla. */
export type Config = { trabajo: Record<string, WorkEntry[]> };

export type FolderInfo = {
  folder: string;
  scope: Scope;
  project: string;
  frente: string | null;
  /** "Proyecto › Frente" o solo el proyecto. */
  label: string;
};

/** "gosentio-enki" → "Gosentio Enki" (igual que pretty() de Norte). */
export function pretty(s: string): string {
  return s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Slug de carpeta seguro: evita path traversal y nombres raros. */
export const isFolderSlug = (s: unknown): s is string => typeof s === "string" && /^[\w-]+$/.test(s);

export const EMPTY_CONFIG: Config = { trabajo: {} };

/** Lee el JSON de Norte. Tolerante: una entrada puede ser "carpeta" o { carpeta, nombre }; lo inválido se ignora. */
export function parseConfig(input: unknown): Config {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return EMPTY_CONFIG;
    }
  }
  const trabajo = (raw as { trabajo?: unknown } | null)?.trabajo;
  if (!trabajo || typeof trabajo !== "object" || Array.isArray(trabajo)) return EMPTY_CONFIG;
  const out: Record<string, WorkEntry[]> = {};
  for (const [project, entries] of Object.entries(trabajo as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const list: WorkEntry[] = [];
    for (const e of entries) {
      const carpeta = typeof e === "string" ? e : (e as { carpeta?: unknown } | null)?.carpeta;
      if (!isFolderSlug(carpeta)) continue;
      const nombre = typeof e === "object" && e && typeof (e as { nombre?: unknown }).nombre === "string"
        ? (e as { nombre: string }).nombre
        : "";
      list.push({ carpeta, nombre: nombre || pretty(carpeta) });
    }
    if (list.length) out[project] = list;
  }
  return { trabajo: out };
}

const makeInfo = (folder: string, scope: Scope, project: string, frente: string | null): FolderInfo => ({
  folder, scope, project, frente, label: frente ? `${project} › ${frente}` : project,
});

export function classify(folder: string, cfg: Config): FolderInfo {
  if (folder === INBOX_FOLDER) return makeInfo(folder, "cajon", INBOX_LABEL, null);
  for (const [project, entries] of Object.entries(cfg.trabajo)) {
    const hit = entries.find((e) => e.carpeta === folder);
    if (hit) return makeInfo(folder, "trabajo", project, hit.nombre);
  }
  return makeInfo(folder, "personal", pretty(folder), null);
}

/** Posición de un proyecto de trabajo en la configuración (los demás van después). */
export const projectOrder = (cfg: Config): string[] => Object.keys(cfg.trabajo);

/**
 * Destinos válidos para crear o mover: carpetas de la configuración + carpetas ya existentes en el vault.
 * Orden: trabajo (como en la configuración), personales (alfabético) y el cajón al final.
 */
export function listDestinations(cfg: Config, knownFolders: string[]): FolderInfo[] {
  const seen = new Set<string>();
  const work: FolderInfo[] = [];
  for (const [project, entries] of Object.entries(cfg.trabajo)) {
    for (const e of entries) {
      if (seen.has(e.carpeta)) continue;
      seen.add(e.carpeta);
      work.push(makeInfo(e.carpeta, "trabajo", project, e.nombre));
    }
  }
  const personal: FolderInfo[] = [];
  for (const f of knownFolders) {
    if (seen.has(f) || f === INBOX_FOLDER || !isFolderSlug(f)) continue;
    seen.add(f);
    personal.push(classify(f, cfg));
  }
  personal.sort((a, b) => a.label.localeCompare(b.label, "es"));
  return [...work, ...personal, makeInfo(INBOX_FOLDER, "cajon", INBOX_LABEL, null)];
}

// --- Texto libre → carpeta (para la voz) ---------------------------------------------------------
const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const STOP = new Set([
  "de", "del", "la", "el", "los", "las", "en", "y", "a", "al", "para", "un", "una", "con", "mi", "mis",
  "proyecto", "frente", "carpeta", "tarea", "tareas", "pendiente", "pendientes", "lista",
]);

export const tokens = (s: string): string[] => norm(s).split(" ").filter((t) => t && !STOP.has(t));

/** Dos palabras coinciden si son iguales o una es prefijo de la otra (plurales, "costo"/"costos"). */
export const tokenMatch = (a: string, b: string): boolean =>
  a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

export type FolderMatch =
  | { kind: "one"; info: FolderInfo }
  | { kind: "many"; options: FolderInfo[] }
  | { kind: "none" };

/**
 * "tdv bolsa", "cobranzas colombia", "wabid", "el cajón" → carpeta. Todas las palabras de la consulta deben
 * aparecer en el slug, el proyecto o el frente. Si queda más de una, devuelve las opciones para preguntar.
 */
export function resolveFolder(query: unknown, cfg: Config, knownFolders: string[]): FolderMatch {
  const text = typeof query === "string" ? query : "";
  const q = tokens(text);
  const all = listDestinations(cfg, knownFolders);
  if (/^\s*(el\s+)?(cajon|caj[oó]n)(\s+desastre)?\s*$/i.test(norm(text)) || norm(text) === norm(INBOX_LABEL)) {
    return { kind: "one", info: all[all.length - 1] };
  }
  if (!q.length) return { kind: "none" };

  const exact = all.find((d) => d.folder === text.trim().toLowerCase());
  if (exact) return { kind: "one", info: exact };

  const hits = all.filter((d) => {
    if (d.scope === "cajon") return false;
    const bag = [...tokens(d.folder), ...tokens(d.project), ...(d.frente ? tokens(d.frente) : [])];
    return q.every((t) => bag.some((b) => tokenMatch(t, b)));
  });
  if (hits.length === 1) return { kind: "one", info: hits[0] };
  if (hits.length === 0) return { kind: "none" };

  // Varias: si la consulta es exactamente el nombre de una sola, gana esa ("wabid" frente a "wabid-app").
  const nq = norm(text);
  const exacta = hits.filter((d) => norm(d.label) === nq || norm(d.project) === nq || (d.frente && norm(d.frente) === nq));
  if (exacta.length === 1) return { kind: "one", info: exacta[0] };
  return { kind: "many", options: hits };
}
