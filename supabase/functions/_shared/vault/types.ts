// Tipos compartidos del módulo vault en el servidor. Las filas usan los nombres de columna de 005_vault.sql.
import type { TaskStatus } from "./tasks.ts";

export type DocKind = "ficha" | "pendientes" | "nota";

/** Fila de vault_docs (lo que se escribe en el índice). */
export type DocRow = {
  path: string;
  kind: DocKind;
  title: string;
  cliente: string | null;
  proyecto: string | null;
  padre: string | null;
  estado: string | null;
  tags: string[];
  /** Destinos de los [[wikilinks]] del cuerpo, en minúscula y sin repetir. */
  links: string[];
  /** Cuerpo sin frontmatter. Vacío en los pendientes (sus tareas viven en vault_tasks). */
  content: string;
  /** SHA del blob en GitHub: detecta cambios sin volver a descargar. */
  sha: string;
  /** `actualizado` del frontmatter (AAAA-MM-DD), si lo trae. */
  actualizado: string | null;
};

/** Fila de vault_tasks. */
export type TaskRow = {
  path: string;
  line: number;
  folder: string;
  raw: string;
  text: string;
  status: TaskStatus;
  /** 0 sin prioridad · 1 bajo · 2 medio · 3 alto */
  priority: number;
  due: string | null;
  scheduled: string | null;
  done_on: string | null;
  recurring: string | null;
  shared: boolean;
  shared_with: string | null;
  suggest: string | null;
  source: string | null;
  note: string | null;
  indent: number;
  parent_line: number | null;
};

export type TreeEntry = { path: string; type: string; sha: string; size?: number };
