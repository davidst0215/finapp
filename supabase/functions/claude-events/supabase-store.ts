// Implementación de `Store` sobre Supabase (PostgREST) con el cliente de servicio.
// El cliente de servicio salta RLS, así que el aislamiento entre usuarios vive aquí: cada consulta lleva
// su filtro de user_id (el puerto obliga a pasarlo). Las transiciones de aprobaciones son un solo UPDATE
// condicional, no leer-y-escribir.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Cutoffs, ExpireScope, NewApproval, NewDevice, NewEvent, NewMessage, NewTask, Store, TaskPatch } from "./store.ts";
import type { ApprovalRow, ApprovalStatus, DeviceRow, EventRow, MessageRow, SessionRow, TaskRow, TaskStatus } from "./types.ts";

type Result<T> = { data: T; error: { message: string } | null };

function must<T>(res: Result<T>, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

// UPDATE ... RETURNING se pide como arreglo (no .maybeSingle()): con 0 filas el resultado es [] en cualquier versión
// de postgrest-js, sin depender de cómo traduzca el 406 de PostgREST.
function first<T>(res: Result<T[] | null>, what: string): T | null {
  return must(res, what)?.[0] ?? null;
}

export function createSupabaseStore(db: SupabaseClient): Store {
  return {
    // --- Dispositivos
    async findDevice(deviceId) {
      const res = await db.from("claude_devices").select("*").eq("device_id", deviceId).maybeSingle();
      return must(res, "findDevice") as DeviceRow | null;
    },

    async insertDevice(row: NewDevice) {
      const res = await db.from("claude_devices").insert(row).select("*").single();
      return must(res, "insertDevice") as DeviceRow;
    },

    async listDevices(userId) {
      const res = await db
        .from("claude_devices")
        .select("*")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .order("created_at", { ascending: true });
      return must(res, "listDevices") as DeviceRow[];
    },

    async patchDevice(userId, deviceId, patch) {
      const res = await db
        .from("claude_devices")
        .update(patch)
        .eq("device_id", deviceId)
        .eq("user_id", userId)
        .is("revoked_at", null)
        .select("*");
      return first(res as Result<DeviceRow[] | null>, "patchDevice");
    },

    async revokeDevice(userId, deviceId, atIso) {
      const res = await db
        .from("claude_devices")
        .update({ revoked_at: atIso, approvals_enabled: false })
        .eq("device_id", deviceId)
        .eq("user_id", userId)
        .is("revoked_at", null)
        .select("*");
      return first(res as Result<DeviceRow[] | null>, "revokeDevice");
    },

    async touchDevice(deviceId, atIso) {
      must(await db.from("claude_devices").update({ last_seen_at: atIso }).eq("device_id", deviceId), "touchDevice");
    },

    // --- Sesiones y eventos
    async getSession(userId, sessionId) {
      const res = await db.from("claude_sessions").select("*").eq("user_id", userId).eq("session_id", sessionId).maybeSingle();
      return must(res, "getSession") as SessionRow | null;
    },

    async saveSession(row: SessionRow) {
      must(await db.from("claude_sessions").upsert(row, { onConflict: "user_id,session_id" }), "saveSession");
    },

    async insertEvent(row: NewEvent) {
      must(await db.from("claude_events").insert(row), "insertEvent");
    },

    async touchSessionPreview(userId, sessionId, summary, role) {
      must(
        await db.from("claude_sessions").update({ last_summary: summary, last_role: role }).eq("user_id", userId).eq("session_id", sessionId),
        "touchSessionPreview",
      );
    },

    async countSessionsSince(deviceId, sinceIso) {
      const res = await db
        .from("claude_sessions")
        .select("session_id", { count: "exact", head: true })
        .eq("device_id", deviceId)
        .gte("started_at", sinceIso);
      if (res.error) throw new Error(`countSessionsSince: ${res.error.message}`);
      return res.count ?? 0;
    },

    async countEventsSince(deviceId, sinceIso, kinds) {
      let q = db
        .from("claude_events")
        .select("event_id", { count: "exact", head: true })
        .eq("device_id", deviceId)
        .gte("created_at", sinceIso);
      if (kinds) q = q.in("kind", kinds);
      const res = await q;
      if (res.error) throw new Error(`countEventsSince: ${res.error.message}`);
      return res.count ?? 0;
    },

    async listSessions(userId, limit) {
      const res = await db
        .from("claude_sessions")
        .select("*")
        .eq("user_id", userId)
        .order("last_event_at", { ascending: false })
        .limit(limit);
      return must(res, "listSessions") as SessionRow[];
    },

    async listEvents(userId, sessionId, limit) {
      const res = await db
        .from("claude_events")
        .select("*")
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return must(res, "listEvents") as EventRow[];
    },

    async prune(userId, cutoffs: Cutoffs) {
      // Borrar la sesión arrastra sus eventos y aprobaciones (ON DELETE CASCADE).
      must(await db.from("claude_sessions").delete().eq("user_id", userId).lt("last_event_at", cutoffs.sessions), "prune sessions");
      must(await db.from("claude_events").delete().eq("user_id", userId).lt("created_at", cutoffs.events), "prune events");
      must(
        await db.from("claude_approvals").delete().eq("user_id", userId).neq("status", "pendiente").lt("created_at", cutoffs.approvals),
        "prune approvals",
      );
      if (cutoffs.messages) {
        must(await db.from("claude_messages").delete().eq("user_id", userId).in("status", ["entregado", "vencido", "no_retomado"]).lt("created_at", cutoffs.messages), "prune messages");
      }
      if (cutoffs.tasks) {
        must(await db.from("claude_tasks").delete().eq("user_id", userId).not("finished_at", "is", null).lt("finished_at", cutoffs.tasks), "prune tasks");
      }
    },

    // --- Aprobaciones
    async countPending(userId, nowIso, scope = {}) {
      let q = db
        .from("claude_approvals")
        .select("approval_id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "pendiente")
        .gt("expires_at", nowIso);
      if (scope.sessionId !== undefined) q = q.eq("session_id", scope.sessionId);
      if (scope.deviceId !== undefined) q = q.eq("device_id", scope.deviceId);
      const res = await q;
      if (res.error) throw new Error(`countPending: ${res.error.message}`);
      return res.count ?? 0;
    },

    async insertApproval(row: NewApproval) {
      const res = await db.from("claude_approvals").insert(row).select("*").single();
      return must(res, "insertApproval") as ApprovalRow;
    },

    async findApproval(userId, approvalId) {
      const res = await db.from("claude_approvals").select("*").eq("approval_id", approvalId).eq("user_id", userId).maybeSingle();
      return must(res, "findApproval") as ApprovalRow | null;
    },

    async listApprovals(userId, opts: { statuses: ApprovalStatus[]; sinceIso?: string; limit: number }) {
      let q = db.from("claude_approvals").select("*").eq("user_id", userId).in("status", opts.statuses);
      if (opts.sinceIso) q = q.gte("created_at", opts.sinceIso);
      const res = await q.order("created_at", { ascending: false }).limit(opts.limit);
      return must(res, "listApprovals") as ApprovalRow[];
    },

    async listSessionApprovals(userId, sessionId, limit) {
      const res = await db
        .from("claude_approvals")
        .select("*")
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return must(res, "listSessionApprovals") as ApprovalRow[];
    },

    async decideApproval(userId, approvalId, status, byUserId, nowIso) {
      const res = await db
        .from("claude_approvals")
        .update({ status, decided_at: nowIso, decided_by: byUserId })
        .eq("approval_id", approvalId)
        .eq("user_id", userId)
        .eq("status", "pendiente")
        .gt("expires_at", nowIso)
        .select("*");
      return first(res as Result<ApprovalRow[] | null>, "decideApproval");
    },

    async expireApprovals(userId, nowIso, scope: ExpireScope = {}) {
      let q = db
        .from("claude_approvals")
        .update({ status: "vencida", decided_at: nowIso })
        .eq("user_id", userId)
        .eq("status", "pendiente");
      if (scope.deviceId) q = q.eq("device_id", scope.deviceId);
      if (scope.sessionId) q = q.eq("session_id", scope.sessionId);
      if (!scope.all) q = q.lte("expires_at", nowIso);
      must(await q, "expireApprovals");
    },

    // --- v2 (012): runner y mensajes
    async setRunnerState(deviceId, projects, atIso) {
      must(await db.from("claude_devices").update({ runner_projects: projects, runner_seen_at: atIso }).eq("device_id", deviceId), "setRunnerState");
    },

    async countQueuedMessages(userId, sessionId, nowIso) {
      const res = await db
        .from("claude_messages")
        .select("message_id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .in("status", ["en_cola", "entregando"])
        .gt("expires_at", nowIso);
      if (res.error) throw new Error(`countQueuedMessages: ${res.error.message}`);
      return res.count ?? 0;
    },

    async insertMessage(row: NewMessage) {
      const res = await db.from("claude_messages").insert(row).select("*").single();
      return must(res, "insertMessage") as MessageRow;
    },

    async claimNextMessage(userId, sessionId, nowIso) {
      // Leer el más antiguo y reclamarlo con un UPDATE condicional (status = 'en_cola'): si dos Stop compiten,
      // solo uno recibe fila de vuelta y el otro reintenta con el siguiente. El texto se borra en esa misma sentencia.
      for (let attempt = 0; attempt < 3; attempt++) {
        const found = await db
          .from("claude_messages")
          .select("message_id, body")
          .eq("user_id", userId)
          .eq("session_id", sessionId)
          .eq("status", "en_cola")
          .gt("expires_at", nowIso)
          .order("created_at", { ascending: true })
          .limit(1);
        const candidate = must(found as Result<{ message_id: string; body: string | null }[] | null>, "claimNextMessage")?.[0];
        if (!candidate || candidate.body === null) return null;
        const won = await db
          .from("claude_messages")
          .update({ status: "entregando", claimed_at: nowIso })
          .eq("message_id", candidate.message_id)
          .eq("user_id", userId)
          .eq("status", "en_cola")
          .select("message_id");
        if (first(won as Result<{ message_id: string }[] | null>, "claimNextMessage")) return { messageId: candidate.message_id, text: candidate.body };
      }
      return null;
    },

    async ackMessage(userId, messageId, deviceId, nowIso) {
      const res = await db
        .from("claude_messages")
        .update({ status: "entregado", claimed_at: null, delivered_at: nowIso })
        .eq("message_id", messageId)
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .eq("status", "entregando")
        .select("message_id");
      return first(res as Result<{ message_id: string }[] | null>, "ackMessage") !== null;
    },

    async requeueStaleMessages(userId, olderThanIso) {
      must(
        await db.from("claude_messages").update({ status: "en_cola", claimed_at: null }).eq("user_id", userId).eq("status", "entregando").lt("claimed_at", olderThanIso),
        "requeueStaleMessages",
      );
    },

    async expireMessages(userId, nowIso) {
      must(
        await db
          .from("claude_messages")
          .update({ status: "vencido", body: null, claimed_at: null })
          .eq("user_id", userId)
          .in("status", ["en_cola", "entregando"])
          .lte("expires_at", nowIso),
        "expireMessages",
      );
    },

    async listMessages(userId, limit) {
      // Sin `body`: el texto nunca sale de la base hacia la app.
      const res = await db
        .from("claude_messages")
        .select("message_id, user_id, session_id, device_id, status, created_at, expires_at, claimed_at, delivered_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return (must(res, "listMessages") as Omit<MessageRow, "body">[]).map((m) => ({ ...m, body: null }));
    },

    async listSessionMessages(userId, sessionId, limit) {
      // Con texto (013). Solo lo llama la línea de tiempo de la sesión, con el cliente de servicio.
      const res = await db
        .from("claude_messages")
        .select("*")
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return must(res, "listSessionMessages") as MessageRow[];
    },

    // --- 014: retomar
    async listStalledMessages(userId, deviceId, olderThanIso, nowIso, limit) {
      const res = await db
        .from("claude_messages")
        .select("*")
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .eq("status", "en_cola")
        .lte("created_at", olderThanIso)
        .gt("expires_at", nowIso)
        .not("body", "is", null)
        .order("created_at", { ascending: true })
        .limit(limit);
      return must(res, "listStalledMessages") as MessageRow[];
    },

    async claimMessageForResume(userId, messageId, taskId, nowIso) {
      // UPDATE condicional: solo uno gana entre el hook Stop (en_cola -> entregando) y este reclamo (en_cola -> retomando).
      const res = await db
        .from("claude_messages")
        .update({ status: "retomando", resume_task_id: taskId, resume_claimed_at: nowIso })
        .eq("message_id", messageId)
        .eq("user_id", userId)
        .eq("status", "en_cola")
        .select("message_id");
      return first(res as Result<{ message_id: string }[] | null>, "claimMessageForResume") !== null;
    },

    async releaseResumeMessages(userId, taskId) {
      must(
        await db.from("claude_messages").update({ status: "en_cola", resume_task_id: null, resume_claimed_at: null }).eq("user_id", userId).eq("status", "retomando").eq("resume_task_id", taskId),
        "releaseResumeMessages",
      );
    },

    async settleResumeMessages(userId, taskId, outcome) {
      const patch = outcome.ok
        ? { status: "entregado", delivered_at: outcome.atIso, ...(outcome.error ? { error: outcome.error } : {}) }
        : { status: "no_retomado", error: outcome.error };
      must(await db.from("claude_messages").update(patch).eq("user_id", userId).eq("status", "retomando").eq("resume_task_id", taskId), "settleResumeMessages");
    },

    async listStaleResumeMessages(userId, claimedBeforeIso) {
      const res = await db
        .from("claude_messages")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "retomando")
        .lt("resume_claimed_at", claimedBeforeIso);
      return must(res, "listStaleResumeMessages") as MessageRow[];
    },

    // --- v2 (012): tareas
    async countQueuedTasks(userId, nowIso) {
      const res = await db
        .from("claude_tasks")
        .select("task_id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "en_cola")
        .gt("expires_at", nowIso);
      if (res.error) throw new Error(`countQueuedTasks: ${res.error.message}`);
      return res.count ?? 0;
    },

    async insertTask(row: NewTask) {
      const res = await db.from("claude_tasks").insert({ ...row, updated_at: row.created_at }).select("*").single();
      return must(res, "insertTask") as TaskRow;
    },

    async findTask(userId, taskId) {
      const res = await db.from("claude_tasks").select("*").eq("task_id", taskId).eq("user_id", userId).maybeSingle();
      return must(res, "findTask") as TaskRow | null;
    },

    async listTasks(userId, limit) {
      const res = await db.from("claude_tasks").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
      return must(res, "listTasks") as TaskRow[];
    },

    async claimNextTask(userId, deviceId, nowIso) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const found = await db
          .from("claude_tasks")
          .select("task_id")
          .eq("user_id", userId)
          .eq("device_id", deviceId)
          .eq("status", "en_cola")
          .gt("expires_at", nowIso)
          .order("created_at", { ascending: true })
          .limit(1);
        const candidate = must(found as Result<{ task_id: string }[] | null>, "claimNextTask")?.[0];
        if (!candidate) return null;
        const won = await db
          .from("claude_tasks")
          .update({ status: "ejecutando", started_at: nowIso, updated_at: nowIso })
          .eq("task_id", candidate.task_id)
          .eq("user_id", userId)
          .eq("status", "en_cola")
          .select("*");
        // 23505: el índice único parcial (una tarea 'ejecutando' por dispositivo) dice que ya hay una en marcha.
        if ((won as { error: { code?: string } | null }).error?.code === "23505") return null;
        const row = first(won as Result<TaskRow[] | null>, "claimNextTask");
        if (row) return row;
      }
      return null;
    },

    async updateTask(userId, taskId, patch: TaskPatch, onlyIfStatus: TaskStatus[]) {
      const res = await db.from("claude_tasks").update(patch).eq("task_id", taskId).eq("user_id", userId).in("status", onlyIfStatus).select("*");
      return first(res as Result<TaskRow[] | null>, "updateTask");
    },

    async sweepTasks(userId, deviceId, nowIso, staleIso) {
      const expired = await db
        .from("claude_tasks")
        .update({ status: "vencida", finished_at: nowIso, updated_at: nowIso })
        .eq("user_id", userId)
        .eq("status", "en_cola")
        .lte("expires_at", nowIso)
        .select("*");
      const stale = await db
        .from("claude_tasks")
        .update({ status: "fallida", error: "El runner dejó de responder", finished_at: nowIso, updated_at: nowIso })
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .eq("status", "ejecutando")
        .lt("updated_at", staleIso)
        .select("*");
      return [
        ...(must(expired as Result<TaskRow[] | null>, "sweepTasks vencidas") ?? []),
        ...(must(stale as Result<TaskRow[] | null>, "sweepTasks sin latido") ?? []),
      ];
    },
  };
}
