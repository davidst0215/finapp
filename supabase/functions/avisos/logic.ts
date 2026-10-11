// Lógica pura de la función `avisos` (sin globals de Deno: las pruebas corren en Node).
// La función reclama los avisos vencidos (SQL: avisos_reclamar), los envía con las piezas de notify.ts y cierra cada uno
// (SQL: avisos_cerrar, que decide el reintento y la espera). Aquí vive lo que hay que decidir entre una cosa y otra.
import type { PushSummary } from "../_shared/webpush-core.ts";

/** Una fila reclamada (avisos_reclamar devuelve la fila completa; aquí solo lo que el envío necesita). */
export type AvisoReclamado = {
  aviso_id: string;
  user_id: string;
  origen: string;
  titulo: string;
  cuerpo: string;
  url: string | null;
  notification_id: string | null;
  intentos: number;
};

/** Los tipos de `notifications.kind` que existen (migración 004): los avisos programados reutilizan dos. */
export type KindAviso = "agenda" | "pago";

/**
 * Qué tipo de aviso es para la bandeja y la política de entrega (webpush-core, pushPolicyFor): `agenda` y `pago` salen con
 * urgencia alta, que es lo que un aviso con hora necesita para llegar al minuto aunque el celular esté en reposo.
 * Un `kind` nuevo ("recordatorio") obligaría a tocar el CHECK de notifications; las migraciones 016-019 corren en paralelo.
 */
export function kindDeAviso(origen: string): KindAviso {
  return origen === "recordatorio" || origen === "tarea" ? "agenda" : "pago";
}

export type Decision = { ok: boolean; detalle: string };

/**
 * ¿Salió el aviso? Lo guardado en la bandeja ya cuenta como entregado; el push es el canal rápido.
 *  - Algún dispositivo lo aceptó → ok por push.
 *  - Ningún dispositivo (no hay suscripciones, o los VAPID no están configurados) → ok por bandeja: reintentar no cambia nada.
 *  - Todos los dispositivos estaban caducados (404/410, ya se borraron) → ok por bandeja.
 *  - Hubo dispositivos y NINGUNO respondió (red, 5xx, 429, rechazo) → falla, se reintenta.
 */
export function decidirEnvio(resumen: PushSummary): Decision {
  if (resumen.sent > 0) return { ok: true, detalle: "push" };
  if (resumen.devices === 0) return { ok: true, detalle: "bandeja (sin dispositivos con avisos)" };
  if (resumen.failed === 0) return { ok: true, detalle: "bandeja (dispositivos caducados)" };
  const codigo = resumen.statuses.find((s): s is number => s !== null);
  return { ok: false, detalle: codigo === undefined ? "push sin respuesta" : `push rechazado (${codigo})` };
}

export type Deps = {
  /** Deja el aviso en la bandeja y devuelve su id (null si no se pudo). */
  crearNotificacion: (userId: string, notice: { kind: KindAviso; title: string; body: string; url?: string }) => Promise<string | null>;
  /** Envía el push de una notificación ya guardada. */
  enviarPush: (userId: string, notificationId: string, notice: { kind: KindAviso; title: string; body: string; url?: string }) => Promise<PushSummary>;
  /** Cierra el envío (SQL avisos_cerrar): ok → enviado; si no, reintento con espera o fallido. */
  cerrar: (avisoId: string, ok: boolean, detalle: string, notificationId: string | null) => Promise<void>;
};

export type Resultado = "enviado" | "reintento";

/** Envía UN aviso y lo cierra. Nunca lanza: un fallo se cierra como intento fallido. */
export async function procesarAviso(a: AvisoReclamado, deps: Deps): Promise<Resultado> {
  const notice = { kind: kindDeAviso(a.origen), title: a.titulo, body: a.cuerpo, ...(a.url ? { url: a.url } : {}) };
  let notificationId = a.notification_id;
  let decision: Decision;
  try {
    // Un reintento reutiliza la fila de la bandeja que ya se creó: no duplica el aviso en la lista.
    notificationId ??= await deps.crearNotificacion(a.user_id, notice);
    if (notificationId === null) {
      decision = { ok: false, detalle: "no se pudo guardar en la bandeja" };
    } else {
      decision = decidirEnvio(await deps.enviarPush(a.user_id, notificationId, notice));
    }
  } catch (e) {
    decision = { ok: false, detalle: `error al enviar: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
  try {
    await deps.cerrar(a.aviso_id, decision.ok, decision.detalle, notificationId);
  } catch (e) {
    // Si el cierre falla, el reclamo queda 'enviando' y avisos_limpiar lo rescata a los 5 min (el push ya salió: a lo sumo se repite una vez).
    console.error("avisos: cerrar:", e instanceof Error ? e.message : String(e));
  }
  return decision.ok ? "enviado" : "reintento";
}

/** Procesa el lote con una concurrencia acotada (cada push espera hasta 4 s por dispositivo). */
export async function procesarLote(avisos: AvisoReclamado[], deps: Deps, concurrencia = 5): Promise<{ enviados: number; reintentos: number }> {
  let enviados = 0;
  let reintentos = 0;
  const cola = [...avisos];
  const trabajador = async () => {
    for (let a = cola.shift(); a; a = cola.shift()) {
      if ((await procesarAviso(a, deps)) === "enviado") enviados++;
      else reintentos++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrencia, cola.length) }, trabajador));
  return { enviados, reintentos };
}
