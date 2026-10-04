// Cliente de las edge functions `google` y `google-oauth`.
// Usa fetch directo (no supabase.functions.invoke) para leer el mensaje real de los errores.
import { supabase } from '@/lib/supabase';

export class GoogleUiError extends Error {
  code: string;
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, code: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GoogleUiError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

const base = () => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new GoogleUiError('Tu sesión venció. Vuelve a entrar.', 'auth', 401);
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
}

async function post<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body), signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const { error, code, ...rest } = json as Record<string, unknown>;
      throw new GoogleUiError(typeof error === 'string' ? error : 'Algo falló. Intenta de nuevo.', typeof code === 'string' ? code : 'error', res.status, rest);
    }
    return json as T;
  } catch (e) {
    if (e instanceof GoogleUiError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') throw new GoogleUiError('Google tardó demasiado en responder. Intenta de nuevo.', 'timeout', 0);
    throw new GoogleUiError('Sin conexión. Revisa tu internet e intenta de nuevo.', 'red', 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Una acción de la edge function `google` (ver supabase/functions/google/index.ts). */
export const googleCall = <T,>(action: string, params: Record<string, unknown> = {}): Promise<T> =>
  post<T>(`${base()}/google`, { action, ...params }, 25_000);

/** Pide la URL de consentimiento de Google y va hacia ella. Los permisos los fija el servidor. */
export async function startGoogleConnect(): Promise<void> {
  const { url } = await post<{ url: string }>(`${base()}/google-oauth/start`, {}, 15_000);
  window.location.assign(url);
}

/** El error pide volver a conectar Google (no hay cuenta, la revocaron o falta un permiso). */
export const needsConnection = (e: unknown): e is GoogleUiError =>
  e instanceof GoogleUiError && (e.code === 'no_conectado' || e.code === 'reauth' || e.code === 'permiso');

/** Mensaje al volver del consentimiento de Google (?google=error&motivo=…). Solo códigos conocidos: nunca se pinta texto de la URL. */
const MOTIVOS: Record<string, string> = {
  denegado: 'Cancelaste la conexión. Cuando quieras, vuelve a intentarlo.',
  estado: 'El enlace de conexión venció. Toca «Conectar Google» otra vez.',
  intercambio: 'Google no aceptó la conexión. Intenta de nuevo.',
  sin_codigo: 'Google no completó la conexión. Intenta de nuevo.',
  sin_refresh: 'Google no entregó el acceso permanente. Intenta de nuevo y acepta todos los permisos.',
  sin_cuenta: 'No pude leer tu cuenta de Google. Intenta de nuevo.',
  permisos: 'No quedó marcado ningún permiso. Conecta de nuevo y deja marcadas las casillas.',
  guardado: 'Google aceptó, pero no pude guardar la conexión. Intenta de nuevo.',
  config: 'Falta configurar las credenciales de Google en el servidor.',
  google: 'Google rechazó la solicitud. Intenta de nuevo.',
};
export const motivoMessage = (motivo: string | null): string => (motivo && MOTIVOS[motivo]) || 'No se pudo conectar Google. Intenta de nuevo.';
