// Implementación de `Store` sobre Supabase (PostgREST) con el cliente de servicio.
// El cliente de servicio salta RLS, así que el aislamiento entre usuarios vive aquí: cada consulta lleva
// su filtro de user_id (el puerto obliga a pasarlo). Las transiciones de aprobaciones son un solo UPDATE
// condicional, no leer-y-escribir.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Cutoffs, ExpireScope, NewApproval, NewDevice, NewEvent, Store } from "./store.ts";
import type { ApprovalRow, ApprovalStatus, DeviceRow, EventRow, SessionRow } from "./types.ts";

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
  };
}
