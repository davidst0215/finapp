// Configuración de proyectos de Norte (Trabajo/Personal, frentes, nombres) tal como llega por el vault.
// Una sola fuente: projects.config.json de Norte. La tarea programada del portátil lo copia a CONFIG_PATH dentro del vault, GitHub lo
// lleva y la sincronización de Wabid lo guarda en vault_sync (migración 022). El secreto VAULT_PROJECTS_JSON queda de respaldo.
// Puro: sin globals de Deno (config.test.ts).
import { type Config, parseConfig } from "./taxonomy.ts";
import type { TreeEntry } from "./types.ts";

export const CONFIG_PATH = "90-meta/norte.config.json";
/** Un archivo de configuración razonable pesa unos KB; más que esto es un error o abuso. */
export const MAX_CONFIG_CHARS = 100_000;

/**
 * El texto de la config si sirve (JSON con un objeto `trabajo`), sin BOM; si no, null. Una edición a medias del archivo no debe
 * borrar la configuración buena que Wabid ya tiene: ante null se conserva la anterior.
 */
export function configValida(texto: string): string | null {
  const t = texto.replace(/^﻿/, "").trim();
  if (!t || t.length > MAX_CONFIG_CHARS) return null;
  try {
    const j: unknown = JSON.parse(t);
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const trabajo = (j as { trabajo?: unknown }).trabajo;
    return trabajo && typeof trabajo === "object" && !Array.isArray(trabajo) ? t : null;
  } catch {
    return null;
  }
}

/** La entrada del árbol que hay que leer: el archivo de config SOLO si cambió respecto al sha que ya se guardó. */
export function configACargar(entries: TreeEntry[], shaGuardado: string | null | undefined): TreeEntry | null {
  const e = entries.find((x) => x.path === CONFIG_PATH && x.type === "blob");
  return e && e.sha !== shaGuardado ? e : null;
}

/** La config que manda: la del vault si hay y es válida; si no, la del secreto; si tampoco, todo es personal. */
export function elegirConfig(delVault: string | null | undefined, delSecreto: string | undefined): Config {
  const v = delVault ? configValida(delVault) : null;
  return parseConfig(v ?? delSecreto ?? "");
}
