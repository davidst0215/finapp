// Módulo vault de Wabid: sincroniza el vault de Obsidian (repo privado en GitHub) con un índice en Postgres y
// opera sobre él (tareas y memoria). Lo usan la edge function `vault` (UI) y las tools del agente.
// La lógica pura vive en ./vault/*.ts (con pruebas en Node); aquí solo hay lo que necesita Deno, la base y el modelo.
//
// Variables de entorno (secretos de la función, nunca en el repo):
//   VAULT_GITHUB_TOKEN   token fine-grained con Contents lectura/escritura SOLO sobre el repo del vault
//   VAULT_REPO           "dueño/repo"
//   VAULT_BRANCH         rama (por defecto "main")
//   VAULT_OWNER_ID       UUID de David en Supabase Auth: el token de GitHub solo se usa a su nombre
//   VAULT_PROJECTS_JSON  (opcional) el JSON de projects.config.json de Norte; sin él todo cuenta como personal
//   VAULT_SYNC_SECRET    (opcional) secreto para que un cron sincronice sin sesión (cabecera x-vault-secret)
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { llmConfigured, llmFetch } from "./llm.ts";
import { createGitHub, GitHubError, type GitHubApi } from "./vault/github.ts";
import { folderOfPath, planSync } from "./vault/docs.ts";
import { resolveDue } from "./vault/fechas.ts";
import {
  opCreateTask, opMoveTask, opSetStatus, PartialMoveError, VaultError, type FileWrite,
} from "./vault/ops.ts";
import { armarCatalogo, CatalogoCache, parametrosBusqueda, recortarFicha, topePorFicha, type Catalogo, type CatalogoRow } from "./vault/catalogo.ts";
import { rowsForFile } from "./vault/rows.ts";
import {
  buildAnswerMessages, clienteChips, mensajeMemoria, parseAnswer, pickRelated, toSources, type ClienteChip, type Hit,
  type Related, type RelatedRow, type Source,
} from "./vault/search.ts";
import {
  classify, INBOX_FOLDER, isFolderSlug, listDestinations, parseConfig, type Config,
} from "./vault/taxonomy.ts";
import { isLevel, isStatus, TaskNotFoundError, type Level, type TaskStatus } from "./vault/tasks.ts";
import type { DocRow, TaskRow } from "./vault/types.ts";
import { buildTasksView, toViewTask, type TasksView, type ViewTask } from "./vault/view.ts";

export { VaultError, TaskNotFoundError, PartialMoveError, GitHubError };
export type { TasksView, ViewTask, Source, Related, ClienteChip };

// --- Configuración -----------------------------------------------------------------------------
export type VaultEnv = { token: string; repo: string; branch: string; ownerId: string; config: Config };

export function vaultEnv(): VaultEnv {
  const token = Deno.env.get("VAULT_GITHUB_TOKEN");
  const repo = Deno.env.get("VAULT_REPO");
  const ownerId = Deno.env.get("VAULT_OWNER_ID");
  if (!token || !repo || !ownerId) {
    throw new VaultError("El vault no está configurado: faltan VAULT_GITHUB_TOKEN, VAULT_REPO o VAULT_OWNER_ID.", 503);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new VaultError("VAULT_REPO debe tener la forma dueño/repo.", 503);
  return {
    token,
    repo,
    branch: Deno.env.get("VAULT_BRANCH") || "main",
    ownerId,
    config: parseConfig(Deno.env.get("VAULT_PROJECTS_JSON") ?? ""),
  };
}

/** El token de GitHub es del dueño: nadie más (aunque tenga sesión) lo usa. */
export function assertOwner(userId: string, env: VaultEnv): void {
  if (userId !== env.ownerId) throw new VaultError("No autorizado", 403);
}

export const github = (env: VaultEnv): GitHubApi => createGitHub({ token: env.token, repo: env.repo, branch: env.branch });

// --- Lectura del índice --------------------------------------------------------------------------
const PAGE = 1000;
/** Archivos por corrida de sync y por lote persistido (la primera sync de un vault grande llega en varias llamadas). */
const MAX_PER_RUN = 150;
const BATCH = 25;

async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new VaultError(`No pude leer el índice del vault: ${error.message}`, 500);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export type SyncState = { tree_sha: string | null; synced_at: string; docs: number; tasks: number };

export async function getSyncState(db: SupabaseClient, userId: string): Promise<SyncState | null> {
  const { data, error } = await db.from("vault_sync").select("tree_sha, synced_at, docs, tasks").eq("user_id", userId).maybeSingle();
  if (error) throw new VaultError(`No pude leer el estado del vault: ${error.message}`, 500);
  return (data as SyncState | null) ?? null;
}

export const loadTaskRows = (db: SupabaseClient, userId: string): Promise<TaskRow[]> =>
  selectAll<TaskRow>((from, to) =>
    db.from("vault_tasks").select("*").eq("user_id", userId).order("path").order("line").range(from, to)
  );

/** Carpetas de 20-projects que existen en el vault (para destinos válidos). */
export async function knownFolders(db: SupabaseClient, userId: string): Promise<string[]> {
  const rows = await selectAll<{ path: string }>((from, to) =>
    db.from("vault_docs").select("path").eq("user_id", userId).like("path", "20-projects/%").order("path").range(from, to)
  );
  return [...new Set(rows.map((r) => folderOfPath(r.path)).filter(Boolean))];
}

// --- Escritura del índice ------------------------------------------------------------------------
type Batch = { docs: DocRow[]; files: { path: string; tasks: TaskRow[] }[]; remove?: string[]; treeSha?: string };

async function applyBatch(db: SupabaseClient, userId: string, b: Batch): Promise<void> {
  const { error } = await db.rpc("vault_apply_sync", {
    p_user: userId,
    p_docs: b.docs,
    p_files: b.files,
    p_remove: b.remove ?? [],
    p_tree_sha: b.treeSha ?? null,
  });
  if (error) throw new VaultError(`No pude actualizar el índice del vault: ${error.message}`, 500);
}

/** Después de escribir en GitHub: el índice refleja el archivo nuevo al instante, sin releer el repo. */
export async function indexWrites(db: SupabaseClient, userId: string, writes: FileWrite[]): Promise<void> {
  const docs: DocRow[] = [];
  const files: { path: string; tasks: TaskRow[] }[] = [];
  for (const w of writes) {
    const r = rowsForFile(w.path, w.text, w.sha);
    if (r.doc) docs.push(r.doc);
    if (r.tasks) files.push({ path: w.path, tasks: r.tasks });
  }
  await applyBatch(db, userId, { docs, files });
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// --- Sincronización --------------------------------------------------------------------------------
export type SyncResult = {
  skipped: boolean;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  docs: number;
  tasks: number;
  syncedAt: string;
  /** Quedan archivos por traer (vault grande): volver a llamar a sync para continuar. */
  partial: boolean;
};

/**
 * Trae de GitHub solo lo que cambió (compara el sha de cada archivo con el indexado) y actualiza el índice.
 * `maxAgeMs`: si la última sincronización es más reciente que eso, no hace nada (a menos que `force`).
 */
export async function syncIndex(
  db: SupabaseClient,
  userId: string,
  env: VaultEnv,
  opts: { force?: boolean; maxAgeMs?: number } = {},
): Promise<SyncResult> {
  const state = await getSyncState(db, userId);
  const summary = (extra: Partial<SyncResult>): SyncResult => ({
    skipped: false, partial: false, added: 0, updated: 0, removed: 0, unchanged: 0,
    docs: state?.docs ?? 0, tasks: state?.tasks ?? 0, syncedAt: state?.synced_at ?? new Date().toISOString(), ...extra,
  });
  if (!opts.force && state && opts.maxAgeMs !== undefined && Date.now() - Date.parse(state.synced_at) < opts.maxAgeMs) {
    return summary({ skipped: true });
  }

  const gh = github(env);
  const tree = await gh.getTree();
  // Un árbol incompleto haría "desaparecer" documentos: mejor fallar que borrar de más.
  if (tree.truncated) throw new VaultError("El vault es demasiado grande para listarlo de una vez en GitHub.", 502);

  if (!opts.force && state?.tree_sha === tree.sha) {
    await applyBatch(db, userId, { docs: [], files: [], treeSha: tree.sha }); // solo renueva la hora
    return summary({ syncedAt: new Date().toISOString() });
  }

  const existing = new Map(
    (await selectAll<{ path: string; sha: string }>((from, to) =>
      db.from("vault_docs").select("path, sha").eq("user_id", userId).order("path").range(from, to)
    )).map((r) => [r.path, r.sha] as const),
  );
  const plan = planSync(tree.entries, existing);

  // Por tandas: se baja, se parsea y se persiste cada una antes de pedir la siguiente (memoria acotada), y una
  // corrida procesa como máximo MAX_PER_RUN archivos. Si quedan, el sha del árbol NO se guarda y se devuelve
  // partial: true; la siguiente llamada continúa donde quedó (lo ya indexado cuenta como sin cambios).
  const todo = plan.fetch.slice(0, MAX_PER_RUN);
  const partial = plan.fetch.length > todo.length;
  let first = true;
  for (let i = 0; i < Math.max(todo.length, 1); i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const fetched = await mapPool(slice, 6, async (e) => ({ entry: e, text: await gh.getBlob(e.sha) }));
    const docs: DocRow[] = [];
    const files: { path: string; tasks: TaskRow[] }[] = [];
    for (const { entry, text } of fetched) {
      const r = rowsForFile(entry.path, text, entry.sha);
      if (r.doc) docs.push(r.doc);
      if (r.tasks) files.push({ path: entry.path, tasks: r.tasks });
    }
    const last = i + BATCH >= todo.length;
    await applyBatch(db, userId, {
      docs,
      files,
      remove: first ? plan.remove : undefined,
      treeSha: last && !partial ? tree.sha : undefined,
    });
    first = false;
  }

  const fresh = await getSyncState(db, userId);
  return {
    skipped: false,
    partial,
    added: plan.fetch.slice(0, MAX_PER_RUN).filter((e) => !existing.has(e.path)).length,
    updated: todo.length - plan.fetch.slice(0, MAX_PER_RUN).filter((e) => !existing.has(e.path)).length,
    removed: plan.remove.length,
    unchanged: plan.unchanged,
    docs: fresh?.docs ?? 0,
    tasks: fresh?.tasks ?? 0,
    syncedAt: fresh?.synced_at ?? new Date().toISOString(),
  };
}

/** Primera vez: si nunca se sincronizó, hazlo ahora (el resto del tiempo se confía en el índice). */
export async function ensureIndexed(db: SupabaseClient, userId: string, env: VaultEnv): Promise<void> {
  if (!(await getSyncState(db, userId))) await syncIndex(db, userId, env, { force: true });
}

// --- Tareas ----------------------------------------------------------------------------------------
/** Lo que ve la pantalla de Tareas. `refresh` sincroniza antes si pasó más de un minuto. */
export async function tasksView(
  db: SupabaseClient,
  userId: string,
  env: VaultEnv,
  hoy: string,
  opts: { refresh?: boolean } = {},
): Promise<TasksView & { syncError: string | null; partial: boolean }> {
  let syncError: string | null = null;
  let partial = false; // vault grande: la primera sync llega por tandas; la UI sigue llamando a sync
  try {
    const state = await getSyncState(db, userId);
    if (!state) partial = (await syncIndex(db, userId, env, { force: true })).partial;
    else if (opts.refresh) partial = (await syncIndex(db, userId, env, { maxAgeMs: 60_000 })).partial;
  } catch (e) {
    // Con GitHub caído se muestra lo indexado, avisando que puede estar desactualizado.
    syncError = e instanceof Error ? e.message : "No pude sincronizar con GitHub";
    if (e instanceof VaultError && e.status >= 500 && e.status !== 502) throw e;
  }
  const [rows, folders, state] = await Promise.all([loadTaskRows(db, userId), knownFolders(db, userId), getSyncState(db, userId)]);
  return { ...buildTasksView(rows, env.config, folders, hoy, state?.synced_at ?? null), syncError, partial };
}

export type CreateInput = {
  text: unknown;
  folder?: unknown;
  level?: unknown;
  due?: unknown;
  shared?: unknown;
  note?: unknown;
};

async function destinationFor(db: SupabaseClient, userId: string, env: VaultEnv, folder: unknown): Promise<string> {
  const slug = folder === undefined || folder === null || folder === "" ? INBOX_FOLDER : folder;
  if (!isFolderSlug(slug)) throw new VaultError("Carpeta inválida", 400);
  const valid = listDestinations(env.config, await knownFolders(db, userId)).some((d) => d.folder === slug);
  if (!valid) throw new VaultError(`No conozco la carpeta «${slug}»`, 400);
  return slug;
}

function taskAt(write: FileWrite, line: number, env: VaultEnv, hoy: string): ViewTask | null {
  const row = rowsForFile(write.path, write.text, write.sha).tasks?.find((t) => t.line === line);
  return row ? toViewTask(row, env.config, hoy) : null;
}

export async function createTask(
  db: SupabaseClient,
  userId: string,
  env: VaultEnv,
  input: CreateInput,
  hoy: string,
): Promise<{ task: ViewTask | null; folder: string; label: string; due: string | null }> {
  if (typeof input.text !== "string" || !input.text.trim()) throw new VaultError("Falta el texto de la tarea", 400);
  const folder = await destinationFor(db, userId, env, input.folder);
  const info = classify(folder, env.config);

  let due: string | null = null;
  if (input.due !== undefined && input.due !== null && input.due !== "") {
    due = resolveDue(input.due, hoy);
    if (!due) throw new VaultError("No entendí la fecha", 400);
  }
  let level: Level | null = null;
  if (input.level !== undefined && input.level !== null && input.level !== "") {
    if (!isLevel(input.level)) throw new VaultError("Prioridad inválida (alto, medio o bajo)", 400);
    level = input.level;
  }
  const shared = typeof input.shared === "string" && input.shared.trim() ? input.shared : input.shared === true ? true : null;

  const res = await opCreateTask(github(env), {
    folder,
    label: info.frente ?? info.project,
    task: { text: input.text, level, due, shared, note: typeof input.note === "string" ? input.note : null },
  });
  await indexQuietly(db, userId, [res.write]);
  return { task: taskAt(res.write, res.line, env, hoy), folder, label: info.label, due };
}

export type StatusInput = { path: unknown; line: unknown; raw: unknown; status: unknown };

const asRef = (i: { line: unknown; raw: unknown }) => {
  if (!Number.isInteger(i.line) || typeof i.raw !== "string" || !i.raw) throw new VaultError("Falta la línea o el texto de la tarea", 400);
  return { line: i.line as number, raw: i.raw };
};

export async function setTaskStatus(
  db: SupabaseClient,
  userId: string,
  env: VaultEnv,
  input: StatusInput,
  hoy: string,
): Promise<{ task: ViewTask | null; changed: boolean }> {
  if (!isStatus(input.status)) throw new VaultError("Estado inválido", 400);
  const r = await opSetStatus(github(env), { path: input.path as string, ref: asRef(input), status: input.status as TaskStatus, today: hoy });
  await indexQuietly(db, userId, [r.write]);
  return { task: taskAt(r.write, r.line, env, hoy), changed: r.changed };
}

export async function moveTask(
  db: SupabaseClient,
  userId: string,
  env: VaultEnv,
  input: { path: unknown; line: unknown; raw: unknown; folder: unknown },
  hoy: string,
): Promise<{ task: ViewTask | null; label: string }> {
  if (input.folder === undefined || input.folder === null || input.folder === "") throw new VaultError("Falta la carpeta de destino", 400);
  const folder = await destinationFor(db, userId, env, input.folder);
  const info = classify(folder, env.config);
  try {
    const r = await opMoveTask(github(env), {
      path: input.path as string,
      ref: asRef(input),
      toFolder: folder,
      toLabel: info.frente ?? info.project,
    });
    await indexQuietly(db, userId, [r.dest, r.source]);
    return { task: taskAt(r.dest, r.destLine, env, hoy), label: info.label };
  } catch (e) {
    if (e instanceof PartialMoveError) await indexQuietly(db, userId, [e.dest]); // la copia ya existe: que se vea
    throw e;
  }
}

/** La escritura en GitHub ya ocurrió: si el índice falla no se le dice a David que fracasó; se sincroniza luego. */
async function indexQuietly(db: SupabaseClient, userId: string, writes: FileWrite[]): Promise<void> {
  try {
    await indexWrites(db, userId, writes);
  } catch (e) {
    console.error("vault: no pude indexar tras escribir:", e instanceof Error ? e.message : String(e));
  }
}

// --- Memoria ---------------------------------------------------------------------------------------
export type SearchInput = {
  q: unknown; cliente?: unknown; answer?: unknown; limit?: unknown;
  /** Rutas de fichas YA validadas contra el catálogo (resolverFichas): se leen completas en vez de buscar por palabras. */
  fichaPaths?: string[];
};
export type SearchResult = {
  q: string;
  answer: string | null;
  answerError: string | null;
  sources: Source[];
  related: Related[];
  clientes: ClienteChip[];
  indexed: number;
  /** Mensaje corto para la voz (solo si se pidió respuesta). */
  spoken: string | null;
};

const catalogoCache = new CatalogoCache();

/**
 * Catálogo de fichas para el contexto del agente. Se reutiliza mientras no cambie vault_sync.tree_sha: en el caso común
 * cuesta una consulta de una fila. Si la migración 015 (vault_catalogo) aún no está aplicada, arma el catálogo sin frases.
 */
export async function cargarCatalogo(db: SupabaseClient, userId: string): Promise<Catalogo> {
  const sha = (await getSyncState(db, userId))?.tree_sha ?? null;
  const cached = catalogoCache.get(userId, sha);
  if (cached) return cached;
  let rows: CatalogoRow[];
  const rpc = await db.rpc("vault_catalogo");
  if (!rpc.error) {
    rows = (rpc.data ?? []) as CatalogoRow[];
  } else {
    console.error("vault: vault_catalogo no disponible, catálogo sin frases:", rpc.error.message);
    rows = await selectAll<CatalogoRow>((from, to) =>
      db.from("vault_docs").select("path, title, cliente, proyecto").eq("user_id", userId).eq("kind", "ficha").order("path").range(from, to)
    );
  }
  const cat = armarCatalogo(rows);
  catalogoCache.set(userId, sha, cat);
  return cat;
}

type FichaDoc = { path: string; title: string; cliente: string | null; proyecto: string | null; padre: string | null; tags: string[] | null; links: string[] | null; content: string | null };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function searchMemory(db: SupabaseClient, userId: string, input: SearchInput): Promise<SearchResult> {
  const q = typeof input.q === "string" ? input.q.trim().slice(0, 300) : "";
  const cliente = typeof input.cliente === "string" && input.cliente.trim() ? input.cliente.trim() : null;
  const wantAnswer = input.answer === true;
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit as number, 1), 12) : 8;

  // Una sola lectura liviana (≈100 filas) sirve para los chips, el conteo y resolver los relacionados.
  const catalogP = selectAll<{ path: string; title: string; cliente: string | null; proyecto: string | null; padre: string | null; kind: string }>(
    (from, to) =>
      db.from("vault_docs").select("path, title, cliente, proyecto, padre, kind").eq("user_id", userId).in("kind", ["ficha", "nota"])
        .order("path").range(from, to),
  );

  // Fichas que eligió la IA: se leen completas (solo fichas del usuario, aunque la ruta no viniera validada). Las notas
  // sueltas siguen buscándose por palabras como complemento.
  const fichaPaths = [...new Set((input.fichaPaths ?? []).filter((p): p is string => typeof p === "string"))].slice(0, 2);
  const fichasP: PromiseLike<FichaDoc[]> = fichaPaths.length
    ? db.from("vault_docs").select("path, title, cliente, proyecto, padre, tags, links, content").eq("user_id", userId).eq("kind", "ficha").in("path", fichaPaths)
        .then(({ data, error }) => {
          if (error) throw new VaultError(`No pude leer las fichas: ${error.message}`, 500);
          const rows = (data ?? []) as FichaDoc[];
          return fichaPaths.flatMap((p) => rows.filter((d) => d.path === p)); // en el orden en que se eligieron
        })
    : Promise.resolve([]);

  // Primero se leen las fichas: si ninguna existe (catálogo cacheado con una ficha ya borrada), la búsqueda por palabras
  // vuelve a cubrir fichas y notas en vez de quedarse solo con notas.
  const completos: Record<string, string> = {};
  const fichaDocs = await fichasP;
  const fichaHits: Hit[] = fichaDocs.map((d) => {
    completos[d.path] = recortarFicha(d.content ?? "", topePorFicha(fichaDocs.length), q);
    return { path: d.path, kind: "ficha", title: d.title, cliente: d.cliente, proyecto: d.proyecto, padre: d.padre, tags: d.tags ?? [], links: d.links ?? [], score: 1, snippet: "", context: null };
  });

  let hits: Hit[] = [];
  if (q) {
    const busca = parametrosBusqueda(fichaHits.length, limit);
    const { data, error } = await db.rpc("vault_search", { p_query: q, p_cliente: cliente, p_kinds: busca.kinds, p_limit: busca.limit, p_context: wantAnswer });
    if (error) throw new VaultError(`No pude buscar en el vault: ${error.message}`, 500);
    hits = (data ?? []) as Hit[];
  }
  hits = [...fichaHits, ...hits];
  const catalog = await catalogP;
  const clientes = clienteChips(catalog);
  const base = { q, clientes, indexed: catalog.length };
  if (!hits.length) return { ...base, answer: null, answerError: null, sources: [], related: [], spoken: null };

  // Relacionados: fichas enlazadas desde la mejor coincidencia (wikilinks y padre) y luego el resto de coincidencias.
  const top = hits[0];
  const names = new Set([...top.links, top.padre ?? "", top.proyecto ?? ""].map((s) => s.toLowerCase()).filter(Boolean));
  const linked: RelatedRow[] = catalog.filter((d) =>
    d.kind === "ficha" && d.path !== top.path &&
    ((d.proyecto && names.has(d.proyecto.toLowerCase())) || (d.padre && top.proyecto && d.padre.toLowerCase() === top.proyecto.toLowerCase()))
  );

  let answer: string | null = null;
  let answerError: string | null = null;
  let spoken: string | null = null;
  let shown = hits;
  if (wantAnswer) {
    const fuentes = hits.slice(0, fichaHits.length ? fichaHits.length + 2 : 4);
    if (!llmConfigured()) {
      answerError = "El modelo no está configurado.";
    } else {
      try {
        const res = await withTimeout(llmFetch({ messages: buildAnswerMessages(q, fuentes, completos), temperature: 0.1, max_tokens: 260 }), 12_000);
        if (!res.ok) throw new Error(`modelo ${res.status}`);
        const data = await res.json();
        const parsed = parseAnswer(String(data?.choices?.[0]?.message?.content ?? ""), fuentes.length);
        if (!parsed) throw new Error("respuesta vacía");
        answer = parsed.answer;
        // Las fuentes que respaldan la respuesta; si el modelo no las nombró, las dos mejores.
        const usadas = parsed.found ? (parsed.used.length ? parsed.used.map((n) => fuentes[n - 1]) : fuentes.slice(0, 2)) : fuentes;
        shown = usadas;
        spoken = parsed.found ? mensajeMemoria(parsed.answer, usadas[0]?.title ?? null) : mensajeMemoria(parsed.answer, null);
      } catch (e) {
        console.error("vault: no pude redactar la respuesta:", e instanceof Error ? e.message : String(e));
        answerError = "No pude redactar la respuesta; estas son las fichas encontradas.";
      }
    }
  }

  const related = pickRelated({
    linked,
    rest: hits.filter((h) => !shown.includes(h)),
    exclude: new Set(shown.map((h) => h.path)),
  });
  return { ...base, answer, answerError, sources: toSources(shown), related, spoken };
}
