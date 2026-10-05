// De filas de la base a lo que ve la app. Aquí se decide qué sale: nunca token_hash ni user_id.

import type {
  ApprovalRow,
  ApprovalView,
  DeviceRow,
  DeviceView,
  EventRow,
  EventView,
  MessageRow,
  MessageView,
  SessionRow,
  SessionView,
  TaskRow,
  TaskView,
} from "./types.ts";

/** Si el runner no da señal en este tiempo, la app lo muestra como desconectado. */
export const RUNNER_ONLINE_MS = 60_000;

export const toDeviceView = (d: DeviceRow, nowMs: number = Date.now()): DeviceView => ({
  id: d.device_id,
  name: d.name,
  approvals_enabled: d.approvals_enabled,
  created_at: d.created_at,
  last_seen_at: d.last_seen_at,
  runner: {
    projects: d.runner_projects ?? [],
    online: d.runner_seen_at !== null && d.runner_seen_at !== undefined && nowMs - Date.parse(d.runner_seen_at) <= RUNNER_ONLINE_MS,
  },
});

export const toSessionView = (s: SessionRow): SessionView => ({
  id: s.session_id,
  device_id: s.device_id,
  project: s.project,
  cwd: s.cwd,
  status: s.status,
  summary: s.last_summary,
  started_at: s.started_at,
  last_event_at: s.last_event_at,
  ended_at: s.ended_at,
});

export const toEventView = (e: EventRow): EventView => ({
  id: e.event_id,
  kind: e.kind,
  detail: e.detail,
  summary: e.summary,
  created_at: e.created_at,
});

export const toApprovalView = (a: ApprovalRow, nowMs: number): ApprovalView => ({
  id: a.approval_id,
  session_id: a.session_id,
  project: a.project,
  tool_name: a.tool_name,
  description: a.description,
  preview: a.preview,
  truncated: a.preview_truncated,
  status: a.status,
  created_at: a.created_at,
  expires_at: a.expires_at,
  expires_in_ms: a.status === "pendiente" ? Math.max(0, Date.parse(a.expires_at) - nowMs) : 0,
  decided_at: a.decided_at,
});

export const toMessageView = (m: MessageRow): MessageView => ({
  id: m.message_id,
  session_id: m.session_id,
  status: m.status,
  created_at: m.created_at,
  delivered_at: m.delivered_at,
});

export const toTaskView = (t: TaskRow): TaskView => ({
  id: t.task_id,
  project: t.project,
  prompt: t.prompt,
  status: t.status,
  cancel_requested: t.cancel_requested,
  session_id: t.session_id,
  progress: t.progress,
  result: t.result,
  error: t.error,
  created_at: t.created_at,
  started_at: t.started_at,
  finished_at: t.finished_at,
});
