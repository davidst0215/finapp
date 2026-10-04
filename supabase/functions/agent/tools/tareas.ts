// Módulo "tareas" del agente: lee y escribe las tareas de Norte (vault de Obsidian en GitHub) por voz o texto.
// No agrega contexto al prompt (cero consultas por pedido): las tools consultan el índice solo cuando se usan.
// Las respuestas son frases cortas y deterministas para leer en voz; el modelo no redacta datos de tareas.
import { comentario, conComentario } from "../prompt.ts";
import { type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";
import {
  assertOwner, createTask, ensureIndexed, GitHubError, knownFolders, loadTaskRows, PartialMoveError, setTaskStatus, syncIndex,
  TaskNotFoundError, VaultError, vaultEnv,
} from "../../_shared/vault.ts";
import { fechaHablada, resolveDue } from "../../_shared/vault/fechas.ts";
import { findTask } from "../../_shared/vault/match.ts";
import { corto, hablado, preguntaCual, preguntaDonde, resumenGeneral, resumenTareas } from "../../_shared/vault/speech.ts";
import { classify, INBOX_FOLDER, resolveFolder } from "../../_shared/vault/taxonomy.ts";
import { cleanText, isLevel, isStatus, type TaskStatus } from "../../_shared/vault/tasks.ts";
import type { TaskRow } from "../../_shared/vault/types.ts";
import { buildTasksView, isOpen, toViewTask, type ViewTask } from "../../_shared/vault/view.ts";

const rules = `TAREAS (Norte, el vault de David):
- Una tarea es algo por hacer. "agrega / anota / apunta / recuérdame … (algo pendiente)" → create_task. "ya terminé / completé / hice X", "marca X como hecha", "reabre X", "X está en curso" → update_task. "qué tengo pendiente / vencidas / para hoy / en el cajón / de <proyecto>" → list_tasks.
- "pagué / gasté / compré" es finanzas, no tareas.
- Fechas: pásalas como las dice David ("hoy", "mañana", "viernes", "+3") o AAAA-MM-DD si dice día y mes; no hagas cuentas de calendario.
- Proyecto: pasa sus palabras ("acme ventas", "mi proyecto") sin inventar nombres. Si no menciona proyecto, déjalo vacío: va al cajón.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const err = (message: string): ToolResult => ({ action: "error", message });
const hoyDe = (ctx: AgentContext) => ctx.limaNow.toISOString().slice(0, 10);

/** Errores de dominio → frase para decir en voz; lo inesperado se registra sin datos y se dice genérico. */
function mensajeError(e: unknown): string {
  if (e instanceof VaultError || e instanceof TaskNotFoundError || e instanceof PartialMoveError) return e.message;
  if (e instanceof GitHubError) return "No pude hablar con GitHub ahora. Inténtalo en un momento.";
  console.error("tareas:", e instanceof Error ? e.message : String(e));
  return "Algo falló con tus tareas. Inténtalo de nuevo.";
}

type Handler = (args: Record<string, unknown>, ctx: AgentContext) => Promise<ToolResult>;
const guard = (fn: Handler): Handler => async (args, ctx) => {
  try {
    return await fn(args, ctx);
  } catch (e) {
    return err(mensajeError(e));
  }
};

function acceso(ctx: AgentContext) {
  const env = vaultEnv();
  assertOwner(ctx.user.id, env);
  return { env, db: ctx.supabase, userId: ctx.user.id, hoy: hoyDe(ctx) };
}

const compact = (t: ViewTask) => ({ text: t.text, project: t.label, due: t.due, overdue: t.overdue });

// --- list_tasks ------------------------------------------------------------------------------------
const listTasks: Handler = async (args, ctx) => {
  const { env, db, userId, hoy } = acceso(ctx);
  await ensureIndexed(db, userId, env);
  const [rows, folders] = await Promise.all([loadTaskRows(db, userId), knownFolders(db, userId)]);
  const view = buildTasksView(rows, env.config, folders, hoy, null);
  const abiertas = view.groups.flatMap((g) => g.tasks);
  const filter = str(args.filter);

  let message: string;
  let lista: ViewTask[] = [];
  if (filter === "overdue") {
    lista = abiertas.filter((t) => t.overdue).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
    message = resumenTareas("overdue", lista);
  } else if (filter === "today") {
    lista = abiertas.filter((t) => t.due === hoy);
    message = resumenTareas("today", lista);
    if (view.counts.overdue > 0) message += ` Además tienes ${view.counts.overdue} ${view.counts.overdue === 1 ? "vencida" : "vencidas"}.`;
  } else if (filter === "inbox") {
    lista = view.inbox;
    message = resumenTareas("inbox", lista);
  } else if (filter === "project") {
    const m = resolveFolder(args.project, env.config, folders);
    if (m.kind === "none") return err(`No encontré un proyecto que se parezca a «${corto(str(args.project), 40)}».`);
    const mismoProyecto = m.kind === "many" && m.options.every((o) => o.project === m.options[0].project);
    if (m.kind === "many" && !mismoProyecto) return { action: "clarify", message: preguntaDonde(m.options) };
    const infos = m.kind === "one" ? [m.info] : m.options;
    const carpetas = new Set(infos.map((i) => i.folder));
    lista = infos[0].scope === "cajon" ? view.inbox : abiertas.filter((t) => carpetas.has(t.folder));
    message = resumenTareas("project", lista, { projectLabel: m.kind === "one" ? hablado(m.info) : m.options[0].project });
  } else {
    message = resumenGeneral(view.counts);
  }
  return { action: "list_tasks", message, data: { tasks: lista.slice(0, 10).map(compact), counts: view.counts } };
};

// --- create_task -----------------------------------------------------------------------------------
const createTaskTool: Handler = async (args, ctx) => {
  const { env, db, userId, hoy } = acceso(ctx);
  const text = str(args.text).trim();
  if (!text) return err("No entendí qué tarea anotar.");

  let folder = INBOX_FOLDER;
  let aviso = "";
  const proyecto = str(args.project).trim();
  if (proyecto) {
    const m = resolveFolder(proyecto, env.config, await knownFolders(db, userId));
    if (m.kind === "one") folder = m.info.folder;
    else if (m.kind === "many") return { action: "clarify", message: preguntaDonde(m.options) };
    else aviso = ` No encontré el proyecto «${corto(proyecto, 40)}», así que quedó en el cajón.`;
  }

  let due: string | null = null;
  const dueRaw = str(args.due).trim();
  if (dueRaw) {
    due = resolveDue(dueRaw, hoy);
    if (!due) return { action: "clarify", message: `No entendí la fecha «${corto(dueRaw, 30)}». Dímela como mañana, el viernes o el 15 de octubre.` };
  }

  const r = await createTask(db, userId, env, {
    text,
    folder,
    due,
    level: isLevel(args.priority) ? args.priority : undefined,
    shared: str(args.with).trim() || undefined,
    note: str(args.note).trim() || undefined,
  }, hoy);
  const donde = folder === INBOX_FOLDER ? "el cajón" : hablado(classify(folder, env.config));
  const guardado = r.task?.text ?? cleanText(text); // lo realmente guardado (sin # de tags ni emojis de metadata)
  const base = `Listo, anoté «${corto(guardado, 60)}» en ${donde}${r.due ? ` para ${fechaHablada(r.due, hoy)}` : ""}.${aviso}`;
  return { action: "create_task", message: conComentario(base, args), data: r.task };
};

// --- update_task -----------------------------------------------------------------------------------
const VERBO: Record<TaskStatus, (t: string, cambio: boolean) => string> = {
  completed: (t, c) => (c ? `Listo, completé «${t}».` : `«${t}» ya estaba completada.`),
  pending: (t, c) => (c ? `Reabrí «${t}».` : `«${t}» ya estaba abierta.`),
  "in-progress": (t) => `Listo, «${t}» queda en curso.`,
  "need-help": (t) => `Anotado: «${t}» necesita ayuda.`,
  failed: (t) => `Marqué «${t}» como fallida.`,
};

const updateTask: Handler = async (args, ctx) => {
  const { env, db, userId, hoy } = acceso(ctx);
  const search = str(args.search).trim();
  if (!search) return err("No entendí cuál tarea.");
  const status: TaskStatus = isStatus(args.status) ? args.status : "completed";
  await ensureIndexed(db, userId, env);

  // Para reabrir se buscan las cerradas; para el resto, las abiertas (solo tareas de primer nivel).
  const candidatas = (rows: TaskRow[]) =>
    rows.filter((r) => r.parent_line === null && (status === "pending" ? !isOpen(r.status) : isOpen(r.status)));

  // Si el índice está atrasado (David acaba de crearla en Norte), se sincroniza una vez y se reintenta.
  for (let intento = 0; intento < 2; intento++) {
    if (intento === 1) await syncIndex(db, userId, env, { maxAgeMs: 30_000 }); // si acaba de sincronizar, no vuelve a pedir el árbol
    const found = findTask(search, candidatas(await loadTaskRows(db, userId)), env.config);
    if (found.kind === "many") {
      return { action: "clarify", message: preguntaCual(found.matches.map((m) => toViewTask(m.row, env.config, hoy))) };
    }
    if (found.kind === "none") {
      if (intento === 0) continue;
      return err(`No encontré una tarea que se parezca a «${corto(search, 50)}».`);
    }
    const row = found.match.row;
    try {
      const r = await setTaskStatus(db, userId, env, { path: row.path, line: row.line, raw: row.raw, status }, hoy);
      return { action: "update_task", message: conComentario(VERBO[status](corto(row.text, 60), r.changed), args), data: r.task };
    } catch (e) {
      if (e instanceof TaskNotFoundError && intento === 0) continue;
      throw e;
    }
  }
  return err("No pude actualizar la tarea. Inténtalo de nuevo.");
};

export const tareas: AgentModule = {
  id: "tareas",
  rules,
  definitions: [
    tool("list_tasks", "Lista tareas pendientes de Norte: las de hoy, las vencidas, las de un proyecto o frente, las del cajón desastre, o un resumen general.", {
      filter: { type: "string", enum: ["today", "overdue", "project", "inbox", "summary"], description: "today=para hoy, overdue=vencidas, project=de un proyecto/frente, inbox=cajón desastre, summary=resumen general" },
      project: { type: "string", description: "Solo con filter=project: proyecto o frente con las palabras de David" },
    }, ["filter"]),
    tool("create_task", "Crea una tarea nueva en Norte (algo por hacer: 'agrega', 'anota', 'recuérdame…').", {
      text: { type: "string", description: "La tarea, corta y en infinitivo (ej. 'Llamar a Ana')" },
      project: { type: "string", description: "Proyecto o frente con las palabras de David; vacío si no lo dijo (va al cajón)" },
      due: { type: "string", description: "Cuándo: 'hoy', 'mañana', 'viernes', '+3' o AAAA-MM-DD si dijo día y mes" },
      priority: { type: "string", enum: ["alto", "medio", "bajo"] },
      with: { type: "string", description: "Persona, si es trabajo conjunto o si espera algo de ella" },
      note: { type: "string", description: "Detalle adicional, opcional" },
      comentario,
    }, ["text"]),
    tool("update_task", "Cambia el estado de una tarea que ya existe: completarla ('ya terminé X'), reabrirla, ponerla en curso, pedir ayuda o marcarla fallida.", {
      search: { type: "string", description: "Palabras de la tarea para encontrarla" },
      status: { type: "string", enum: ["completed", "pending", "in-progress", "need-help", "failed"], description: "completed por defecto; pending para reabrir" },
      comentario,
    }, ["search"]),
  ],
  handlers: {
    list_tasks: guard(listTasks),
    create_task: guard(createTaskTool),
    update_task: guard(updateTask),
  },
};
