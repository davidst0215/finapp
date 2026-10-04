// De filas de la base a lo que ve la app. Aquí se decide qué sale: nunca token_hash ni user_id.

import type { ApprovalRow, ApprovalView, DeviceRow, DeviceView, EventRow, EventView, SessionRow, SessionView } from "./types.ts";

export const toDeviceView = (d: DeviceRow): DeviceView => ({
  id: d.device_id,
  name: d.name,
  approvals_enabled: d.approvals_enabled,
  created_at: d.created_at,
  last_seen_at: d.last_seen_at,
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
