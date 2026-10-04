// Edge function `vault`: sincroniza el índice del vault (GitHub → Postgres) y atiende Tareas y Buscar.
//
// POST con cuerpo JSON { action, ... }. Siempre con la sesión de David (JWT); `sync` también acepta la cabecera
// x-vault-secret (cron sin sesión). Todas las escrituras van primero a GitHub y luego al índice.
//
//   sync         { force? }                             → { ok, skipped, added, updated, removed, unchanged, docs, tasks, syncedAt }
//   tasks        { refresh? }                           → TasksView (grupos Proyecto › Frente, cajón, contadores, destinos)
//   task.create  { text, folder?, level?, due?, shared?, note? }  → { ok, task }
//   task.status  { path, line, raw, status }            → { ok, task, changed }
//   task.move    { path, line, raw, folder }            → { ok, task }
//   search       { q, cliente?, answer?, limit? }       → { q, answer, answerError, sources, related, clientes, indexed }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, json, limaNow, preflight, requireUser } from "../_shared/http.ts";
import {
  assertOwner, createTask, GitHubError, moveTask, PartialMoveError, searchMemory, setTaskStatus, syncIndex, TaskNotFoundError,
  tasksView, VaultError, vaultEnv,
} from "../_shared/vault.ts";
import { GitHubConflict } from "../_shared/vault/github.ts";

/** Compara en tiempo constante (el largo sí puede filtrarse; el contenido no). */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function fail(e: unknown): Response {
  if (e instanceof VaultError) return json({ error: e.message }, e.status);
  if (e instanceof TaskNotFoundError) return json({ error: e.message }, 409);
  if (e instanceof PartialMoveError) return json({ error: e.message, partial: true }, 502);
  if (e instanceof GitHubConflict) return json({ error: "El vault cambió mientras escribía; inténtalo de nuevo." }, 409);
  if (e instanceof GitHubError) return json({ error: e.message }, e.status === 429 ? 429 : 502);
  console.error("vault:", e instanceof Error ? e.message : String(e));
  return json({ error: "Error interno del vault" }, 500);
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return json({ error: "Cuerpo inválido: se espera JSON" }, 400);
    }
    const action = typeof body.action === "string" ? body.action : "";

    // 1) Quién llama. Cron: secreto propio, solo para sincronizar (a nombre del dueño). Usuario: su JWT, y solo David.
    let db: SupabaseClient;
    let caller: string | null = null; // null = cron con secreto válido
    const secret = req.headers.get("x-vault-secret");
    if (secret) {
      const expected = Deno.env.get("VAULT_SYNC_SECRET");
      if (action !== "sync" || !expected || !safeEqual(secret, expected)) return json({ error: "No autorizado" }, 401);
      db = adminClient();
    } else {
      const auth = await requireUser(req);
      if (auth instanceof Response) return auth;
      db = auth.db;
      caller = auth.user.id;
    }
    const env = vaultEnv();
    const userId = caller ?? env.ownerId;
    assertOwner(userId, env);
    const hoy = limaNow().toISOString().slice(0, 10);

    // 2) Acción.
    switch (action) {
      case "sync": {
        const r = await syncIndex(db, userId, env, { force: body.force === true });
        return json({ ok: true, ...r });
      }
      case "tasks":
        return json(await tasksView(db, userId, env, hoy, { refresh: body.refresh === true }));
      case "task.create": {
        const r = await createTask(db, userId, env, {
          text: body.text, folder: body.folder, level: body.level, due: body.due, shared: body.shared, note: body.note,
        }, hoy);
        return json({ ok: true, task: r.task });
      }
      case "task.status": {
        const r = await setTaskStatus(db, userId, env, { path: body.path, line: body.line, raw: body.raw, status: body.status }, hoy);
        return json({ ok: true, task: r.task, changed: r.changed });
      }
      case "task.move": {
        const r = await moveTask(db, userId, env, { path: body.path, line: body.line, raw: body.raw, folder: body.folder }, hoy);
        return json({ ok: true, task: r.task });
      }
      case "search":
        return json(await searchMemory(db, userId, { q: body.q, cliente: body.cliente, answer: body.answer, limit: body.limit }));
      default:
        return json({ error: "Acción desconocida" }, 400);
    }
  } catch (e) {
    return fail(e);
  }
});
