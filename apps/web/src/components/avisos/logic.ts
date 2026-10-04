// Lógica pura de la pantalla de avisos (sin React ni DOM, para probarla en Node).
// Pruebas: apps/web/tests/avisos/logic.test.ts

// ── base64url (la clave VAPID viaja así y el navegador la quiere en bytes) ──

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const limpio = value.trim().replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(limpio) || limpio.length % 4 === 1) throw new Error('No es base64url válido');
  const binario = atob(limpio.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (limpio.length % 4)) % 4));
  return Uint8Array.from(binario, (c) => c.charCodeAt(0));
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const datos = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binario = '';
  for (const b of datos) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ¿La suscripción del navegador se hizo con esta clave VAPID? Si el servidor rota la clave, hay que volver a suscribir.
export function sameKey(applicationServerKey: ArrayBuffer | null | undefined, expected: string): boolean {
  if (!applicationServerKey) return false;
  try {
    return bytesToBase64Url(applicationServerKey) === bytesToBase64Url(base64UrlToBytes(expected));
  } catch {
    return false;
  }
}

// ── Fechas ───────────────────────────────────────────────────────────────────

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const LIMA_MS = 5 * 3_600_000; // Lima es UTC-5 todo el año
const diaDeLima = (ms: number) => Math.floor((ms - LIMA_MS) / 86_400_000);

// "ahora", "hace 5 min", "hace 3 h", "ayer", "hace 4 d", "20 sep". Los días cuentan por calendario de Lima.
export function formatRelative(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const transcurrido = now.getTime() - then;
  if (transcurrido < 60_000) return 'ahora';
  if (transcurrido < 3_600_000) return `hace ${Math.floor(transcurrido / 60_000)} min`;
  if (transcurrido < 86_400_000) return `hace ${Math.floor(transcurrido / 3_600_000)} h`;
  const dias = diaDeLima(now.getTime()) - diaDeLima(then);
  if (dias <= 1) return 'ayer';
  if (dias < 7) return `hace ${dias} d`;
  const fecha = new Date(then - LIMA_MS);
  const hoy = new Date(now.getTime() - LIMA_MS);
  const dia = `${fecha.getUTCDate()} ${MESES[fecha.getUTCMonth()]}`;
  return fecha.getUTCFullYear() === hoy.getUTCFullYear() ? dia : `${dia} ${fecha.getUTCFullYear()}`;
}

// ── Rutas ────────────────────────────────────────────────────────────────────

// Misma regla que el servidor (supabase/functions/_shared/webpush-core.ts, isSafeAppPath): solo rutas de esta app.
// El servidor ya filtra lo que devuelve la bandeja; aquí se repite porque navegar a un destino ajeno es el daño.
export const isAppPath = (url: string | null | undefined): url is string =>
  typeof url === 'string' && url.length > 0 && url.length <= 300 && /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(url);

// ── Tipos de aviso ───────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  brief: 'Brief',
  pago: 'Pago',
  tarea: 'Tarea',
  espera: 'Espera',
  agenda: 'Agenda',
  correo: 'Correo',
  claude: 'Claude Code',
  sistema: 'Sistema',
};

export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? 'Aviso';

// ── Estado de este dispositivo ───────────────────────────────────────────────

export type Permission = 'default' | 'granted' | 'denied';
export type DevicePhase = 'checking' | 'unsupported' | 'no-worker' | 'blocked' | 'off' | 'on';
export type DeviceBusy = 'idle' | 'enabling' | 'disabling';

export function devicePhase(i: {
  checking: boolean;
  supported: boolean;
  hasWorker: boolean;
  permission: Permission;
  subscribed: boolean;
}): DevicePhase {
  if (i.checking) return 'checking';
  if (!i.supported) return 'unsupported';
  if (!i.hasWorker) return 'no-worker';
  if (i.permission === 'denied') return 'blocked'; // sin permiso la suscripción no sirve aunque exista
  return i.subscribed && i.permission === 'granted' ? 'on' : 'off';
}

export const canToggle = (phase: DevicePhase, busy: DeviceBusy): boolean =>
  busy === 'idle' && (phase === 'on' || phase === 'off');

export function deviceText(phase: DevicePhase, busy: DeviceBusy): string {
  if (busy === 'enabling') return 'Activando…';
  if (busy === 'disabling') return 'Desactivando…';
  switch (phase) {
    case 'checking':
      return 'Comprobando este dispositivo…';
    case 'unsupported':
      return 'Este navegador no admite avisos. Abre Wabid en Chrome para Android o instálala en la pantalla de inicio.';
    case 'no-worker':
      return 'El service worker de la app aún no está activo. Recarga la página; en desarrollo los avisos solo funcionan con la app compilada.';
    case 'blocked':
      return 'Bloqueaste las notificaciones de Wabid en este dispositivo. Permítelas en los ajustes del sitio (en Android: Ajustes → Apps → Wabid → Notificaciones) y vuelve aquí.';
    case 'off':
      return 'Desactivados. Actívalos para recibir el brief, los pagos y los recordatorios aunque la app esté cerrada.';
    case 'on':
      return 'Activados. Te llegan aunque la app esté cerrada.';
  }
}

// ── Aviso de prueba ──────────────────────────────────────────────────────────

export type TestResponse = {
  configured: boolean;
  devices: number;
  sent: number;
  removed: number;
  failed: number;
  statuses: Array<number | null>;
};

export type TestOutcome = { tone: 'ok' | 'warn' | 'error'; message: string };

export function describeTest(r: TestResponse): TestOutcome {
  if (!r.configured) {
    return {
      tone: 'warn',
      message: 'Los avisos aún no están configurados en el servidor (faltan las claves VAPID). El aviso quedó solo en la bandeja.',
    };
  }
  if (r.devices === 0) {
    return {
      tone: 'warn',
      message: 'El aviso quedó en la bandeja, pero ningún dispositivo tiene los avisos activados. Activa el interruptor de arriba.',
    };
  }
  if (r.sent > 0) {
    const base = r.sent === 1 ? 'Aviso enviado.' : `Aviso enviado a ${r.sent} dispositivos.`;
    const fallaron = r.failed > 0 ? ` ${r.failed} ${r.failed === 1 ? 'dispositivo no respondió' : 'dispositivos no respondieron'}.` : '';
    return { tone: 'ok', message: `${base} Debería llegarte en unos segundos.${fallaron}` };
  }
  if (r.failed > 0) {
    const codigo = r.statuses.find((s): s is number => s !== null);
    return {
      tone: 'error',
      message:
        codigo === undefined
          ? 'No se pudo contactar al servicio de notificaciones. Inténtalo de nuevo en un momento.'
          : `El servicio de notificaciones no aceptó el envío (código ${codigo}).`,
    };
  }
  return {
    tone: 'warn',
    message: 'Este dispositivo ya no estaba registrado en el servicio de notificaciones y se quitó. Desactiva y vuelve a activar los avisos.',
  };
}
