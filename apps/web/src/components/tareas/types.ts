// Contrato de la edge function `vault` (supabase/functions/vault). El servidor da forma a todo
// (agrupa, ordena, calcula etiquetas de fecha en hora de Lima): la UI solo pinta y manda acciones.

export type TaskStatus = 'pending' | 'in-progress' | 'completed' | 'need-help' | 'failed';
export type Scope = 'trabajo' | 'personal' | 'cajon';
/** 0 = sin prioridad, 1 = bajo, 2 = medio, 3 = alto (barras de la maqueta). */
export type Priority = 0 | 1 | 2 | 3;
export type Level = 'alto' | 'medio' | 'bajo';

export interface VaultTask {
  /** `${path}::${line}`. Solo identifica la tarea mientras el archivo no cambie: al escribir se manda también `raw`. */
  id: string;
  path: string;
  line: number;
  /** Línea completa tal como está en el .md. Se devuelve igual en task.status / task.move para ubicar la tarea. */
  raw: string;
  folder: string;
  scope: Scope;
  /** "Acme" · "Life" · "Cajón desastre" */
  project: string;
  /** "Bolsa de costos"; null en personales y en el cajón. */
  frente: string | null;
  /** "Acme › Ventas" o solo el proyecto. */
  label: string;
  text: string;
  status: TaskStatus;
  priority: Priority;
  /** AAAA-MM-DD (fecha de vencimiento 📅, o la programada ⏳ si no hay). */
  due: string | null;
  /** "hoy" · "mañana" · "viernes 9 oct" · si está vencida: "Venció ayer" · "Venció hace 3 días" · "Venció el lunes 31 ago". */
  dueLabel: string | null;
  /** Vencida y todavía abierta: la UI la pinta en rojo (único uso del rojo). */
  overdue: boolean;
  /** Detalle (bullet indentado bajo la tarea) en texto plano; los links markdown quedan solo con su texto. */
  note: string | null;
  /** Primer link https del detalle (p. ej. la grabación de Fathom). */
  link: string | null;
  /** Trabajo conjunto (#conjunto) o espera de otra persona (#conjunto/daniel). */
  shared: boolean;
  /** "Daniel" (ya capitalizado) o null. */
  sharedWith: string | null;
  /** Carpeta que propone #destino/… (solo cajón). */
  suggest: string | null;
  /** "Acme › Soporte" */
  suggestLabel: string | null;
  source: 'fathom' | null;
  /** Subtareas (checkbox indentado). null si no tiene. */
  subtasks: { done: number; total: number } | null;
}

export interface TaskGroup {
  /** Carpeta de 20-projects. */
  key: string;
  folder: string;
  scope: Exclude<Scope, 'cajon'>;
  project: string;
  frente: string | null;
  /** "Acme › Ventas" o "Life". Título del grupo. */
  label: string;
  /** Ordenadas: prioridad alta primero, luego fecha más próxima, sin fecha al final. */
  tasks: VaultTask[];
}

export interface Destination {
  folder: string;
  scope: Scope;
  project: string;
  frente: string | null;
  label: string;
}

export interface TasksResponse {
  /** Fecha de hoy en Lima, AAAA-MM-DD. */
  hoy: string;
  /** Trabajo (orden de Norte) y luego personales (alfabético). Solo tareas abiertas. */
  groups: TaskGroup[];
  /** Cajón desastre: tareas abiertas por triagear. */
  inbox: VaultTask[];
  counts: {
    /** Abiertas en trabajo + personal. */
    open: number;
    /** Vencidas en trabajo + personal. */
    overdue: number;
    /** Con fecha de hoy en trabajo + personal. */
    today: number;
    /** Abiertas en el cajón. */
    inbox: number;
  };
  /** Carpetas válidas para crear o mover (trabajo, personales y el cajón). */
  destinations: Destination[];
  /** Última sincronización del índice con GitHub (ISO) o null si nunca. */
  syncedAt: string | null;
  /** Si no se pudo sincronizar con GitHub: motivo corto. Lo mostrado es lo último indexado y puede estar desactualizado. */
  syncError?: string | null;
}

export interface CreateTaskInput {
  text: string;
  /** Carpeta de 20-projects. Si falta, va al cajón. */
  folder?: string;
  level?: Level;
  /** AAAA-MM-DD */
  due?: string;
  note?: string;
}

export interface TaskRef {
  path: string;
  line: number;
  raw: string;
}

export interface TaskMutationResponse {
  ok: true;
  /** La tarea tal como quedó (null si salió del índice, p. ej. al moverla). */
  task: VaultTask | null;
}

// ── Búsqueda (memoria) ────────────────────────────────────────────────────

export interface SnippetPart {
  t: string;
  /** true = coincide con la búsqueda (resaltar). */
  hit: boolean;
}

export interface SearchSource {
  /** Número de la fuente (1, 2, …) tal como la cita la respuesta. */
  n: number;
  path: string;
  /** Nombre del archivo sin .md, p. ej. "acme-ventas-informes". */
  slug: string;
  title: string;
  kind: 'ficha' | 'nota';
  cliente: string | null;
  proyecto: string | null;
  snippet: SnippetPart[];
}

export interface SearchRelated {
  path: string;
  slug: string;
  title: string;
  proyecto: string | null;
  cliente: string | null;
}

export interface ClienteChip {
  cliente: string;
  count: number;
}

export interface SearchResponse {
  q: string;
  /** Respuesta redactada a partir de las fuentes (solo si se pidió answer: true y hubo coincidencias). */
  answer: string | null;
  /** Si se pidió respuesta y no se pudo redactar: motivo corto para mostrar bajo las fuentes. */
  answerError: string | null;
  sources: SearchSource[];
  related: SearchRelated[];
  /** Clientes con fichas indexadas (chips). */
  clientes: ClienteChip[];
  /** Documentos de conocimiento indexados (fichas + notas). */
  indexed: number;
}
