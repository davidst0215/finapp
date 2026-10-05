import { supabase } from '@/lib/supabase';
import type { ApprovalView, Decision, DeviceView, EventView, MessageView, Overview, PairedDevice, TaskView } from './types';

// Rutas /ui/* de la edge function claude-events: van con el JWT del usuario. La laptop usa otras rutas (/device/*).
const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/claude-events`;

export class ApiError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ApiError(401, 'Tu sesión venció. Vuelve a entrar.');

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Sin conexión con Wabid.');
  }

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, typeof payload.error === 'string' ? payload.error : `Error ${res.status}`, payload);
  }
  return payload as T;
}

export const claudeApi = {
  overview: (signal?: AbortSignal) => request<Overview>('GET', '/ui/overview', undefined, signal),

  sessionEvents: (sessionId: string, signal?: AbortSignal) =>
    request<{ events: EventView[] }>('GET', `/ui/sessions/${encodeURIComponent(sessionId)}/events`, undefined, signal),

  pair: (name: string) => request<PairedDevice>('POST', '/ui/devices', { name }),

  setApprovals: (deviceId: string, enabled: boolean) =>
    request<{ device: DeviceView }>('PATCH', `/ui/devices/${deviceId}`, { approvals_enabled: enabled }),

  revoke: (deviceId: string) => request<{ ok: true }>('DELETE', `/ui/devices/${deviceId}`),

  decide: (approvalId: string, decision: Decision) =>
    request<{ approval: ApprovalView }>('POST', `/ui/approvals/${approvalId}/decision`, { decision }),

  sendMessage: (sessionId: string, text: string) =>
    request<{ message: MessageView }>('POST', `/ui/sessions/${encodeURIComponent(sessionId)}/messages`, { text }),

  createTask: (project: string, prompt: string) => request<{ task: TaskView }>('POST', '/ui/tasks', { project, prompt }),

  cancelTask: (taskId: string) => request<{ task: TaskView }>('POST', `/ui/tasks/${taskId}/cancel`),
};
