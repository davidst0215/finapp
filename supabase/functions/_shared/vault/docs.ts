// Qué archivos del vault se indexan y cómo se convierten en filas de vault_docs. Puro: sin globals de Deno.
import type { DocKind, DocRow, TreeEntry } from "./types.ts";
import { isIsoDate } from "./fechas.ts";

/** Archivos más grandes que esto no se indexan (los .md del vault pesan < 50 KB). */
export const MAX_DOC_BYTES = 400_000;
/** Tope de texto que entra al índice por documento (tsvector admite < 1 MB). */
const MAX_CONTENT_CHARS = 250_000;

export const TASK_ROOT = "20-projects/";

/**
 * Qué se indexa y como qué; null = se ignora.
 * - 20-projects/<carpeta>/pendientes.md → pendientes (sus tareas van a vault_tasks)
 * - 60-wiki/**                          → nota; pasa a ficha si el frontmatter dice `type: ficha-proyecto`
 * - 20-projects/** y 10-daily, 30-areas, 40-resources, 50-archive → nota
 * - lo demás (.obsidian, _backups, _parked, 90-meta, raíz…) se ignora
 */
export function classifyPath(path: string): DocKind | null {
  if (!path.endsWith(".md")) return null;
  const parts = path.split("/");
  if (parts.length < 2 || parts.some((p) => p.startsWith("."))) return null;
  const top = parts[0];
  if (top === "20-projects") {
    if (parts.length < 3) return null;
    return parts.length === 3 && parts[2] === "pendientes.md" ? "pendientes" : "nota";
  }
  if (top === "60-wiki") return parts[parts.length - 1] === "INDEX.md" ? null : "nota";
  if (top === "10-daily" || top === "30-areas" || top === "40-resources" || top === "50-archive") return "nota";
  return null;
}

/** Norte busca checkboxes en TODOS los .md de 20-projects, no solo en pendientes.md. */
export const isTaskFile = (path: string): boolean =>
  path.startsWith(TASK_ROOT) && path.endsWith(".md") && path.split("/").length >= 3 && !path.split("/").some((p) => p.startsWith("."));

/** Carpeta de 20-projects a la que pertenece un archivo de tareas. */
export const folderOfPath = (path: string): string => path.split("/")[1] ?? "";

/** Nombre del archivo sin .md (lo que se muestra como fuente). */
export const slugOf = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/, "");

// --- Frontmatter (subconjunto de YAML que usan las fichas) ---------------------------------------
export type Frontmatter = Record<string, string | string[]>;

const unquote = (s: string): string => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
    ? t.slice(1, -1)
    : t;
};

function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = "";
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(unquote).filter((s) => s.length > 0);
}

/** Separa el frontmatter (`---` … `---`) del cuerpo. Entiende `clave: valor`, `[a, b]` y listas con guiones. */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Frontmatter = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s+-\s+/, "")));
      data[key] = items.length ? items : "";
    } else if (val.startsWith("[") && val.endsWith("]")) {
      data[key] = splitFlow(val.slice(1, -1));
    } else {
      data[key] = unquote(val);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

const asString = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v.join(", ") : v;
  return s && s.trim() ? s.trim() : null;
};

/** Destinos de los [[wikilinks]] (sin alias ni encabezado), en minúscula y sin repetir. */
export function wikilinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]\n|#]+?)(?:[#|][^\]\n]*)?\]\]/g)) {
    const target = (m[1].split("/").pop() ?? "").trim().toLowerCase();
    if (target) out.add(target);
  }
  return [...out];
}

function titleOf(data: Frontmatter, body: string, path: string): string {
  const fm = asString(data.title);
  if (fm) return fm;
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (h1) return h1[1];
  return slugOf(path).replace(/[-_]+/g, " ").trim();
}

/** Fila del índice para un archivo, o null si no se indexa. */
export function buildDoc(path: string, text: string, sha: string): DocRow | null {
  const base = classifyPath(path);
  if (!base) return null;
  const { data, body } = parseFrontmatter(text);
  const kind: DocKind = base === "nota" && asString(data.type) === "ficha-proyecto" ? "ficha" : base;
  const tags = (Array.isArray(data.tags) ? data.tags : asString(data.tags)?.split(/[,\s]+/) ?? [])
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);
  const fecha = asString(data.actualizado);
  return {
    path,
    kind,
    title: titleOf(data, body, path).slice(0, 300),
    cliente: asString(data.cliente),
    proyecto: asString(data.proyecto) ?? (kind === "ficha" ? slugOf(path) : null),
    padre: asString(data.padre),
    estado: asString(data.estado),
    tags: [...new Set(tags)],
    links: kind === "pendientes" ? [] : wikilinks(body),
    content: kind === "pendientes" ? "" : body.slice(0, MAX_CONTENT_CHARS),
    sha,
    actualizado: fecha && isIsoDate(fecha) ? fecha : null,
  };
}

// --- Plan de sincronización ------------------------------------------------------------------------
export type SyncPlan = {
  /** Archivos nuevos o con SHA distinto: hay que descargarlos. */
  fetch: TreeEntry[];
  /** Rutas indexadas que ya no están en el vault (o dejaron de ser indexables). */
  remove: string[];
  unchanged: number;
};

/** Compara el árbol de GitHub con lo indexado (ruta → sha) y dice qué descargar y qué borrar. */
export function planSync(entries: TreeEntry[], existing: Map<string, string>): SyncPlan {
  const wanted = new Map<string, TreeEntry>();
  for (const e of entries) {
    if (e.type === "blob" && classifyPath(e.path) !== null && (e.size ?? 0) <= MAX_DOC_BYTES) wanted.set(e.path, e);
  }
  const fetch: TreeEntry[] = [];
  let unchanged = 0;
  for (const e of wanted.values()) {
    if (existing.get(e.path) === e.sha) unchanged++;
    else fetch.push(e);
  }
  const remove = [...existing.keys()].filter((p) => !wanted.has(p));
  return { fetch, remove, unchanged };
}

// --- Fragmentos para mostrar -----------------------------------------------------------------------
export const HIT_OPEN = "⟦";
export const HIT_CLOSE = "⟧";

export type SnippetPart = { t: string; hit: boolean };

/** Quita el ruido de markdown de un fragmento, sin tocar las marcas de coincidencia. */
export function cleanMarkdown(s: string): string {
  return s
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|[\s|])[:-]{3,}(?=[\s|]|$)/g, "$1") // filas separadoras de tablas: |---|---|
    .replace(/\s*\|\s*/g, " · ")
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/^\s*·\s*|\s*·\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "…texto ⟦coincidencia⟧ texto…" → partes con `hit` para que la UI resalte sin HTML. */
export function snippetParts(raw: string): SnippetPart[] {
  const text = cleanMarkdown(raw);
  const parts: SnippetPart[] = [];
  let hit = false;
  for (const piece of text.split(new RegExp(`([${HIT_OPEN}${HIT_CLOSE}])`))) {
    if (piece === HIT_OPEN) hit = true;
    else if (piece === HIT_CLOSE) hit = false;
    else if (piece) {
      const last = parts[parts.length - 1];
      if (last && last.hit === hit) last.t += piece;
      else parts.push({ t: piece, hit });
    }
  }
  return parts;
}

/** Texto plano de un fragmento (para el prompt del modelo y para depurar). */
export const snippetText = (raw: string): string => cleanMarkdown(raw).replaceAll(HIT_OPEN, "").replaceAll(HIT_CLOSE, "");
