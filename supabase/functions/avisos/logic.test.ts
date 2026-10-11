// node --experimental-strip-types --test supabase/functions/avisos/logic.test.ts
// Decisión de envío, reintentos y reutilización de la bandeja, con dobles de notify y de la base: nada sale a la red.
import test from "node:test";
import assert from "node:assert/strict";
import { type AvisoReclamado, decidirEnvio, type Deps, kindDeAviso, procesarAviso, procesarLote } from "./logic.ts";
import { NO_PUSH, PUSH_FALLIDO, type PushSummary } from "../_shared/webpush-core.ts";

const resumen = (o: Partial<PushSummary>): PushSummary => ({ ...NO_PUSH, ...o });

const aviso = (o: Partial<AvisoReclamado> = {}): AvisoReclamado => ({
  aviso_id: "a1", user_id: "u1", origen: "recordatorio", titulo: "Llamar a Marco", cuerpo: "Me pediste que te lo recordara.", url: "/avisos",
  notification_id: null, intentos: 1, ...o,
});

function dobles(push: PushSummary | Error | (() => PushSummary), opciones: { notificacion?: string | null; asentarFalla?: boolean } = {}) {
  /** Orden en que ocurrió cada paso: la prueba del asiento de la bandeja mira que sea crear → asentar → push → cerrar. */
  const orden: string[] = [];
  const llamadas = { crear: [] as unknown[], asentar: [] as unknown[], push: [] as unknown[], cierres: [] as unknown[][], orden };
  const deps: Deps = {
    crearNotificacion: async (u, n) => { orden.push("crear"); llamadas.crear.push([u, n]); return opciones.notificacion === undefined ? "n1" : opciones.notificacion; },
    asentarNotificacion: async (aviso, id) => {
      orden.push("asentar");
      llamadas.asentar.push([aviso, id]);
      if (opciones.asentarFalla) throw new Error("rpc caído");
    },
    enviarPush: async (u, id, n) => {
      orden.push("push");
      llamadas.push.push([u, id, n]);
      if (push instanceof Error) throw push;
      return typeof push === "function" ? push() : push;
    },
    cerrar: async (...args) => { orden.push("cerrar"); llamadas.cierres.push(args); },
  };
  return { deps, llamadas };
}

test("kindDeAviso: los recordatorios salen como agenda y lo del dinero como pago (ambos con urgencia alta)", () => {
  assert.equal(kindDeAviso("recordatorio"), "agenda");
  assert.equal(kindDeAviso("tarea"), "agenda");
  for (const o of ["vencimiento", "tarjeta", "presupuesto"]) assert.equal(kindDeAviso(o), "pago", o);
});

test("decidirEnvio: push aceptado, sin dispositivos y dispositivos caducados son éxito; todos fallando es reintento", () => {
  assert.deepEqual(decidirEnvio(resumen({ devices: 2, sent: 1, failed: 1, statuses: [201, 503] })), { ok: true, detalle: "push" });
  assert.equal(decidirEnvio(NO_PUSH).ok, true, "sin suscripciones: queda en la bandeja, reintentar no sirve");
  assert.match(decidirEnvio(NO_PUSH).detalle, /^bandeja/);
  assert.equal(decidirEnvio(resumen({ devices: 1, removed: 1, statuses: [410] })).ok, true, "el 410 borra la suscripción: no se reintenta");
  assert.deepEqual(decidirEnvio(resumen({ devices: 2, failed: 2, statuses: [503, 429] })), { ok: false, detalle: "push rechazado (503)" });
  assert.deepEqual(decidirEnvio(resumen({ devices: 1, failed: 1, statuses: [null] })), { ok: false, detalle: "push sin respuesta" });
});

test("decidirEnvio: un error real al intentar el push NO se confunde con «sin suscripciones» (se reintenta, no se da por enviado)", () => {
  assert.deepEqual(decidirEnvio(PUSH_FALLIDO), { ok: false, detalle: "no pude intentar el push" });
  assert.equal(decidirEnvio(NO_PUSH).ok, true, "mientras que sin suscripciones sí queda en la bandeja");
  assert.notDeepEqual(PUSH_FALLIDO, NO_PUSH);
});

test("un error al leer las suscripciones (PUSH_FALLIDO) deja el aviso para reintento, con la fila de la bandeja ya asentada", async () => {
  const { deps, llamadas } = dobles(PUSH_FALLIDO);
  assert.equal(await procesarAviso(aviso(), deps), "reintento");
  assert.deepEqual(llamadas.cierres, [["a1", false, "no pude intentar el push", "n1"]]);
});

test("la fila de la bandeja se asienta en el aviso ANTES del push (si el proceso muere en medio, el rescate no crea otra)", async () => {
  const { deps, llamadas } = dobles(resumen({ devices: 1, sent: 1, statuses: [201] }));
  await procesarAviso(aviso(), deps);
  assert.deepEqual(llamadas.orden, ["crear", "asentar", "push", "cerrar"]);
  assert.deepEqual(llamadas.asentar, [["a1", "n1"]]);
  // un reintento que ya la trae no crea ni asienta nada
  const rescate = dobles(resumen({ devices: 1, sent: 1, statuses: [201] }));
  await procesarAviso(aviso({ notification_id: "n-previa" }), rescate.deps);
  assert.deepEqual(rescate.llamadas.orden, ["push", "cerrar"]);
});

test("si asentar la fila falla, el aviso se envía igual (no se pierde por eso)", async () => {
  const log = console.error;
  console.error = () => {};
  try {
    const { deps, llamadas } = dobles(resumen({ devices: 1, sent: 1, statuses: [201] }), { asentarFalla: true });
    assert.equal(await procesarAviso(aviso(), deps), "enviado");
    assert.deepEqual(llamadas.orden, ["crear", "asentar", "push", "cerrar"]);
  } finally {
    console.error = log;
  }
});

test("procesarAviso: guarda en la bandeja, envía el push y cierra como enviado", async () => {
  const { deps, llamadas } = dobles(resumen({ devices: 1, sent: 1, statuses: [201] }));
  assert.equal(await procesarAviso(aviso(), deps), "enviado");
  assert.deepEqual(llamadas.crear, [["u1", { kind: "agenda", title: "Llamar a Marco", body: "Me pediste que te lo recordara.", url: "/avisos" }]]);
  assert.deepEqual(llamadas.cierres, [["a1", true, "push", "n1"]]);
});

test("un reintento NO vuelve a crear la fila de la bandeja: reutiliza la que ya existe", async () => {
  const { deps, llamadas } = dobles(resumen({ devices: 1, sent: 1, statuses: [201] }));
  await procesarAviso(aviso({ notification_id: "n-previa", intentos: 2 }), deps);
  assert.equal(llamadas.crear.length, 0);
  assert.deepEqual(llamadas.push[0]?.slice(0, 2), ["u1", "n-previa"]);
  assert.deepEqual(llamadas.cierres[0], ["a1", true, "push", "n-previa"]);
});

test("push que falla: se cierra como intento fallido CON la id de la bandeja (para el siguiente intento)", async () => {
  const { deps, llamadas } = dobles(resumen({ devices: 1, failed: 1, statuses: [503] }));
  assert.equal(await procesarAviso(aviso(), deps), "reintento");
  assert.deepEqual(llamadas.cierres, [["a1", false, "push rechazado (503)", "n1"]]);
});

test("una excepción del push o de la bandeja se convierte en intento fallido, nunca en un error sin cerrar", async () => {
  const roto = dobles(new Error("red caída"));
  assert.equal(await procesarAviso(aviso(), roto.deps), "reintento");
  assert.deepEqual(roto.llamadas.cierres[0]?.slice(0, 2), ["a1", false]);
  assert.match(String(roto.llamadas.cierres[0]?.[2]), /red caída/);

  const sinBandeja = dobles(NO_PUSH, { notificacion: null });
  assert.equal(await procesarAviso(aviso(), sinBandeja.deps), "reintento");
  assert.equal(sinBandeja.llamadas.push.length, 0, "sin fila en la bandeja no se envía el push");
  assert.deepEqual(sinBandeja.llamadas.cierres, [["a1", false, "no se pudo guardar en la bandeja", null]]);
});

test("si cerrar falla no lanza (el reclamo huérfano lo rescata avisos_limpiar)", async () => {
  const { deps } = dobles(resumen({ devices: 1, sent: 1, statuses: [201] }));
  const silencio = console.error;
  console.error = () => {};
  try {
    assert.equal(await procesarAviso(aviso(), { ...deps, cerrar: async () => { throw new Error("db caída"); } }), "enviado");
  } finally {
    console.error = silencio;
  }
});

test("procesarLote: cuenta enviados y reintentos y respeta la concurrencia", async () => {
  let activos = 0;
  let maximo = 0;
  const { deps, llamadas } = dobles(() => resumen({ devices: 1, sent: 1, statuses: [201] }));
  const lento: Deps = {
    ...deps,
    enviarPush: async (...a) => {
      activos++;
      maximo = Math.max(maximo, activos);
      await new Promise((ok) => setTimeout(ok, 5));
      activos--;
      return deps.enviarPush(...a);
    },
  };
  const lote = Array.from({ length: 12 }, (_, i) => aviso({ aviso_id: `a${i}` }));
  assert.deepEqual(await procesarLote(lote, lento, 3), { enviados: 12, reintentos: 0 });
  assert.ok(maximo <= 3, `concurrencia ${maximo}`);
  assert.equal(llamadas.cierres.length, 12);
  assert.deepEqual(await procesarLote([], deps), { enviados: 0, reintentos: 0 });
});
