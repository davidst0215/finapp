// node --experimental-strip-types --test supabase/functions/agent/tools/tareasPlan.test.ts
// Decisiones de «agendar un pendiente»: proyecto, vencimiento en hora de Lima y qué preguntar. Hoy en estas pruebas es
// domingo 2026-10-11 (Lima); el servidor corre en UTC y recibe `limaNow` ya corrido −5 h.
import test from "node:test";
import assert from "node:assert/strict";
import { HORA_EN_TEXTO, PIDE_AVISO, planearTarea, type PlanTarea } from "./tareasPlan.ts";
import { relojLima } from "../../_shared/vault/fechas.ts";
import { construirIndice, fichaProy, type Indice } from "../../_shared/vault/proyectos.ts";
import { EMPTY_CONFIG } from "../../_shared/vault/taxonomy.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import type { ToolResult } from "../types.ts";

const IX: Indice = construirIndice(
  EMPTY_CONFIG,
  ["cajon-desastre", "life", "lota", "mqsco-cobranzas", "mqsco-herramientas", "mqspe-scoring", "mqspe-aprobaciones", "novafondos-app", "novafondos-normativa", "tdv-bolsa-de-costos", "tdv-analisis", "wabid"],
  [
    fichaProy({ slug: "maqui-colombia", cliente: "Maqui CO", padre: null, content: "Vault 20-projects/mqsco-*/pendientes.md" }),
    fichaProy({ slug: "maqui-peru", cliente: "Maqui PE", padre: null, content: "Vault: 20-projects/mqspe-*/pendientes.md" }),
    fichaProy({ slug: "novafondos", cliente: "Novafondos", padre: null, content: "Vault: `20-projects/novafondos-app/pendientes.md` y `novafondos-normativa/pendientes.md`" }),
    fichaProy({ slug: "tdv", cliente: "TDV", padre: null, content: "Vault: `20-projects\\tdv-*\\pendientes.md`" }),
    fichaProy({ slug: "lota", cliente: "personal", padre: null, content: "" }),
  ],
);

const HOY = { hoy: "2026-10-11", minutos: 12 * 60, dictado: "" };
const plan = (args: Record<string, unknown>, ctx = HOY, ix: Indice | null = IX): PlanTarea => {
  const r = planearTarea(args, ctx, ix);
  assert.ok("plan" in r, `se esperaba un plan y salió ${JSON.stringify("respuesta" in r ? r.respuesta : r)}`);
  return r.plan;
};
const respuesta = (args: Record<string, unknown>, ctx = HOY, ix: Indice | null = IX): ToolResult => {
  const r = planearTarea(args, ctx, ix);
  assert.ok("respuesta" in r, "se esperaba una pregunta o un error");
  return r.respuesta;
};

test("relojLima: el día de Lima aunque en UTC ya sea el siguiente", () => {
  // 22:30 en Lima del domingo 11 = 03:30 UTC del lunes 12; el agente recibe ese instante ya corrido −5 h.
  const lima = new Date(new Date("2026-10-12T03:30:00Z").getTime() - 5 * 3_600_000);
  assert.deepEqual(relojLima(lima), { hoy: "2026-10-11", minutos: 22 * 60 + 30 });
  assert.deepEqual(relojLima(new Date("2026-10-11T00:05:00Z")), { hoy: "2026-10-11", minutos: 5 });
});

test("«agéndame revisar el simulador de nova fondos el jueves»: Novafondos tiene dos frentes → pregunta app o normativa", () => {
  const r = respuesta({ text: "Revisar el simulador", project: "nova fondos", due: "jueves" });
  assert.equal(r.action, "clarify");
  assert.equal(r.message, "¿En qué frente de Novafondos: app o normativa?");
  assert.equal(r.voz, "¿En Novafondos: app o normativa?");
  assert.ok(prepararVoz(r.voz ?? "").endsWith("?"), "la voz conserva el «?»");
});

test("al responder «app», la misma tarea con el proyecto completo queda en novafondos-app para el jueves 15 de octubre", () => {
  const p = plan({ text: "Revisar el simulador", project: "novafondos app", due: "jueves" });
  assert.equal(p.folder, "novafondos-app");
  assert.equal(p.donde, "Novafondos app");
  assert.equal(p.due, "2026-10-15");
  assert.equal(p.hora, null);
  assert.equal(p.note, null);
});

test("«agrega pendiente en maqui colombia cobranzas: llamar a Gabriela»", () => {
  const p = plan({ text: "Llamar a Gabriela", project: "maqui colombia cobranzas" });
  assert.equal(p.folder, "mqsco-cobranzas");
  assert.equal(p.donde, "Maqui CO cobranzas");
  assert.equal(p.due, null);
});

test("«maqui perú» sin frente es ambiguo; «tdv bolsa» no", () => {
  const pe = respuesta({ text: "Algo", project: "Maqui Perú" });
  assert.equal(pe.action, "clarify");
  assert.match(pe.message, /^¿En qué frente de Maqui PE: aprobaciones o scoring\?$/);
  assert.equal(plan({ text: "X", project: "TDV bolsa" }).folder, "tdv-bolsa-de-costos");
});

test("una coincidencia aproximada NO escribe: se confirma antes («lota visión» → ¿En Lota?)", () => {
  const r = planearTarea({ text: "Probar la cámara", project: "lota visión" }, HOY, IX);
  assert.ok("respuesta" in r);
  if (!("respuesta" in r)) return;
  assert.equal(r.respuesta.action, "clarify");
  assert.equal(r.respuesta.message, "¿Lo anoto en Lota?");
  assert.equal(r.respuesta.voz, "¿En Lota?");
  assert.deepEqual([r.proyecto?.kind, r.proyecto?.kind === "one" && r.proyecto.aproximado], ["one", true]);
  // al confirmar, la tarea se repite con el nombre completo y entonces sí se escribe
  assert.equal(plan({ text: "Probar la cámara", project: "lota" }).folder, "lota");
  // varias palabras desconocidas, o nombres que solo se parecen por el prefijo: no
  const vera = construirIndice(EMPTY_CONFIG, ["vera", "veracruz-obra"], []);
  assert.equal(plan({ text: "X", project: "vera" }, HOY, vera).folder, "vera");
  assert.equal(plan({ text: "X", project: "veracruz obra" }, HOY, vera).folder, "veracruz-obra");
  const r2 = planearTarea({ text: "X", project: "vera marketing" }, HOY, vera);
  assert.ok("respuesta" in r2 && r2.respuesta.message === "¿Lo anoto en Vera?");
});

test("un proyecto que no existe deja la tarea en el cajón y lo dice (no se pierde)", () => {
  const p = plan({ text: "Algo", project: "proyecto fantasma" });
  assert.equal(p.folder, "cajon-desastre");
  assert.equal(p.donde, "el cajón");
  assert.match(p.aviso, /No encontré el proyecto «proyecto fantasma», así que quedó en el cajón\./);
  assert.equal(p.avisoVoz, " No encontré ese proyecto.");
  assert.equal(p.proyecto?.kind, "none");
  // sin proyecto: al cajón sin aviso
  const sin = plan({ text: "Algo" }, HOY, null);
  assert.deepEqual([sin.folder, sin.aviso, sin.proyecto], ["cajon-desastre", "", null]);
});

test("«pendiente para mañana a las 5»: mañana en Lima y la hora viaja en el detalle", () => {
  const p = plan({ text: "Llamar a Ana", due: "mañana", time: "17:00" });
  assert.equal(p.due, "2026-10-12");
  assert.equal(p.hora, "17:00");
  assert.equal(p.note, "Hora: 17:00");
  assert.equal(p.horaHablada, "las cinco de la tarde");
  const conNota = plan({ text: "Llamar a Ana", due: "mañana", time: "5 pm", note: "Preguntar por el contrato" });
  assert.equal(conNota.hora, "17:00");
  assert.equal(conNota.note, "Hora: 17:00. Preguntar por el contrato");
});

test("cerca de medianoche en Lima: «mañana» y «hoy» siguen siendo días de Lima", () => {
  // Lima: domingo 11 a las 22:30 (03:30 UTC del lunes).
  const lima = new Date(new Date("2026-10-12T03:30:00Z").getTime() - 5 * 3_600_000);
  const { hoy, minutos } = relojLima(lima);
  const ctx = { hoy, minutos, dictado: "" };
  assert.equal(plan({ text: "X", due: "mañana" }, ctx).due, "2026-10-12");
  assert.equal(plan({ text: "X", due: "hoy" }, ctx).due, "2026-10-11");
  assert.equal(plan({ text: "X", due: "lunes" }, ctx).due, "2026-10-12");
  assert.equal(plan({ text: "X", due: "domingo" }, ctx).due, "2026-10-18", "un día de la semana es siempre el próximo, nunca hoy");
});

test("solo hora, sin fecha: hoy si falta, mañana si ya pasó", () => {
  assert.equal(plan({ text: "X", time: "17:00" }).due, "2026-10-11"); // son las 12:00
  assert.equal(plan({ text: "X", time: "9 am" }).due, "2026-10-12"); // las 9:00 ya pasaron
  assert.equal(plan({ text: "X", time: "12:00" }).due, "2026-10-12", "justo ahora ya pasó");
});

test("fechas dichas de otras maneras", () => {
  assert.equal(plan({ text: "X", due: "el jueves" }).due, "2026-10-15");
  assert.equal(plan({ text: "X", due: "viernes" }).due, "2026-10-16");
  assert.equal(plan({ text: "X", due: "15 de octubre" }).due, "2026-10-15");
  assert.equal(plan({ text: "X", due: "+3" }).due, "2026-10-14");
  assert.equal(plan({ text: "X", due: "2026-12-01" }).due, "2026-12-01");
  assert.equal(plan({ text: "X", due: "3 de octubre" }).due, "2027-10-03", "una fecha sin año ya pasada es la del año siguiente");
});

test("fecha u hora que no se entienden: pregunta, no adivina", () => {
  const f = respuesta({ text: "X", due: "cuando se pueda" });
  assert.equal(f.action, "clarify");
  assert.match(f.message, /No entendí la fecha «cuando se pueda»/);
  const h = respuesta({ text: "X", due: "mañana", time: "tardecito" });
  assert.equal(h.action, "clarify");
  assert.match(h.message, /No entendí la hora/);
  assert.equal(respuesta({ text: "   " }).action, "error");
  assert.equal(respuesta({}).action, "error");
});

test("«recuérdame / avísame»: el plan trae cuándo suena el aviso (día y hora de Lima; solo el día = 9:00)", () => {
  const futuro = plan({ text: "Llamar a Ana", due: "mañana", time: "17:00" }, { ...HOY, dictado: "recuérdame mañana a las 5 llamar a Ana" });
  assert.equal(futuro.pidioAviso, true);
  assert.deepEqual(futuro.recordar, { fecha: "2026-10-12", hora: "17:00", porDefecto: false });
  const sinHora = plan({ text: "Llamar a Ana", due: "viernes" }, { ...HOY, dictado: "Recuérdame llamar a Ana el viernes" });
  assert.deepEqual(sinHora.recordar, { fecha: "2026-10-16", hora: "09:00", porDefecto: true });
  // con hora y sin fecha: hoy, o mañana si esa hora ya pasó (la misma regla de la tarea)
  const hoyConHora = plan({ text: "X", due: "hoy", time: "18:00" }, { ...HOY, dictado: "avísame hoy a las 6" });
  assert.deepEqual(hoyConHora.recordar, { fecha: "2026-10-11", hora: "18:00", porDefecto: false });
  assert.deepEqual(plan({ text: "X", time: "18:00" }, { ...HOY, dictado: "recuérdame a las 6" }).recordar, { fecha: "2026-10-11", hora: "18:00", porDefecto: false });
  assert.equal(plan({ text: "X", time: "08:00" }, { ...HOY, dictado: "recuérdame a las 8" }).recordar?.fecha, "2026-10-12");
  // una tarea que espera a otra persona también avisa: ahora el aviso es real y no depende del resumen de las 7:00
  assert.equal(plan({ text: "Que Ana envíe el contrato", due: "mañana", with: "Ana" }, { ...HOY, dictado: "recuérdame que Ana envíe el contrato mañana" }).recordar?.fecha, "2026-10-12");
  // sin la palabra no hay aviso; con la palabra pero sin fecha lo pidió y falta el cuándo
  const sinPalabra = plan({ text: "X", due: "mañana" }, { ...HOY, dictado: "anota mañana llamar a Ana" });
  assert.deepEqual([sinPalabra.pidioAviso, sinPalabra.recordar], [false, null]);
  const sinFecha = plan({ text: "X" }, { ...HOY, dictado: "recuérdame algo" });
  assert.deepEqual([sinFecha.pidioAviso, sinFecha.recordar], [true, null]);
});

test("solo las formas dirigidas a Wabid piden un aviso; «avisar a Ana» dentro de una tarea no", () => {
  for (const si of ["recuérdame llamar a Ana", "Recuerdame llamar a Ana", "recuérdalo mañana", "avísame mañana a las 5", "Avisame cuando sea el viernes", "agrega la tarea y recuérdamelo el lunes"]) {
    assert.equal(PIDE_AVISO.test(si), true, si);
  }
  for (const no of ["agrega avisar a Ana del cambio", "anota que Ana me avise cuando termine", "pendiente: recordar la contraseña", "agéndame el recuerdo del viaje", "dile a Ana que me avise"]) {
    assert.equal(PIDE_AVISO.test(no), false, no);
  }
});

test("«recuérdame a las N» sin time: NO cae en las 9:00, vuelve a preguntar la hora (a las N, a la una, a las N y media)", () => {
  const casos: { caso: string; dictado: string; due: string }[] = [
    { caso: "a las N", dictado: "agéndame llamar a Ana mañana y recuérdame a las 5", due: "mañana" },
    { caso: "a la una", dictado: "recuérdame mañana a la una llamar a Ana", due: "mañana" },
    { caso: "a las N y media", dictado: "recuérdame el viernes a las 5 y media llamar a Ana", due: "viernes" },
  ];
  for (const { caso, dictado, due } of casos) {
    const r = respuesta({ text: "Llamar a Ana", due }, { ...HOY, dictado });
    assert.equal(r.action, "clarify", caso);
    assert.equal(r.message, "¿A qué hora te aviso? Dímela como las cinco de la tarde.", caso);
    assert.equal(r.voz, "¿A qué hora te aviso?", caso);
    assert.ok(prepararVoz(r.voz ?? "").length <= VOZ_MAX && prepararVoz(r.voz ?? "").endsWith("?"), caso);
  }
  // sin día ni hora pasados, pero con la hora en el dictado, también pregunta (si no, quedaría «sin fecha» y se perdería la hora dicha)
  assert.equal(respuesta({ text: "Llamar a Ana" }, { ...HOY, dictado: "recuérdame a las 5 llamar a Ana" }).action, "clarify");
  // palabras y números: «a las cinco», «a las 10:30», «a las 5pm»
  for (const si of ["a las 5", "a las cinco de la tarde", "a las 10:30", "a las 5pm", "a las doce", "a la una", "A LAS 9", "a la 1"]) assert.equal(HORA_EN_TEXTO.test(si), true, si);
  for (const no of ["a las afueras", "a la mañana siguiente", "para las 5", "llamar a Ana", "a las mil maravillas", "a lasagna"]) assert.equal(HORA_EN_TEXTO.test(no), false, no);
});

test("lo anterior solo ocurre si falta la hora Y se pidió aviso: con time, sin mencionar hora o sin «recuérdame» sigue el camino de siempre", () => {
  // la hora llegó en time: se programa a esa hora
  const conHora = plan({ text: "Llamar a Ana", due: "mañana", time: "17:00" }, { ...HOY, dictado: "agéndame llamar a Ana mañana y recuérdame a las 5" });
  assert.deepEqual(conHora.recordar, { fecha: "2026-10-12", hora: "17:00", porDefecto: false });
  // sin hora en el dictado: las 9:00 por defecto (David no dijo otra)
  assert.deepEqual(
    plan({ text: "Llamar a Ana", due: "viernes" }, { ...HOY, dictado: "recuérdame el viernes llamar a Ana" }).recordar,
    { fecha: "2026-10-16", hora: "09:00", porDefecto: true },
  );
  // la hora en el texto pero sin pedir aviso: la tarea se anota como siempre (sin hora y sin preguntar)
  const sinAviso = plan({ text: "Llamar a Ana", due: "mañana" }, { ...HOY, dictado: "agéndame llamar a Ana mañana a las 5" });
  assert.deepEqual([sinAviso.pidioAviso, sinAviso.recordar], [false, null]);
  // «avisar a Ana a las 5» dentro del texto de una tarea no es un pedido de aviso
  assert.equal(plan({ text: "Avisar a Ana", due: "mañana" }, { ...HOY, dictado: "agrega avisar a Ana a las 5 mañana" }).pidioAviso, false);
});
