// Almacén en memoria con la misma semántica que la base (llaves foráneas, transiciones atómicas, filtro por
// usuario). Solo se usa en pruebas: index.ts nunca lo importa, así que no viaja en el despliegue.

import type { Cutoffs, ExpireScope, NewApproval, NewDevice, NewEvent, NewMessage, NewTask, Store, TaskPatch } from "./store.ts";
import type { ApprovalRow, ApprovalStatus, DeviceRow, EventKind, EventRow, MessageRow, SessionRow, TaskRow, TaskStatus } from "./types.ts";

const sessionKey = (userId: string, sessionId: string) => `${userId}|${sessionId}`;

export class MemoryStore implements Store {
  devices = new Map<string, DeviceRow>();
  sessions = new Map<string, SessionRow>();
  events: EventRow[] = [];
  approvals = new Map<string, ApprovalRow>();
  messages = new Map<string, MessageRow>();
  tasks = new Map<string, TaskRow>();
  /** Reloj de las filas que la base fecharía con NOW() (created_at del dispositivo). */
  clock: () => string = () => new Date().toISOString();

  // --- Dispositivos
  async findDevice(deviceId: string) {
    const d = this.devices.get(deviceId);
    return d ? { ...d } : null;
  }

  async insertDevice(row: NewDevice) {
    const d: DeviceRow = { ...row, approvals_enabled: false, created_at: this.clock(), last_seen_at: null, revoked_at: null, runner_projects: [], runner_seen_at: null };
    this.devices.set(d.device_id, d);
    return { ...d };
  }

  async listDevices(userId: string) {
    return [...this.devices.values()]
      .filter((d) => d.user_id === userId && !d.revoked_at)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((d) => ({ ...d }));
  }

  async patchDevice(userId: string, deviceId: string, patch: { name?: string; approvals_enabled?: boolean }) {
    const d = this.devices.get(deviceId);
    if (!d || d.user_id !== userId || d.revoked_at) return null;
    if (patch.name !== undefined) d.name = patch.name;
    if (patch.approvals_enabled !== undefined) d.approvals_enabled = patch.approvals_enabled;
    return { ...d };
  }

  async revokeDevice(userId: string, deviceId: string, atIso: string) {
    const d = this.devices.get(deviceId);
    if (!d || d.user_id !== userId || d.revoked_at) return null;
    d.revoked_at = atIso;
    d.approvals_enabled = false;
    return { ...d };
  }

  async touchDevice(deviceId: string, atIso: string) {
    const d = this.devices.get(deviceId);
    if (d) d.last_seen_at = atIso;
  }

  // --- Sesiones y eventos
  async getSession(userId: string, sessionId: string) {
    const s = this.sessions.get(sessionKey(userId, sessionId));
    return s ? { ...s } : null;
  }

  async saveSession(row: SessionRow) {
    if (!this.devices.has(row.device_id)) throw new Error("FK: el dispositivo no existe");
    this.sessions.set(sessionKey(row.user_id, row.session_id), { ...row });
  }

  async insertEvent(row: NewEvent) {
    if (!this.sessions.has(sessionKey(row.user_id, row.session_id))) throw new Error("FK: la sesión no existe");
    this.events.push({ ...row, event_id: crypto.randomUUID() });
  }

  async countEventsSince(deviceId: string, sinceIso: string, kinds?: EventKind[]) {
    return this.events.filter((e) => e.device_id === deviceId && e.created_at >= sinceIso && (!kinds || kinds.includes(e.kind))).length;
  }

  async countSessionsSince(deviceId: string, sinceIso: string) {
    return [...this.sessions.values()].filter((s) => s.device_id === deviceId && s.started_at >= sinceIso).length;
  }

  async listSessions(userId: string, limit: number) {
    return [...this.sessions.values()]
      .filter((s) => s.user_id === userId)
      .sort((a, b) => b.last_event_at.localeCompare(a.last_event_at))
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }

  async touchSessionPreview(userId: string, sessionId: string, summary: string, role: "usuario" | "claude") {
    const s = this.sessions.get(sessionKey(userId, sessionId));
    if (s) {
      s.last_summary = summary;
      s.last_role = role;
    }
  }

  async listEvents(userId: string, sessionId: string, limit: number) {
    return this.events
      .filter((e) => e.user_id === userId && e.session_id === sessionId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async prune(userId: string, cutoffs: Cutoffs) {
    for (const [key, s] of this.sessions) {
      if (s.user_id === userId && s.last_event_at < cutoffs.sessions) {
        this.sessions.delete(key);
        this.events = this.events.filter((e) => !(e.user_id === userId && e.session_id === s.session_id));
        for (const [id, a] of this.approvals) if (a.user_id === userId && a.session_id === s.session_id) this.approvals.delete(id);
        for (const [id, m] of this.messages) if (m.user_id === userId && m.session_id === s.session_id) this.messages.delete(id);
      }
    }
    if (cutoffs.messages) {
      for (const [id, m] of this.messages) if (m.user_id === userId && m.status !== "en_cola" && m.status !== "entregando" && m.created_at < cutoffs.messages) this.messages.delete(id);
    }
    if (cutoffs.tasks) {
      for (const [id, t] of this.tasks) if (t.user_id === userId && t.finished_at !== null && t.finished_at < cutoffs.tasks) this.tasks.delete(id);
    }
    this.events = this.events.filter((e) => !(e.user_id === userId && e.created_at < cutoffs.events));
    for (const [id, a] of this.approvals) {
      if (a.user_id === userId && a.status !== "pendiente" && a.created_at < cutoffs.approvals) this.approvals.delete(id);
    }
  }

  // --- Aprobaciones
  async countPending(userId: string, nowIso: string, scope: { deviceId?: string; sessionId?: string } = {}) {
    return [...this.approvals.values()].filter(
      (a) =>
        a.user_id === userId && a.status === "pendiente" && a.expires_at > nowIso &&
        (scope.sessionId === undefined || a.session_id === scope.sessionId) &&
        (scope.deviceId === undefined || a.device_id === scope.deviceId),
    ).length;
  }

  async insertApproval(row: NewApproval) {
    if (!this.sessions.has(sessionKey(row.user_id, row.session_id))) throw new Error("FK: la sesión no existe");
    const a: ApprovalRow = { ...row, status: "pendiente", decided_at: null, decided_by: null };
    this.approvals.set(a.approval_id, a);
    return { ...a };
  }

  async findApproval(userId: string, approvalId: string) {
    const a = this.approvals.get(approvalId);
    return a && a.user_id === userId ? { ...a } : null;
  }

  async listApprovals(userId: string, opts: { statuses: ApprovalStatus[]; sinceIso?: string; limit: number }) {
    return [...this.approvals.values()]
      .filter((a) => a.user_id === userId && opts.statuses.includes(a.status) && (!opts.sinceIso || a.created_at >= opts.sinceIso))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, opts.limit)
      .map((a) => ({ ...a }));
  }

  async listSessionApprovals(userId: string, sessionId: string, limit: number) {
    return [...this.approvals.values()]
      .filter((a) => a.user_id === userId && a.session_id === sessionId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((a) => ({ ...a }));
  }

  async decideApproval(userId: string, approvalId: string, status: "aprobada" | "denegada", byUserId: string, nowIso: string) {
    const a = this.approvals.get(approvalId);
    if (!a || a.user_id !== userId || a.status !== "pendiente" || a.expires_at <= nowIso) return null;
    a.status = status;
    a.decided_at = nowIso;
    a.decided_by = byUserId;
    return { ...a };
  }

  async expireApprovals(userId: string, nowIso: string, scope: ExpireScope = {}) {
    for (const a of this.approvals.values()) {
      if (a.user_id !== userId || a.status !== "pendiente") continue;
      if (scope.deviceId && a.device_id !== scope.deviceId) continue;
      if (scope.sessionId && a.session_id !== scope.sessionId) continue;
      if (!scope.all && a.expires_at > nowIso) continue;
      a.status = "vencida";
      a.decided_at = nowIso;
    }
  }

  // --- v2: runner y mensajes
  async setRunnerState(deviceId: string, projects: string[], atIso: string) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.runner_projects = [...projects];
    d.runner_seen_at = atIso;
  }

  async countQueuedMessages(userId: string, sessionId: string, nowIso: string) {
    return [...this.messages.values()].filter(
      (m) => m.user_id === userId && m.session_id === sessionId && (m.status === "en_cola" || m.status === "entregando") && m.expires_at > nowIso,
    ).length;
  }

  async insertMessage(row: NewMessage) {
    if (!this.sessions.has(sessionKey(row.user_id, row.session_id))) throw new Error("FK: la sesión no existe");
    const m: MessageRow = { ...row, status: "en_cola", claimed_at: null, delivered_at: null };
    this.messages.set(m.message_id, m);
    return { ...m };
  }

  async claimNextMessage(userId: string, sessionId: string, nowIso: string) {
    const next = [...this.messages.values()]
      .filter((m) => m.user_id === userId && m.session_id === sessionId && m.status === "en_cola" && m.expires_at > nowIso)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!next || next.body === null) return null;
    // Transición atómica (en memoria, sin await entre leer y escribir): entregando; el texto queda hasta el ack.
    next.status = "entregando";
    next.claimed_at = nowIso;
    return { messageId: next.message_id, text: next.body };
  }

  async ackMessage(userId: string, messageId: string, deviceId: string, nowIso: string) {
    const m = this.messages.get(messageId);
    if (!m || m.user_id !== userId || m.device_id !== deviceId || m.status !== "entregando") return false;
    m.status = "entregado";
    m.claimed_at = null;
    m.delivered_at = nowIso;
    return true;
  }

  async requeueStaleMessages(userId: string, olderThanIso: string) {
    for (const m of this.messages.values()) {
      if (m.user_id === userId && m.status === "entregando" && m.claimed_at !== null && m.claimed_at < olderThanIso) {
        m.status = "en_cola";
        m.claimed_at = null;
      }
    }
  }

  async expireMessages(userId: string, nowIso: string) {
    for (const m of this.messages.values()) {
      if (m.user_id === userId && (m.status === "en_cola" || m.status === "entregando") && m.expires_at <= nowIso) {
        m.claimed_at = null;
        m.status = "vencido";
        m.body = null;
      }
    }
  }

  async listMessages(userId: string, limit: number) {
    return [...this.messages.values()]
      .filter((m) => m.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((m) => ({ ...m, body: null })); // el contrato: el texto nunca sale de aquí
  }

  async listSessionMessages(userId: string, sessionId: string, limit: number) {
    return [...this.messages.values()]
      .filter((m) => m.user_id === userId && m.session_id === sessionId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  // --- v2: tareas
  async countQueuedTasks(userId: string, nowIso: string) {
    return [...this.tasks.values()].filter((t) => t.user_id === userId && t.status === "en_cola" && t.expires_at > nowIso).length;
  }

  async insertTask(row: NewTask) {
    const t: TaskRow = {
      ...row,
      status: "en_cola",
      cancel_requested: false,
      session_id: null,
      progress: null,
      result: null,
      error: null,
      started_at: null,
      updated_at: row.created_at,
      finished_at: null,
    };
    this.tasks.set(t.task_id, t);
    return { ...t };
  }

  async findTask(userId: string, taskId: string) {
    const t = this.tasks.get(taskId);
    return t && t.user_id === userId ? { ...t } : null;
  }

  async listTasks(userId: string, limit: number) {
    return [...this.tasks.values()]
      .filter((t) => t.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }

  async claimNextTask(userId: string, deviceId: string, nowIso: string) {
    const next = [...this.tasks.values()]
      .filter((t) => t.user_id === userId && t.device_id === deviceId && t.status === "en_cola" && t.expires_at > nowIso)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!next) return null;
    // Como el índice único parcial de la base: una sola tarea ejecutándose por dispositivo.
    if ([...this.tasks.values()].some((t) => t.device_id === deviceId && t.status === "ejecutando")) return null;
    next.status = "ejecutando";
    next.started_at = nowIso;
    next.updated_at = nowIso;
    return { ...next };
  }

  async updateTask(userId: string, taskId: string, patch: TaskPatch, onlyIfStatus: TaskStatus[]) {
    const t = this.tasks.get(taskId);
    if (!t || t.user_id !== userId || !onlyIfStatus.includes(t.status)) return null;
    Object.assign(t, patch);
    return { ...t };
  }

  async sweepTasks(userId: string, deviceId: string, nowIso: string, staleIso: string) {
    const changed: TaskRow[] = [];
    for (const t of this.tasks.values()) {
      if (t.user_id !== userId) continue;
      if (t.status === "en_cola" && t.expires_at <= nowIso) {
        t.status = "vencida";
        t.finished_at = nowIso;
        t.updated_at = nowIso;
        changed.push({ ...t });
      } else if (t.status === "ejecutando" && t.device_id === deviceId && t.updated_at < staleIso) {
        t.status = "fallida";
        t.error = "El runner dejó de responder";
        t.finished_at = nowIso;
        t.updated_at = nowIso;
        changed.push({ ...t });
      }
    }
    return changed;
  }
}
