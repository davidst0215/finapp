// node --experimental-strip-types --test supabase/functions/agent/tools/tareasPlan.test.ts
// Decisiones de «agendar un pendiente»: proyecto, vencimiento en hora de Lima y qué preguntar. Hoy en estas pruebas es
// domingo 2026-10-11 (Lima); el servidor corre en UTC y recibe `limaNow` ya corrido −5 h.
import test from "node:test";
import assert from "node:assert/strict";
import { planearTarea, type PlanTarea } from "./tareasPlan.ts";
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

test("«maqui perú» sin frente es ambiguo; «tdv bolsa» y «lota visión» no", () => {
  const pe = respuesta({ text: "Algo", project: "Maqui Perú" });
  assert.equal(pe.action, "clarify");
  assert.match(pe.message, /^¿En qué frente de Maqui PE: aprobaciones o scoring\?$/);
  assert.equal(plan({ text: "X", project: "TDV bolsa" }).folder, "tdv-bolsa-de-costos");
  assert.equal(plan({ text: "X", project: "lota visión" }).folder, "lota");
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

test("«recuérdame»: no promete una alarma que no existe", () => {
  const futuro = plan({ text: "Llamar a Ana", due: "mañana", time: "17:00" }, { ...HOY, dictado: "recuérdame mañana a las 5 llamar a Ana" });
  assert.equal(futuro.recordatorio, " Te lo recordará el resumen de las 7:00 de ese día; aún no te aviso a la hora exacta.");
  const sinHora = plan({ text: "Llamar a Ana", due: "viernes" }, { ...HOY, dictado: "Recuérdame llamar a Ana el viernes" });
  assert.equal(sinHora.recordatorio, " Te lo recordará el resumen de las 7:00 de ese día.");
  const hoyConHora = plan({ text: "X", due: "hoy", time: "18:00" }, { ...HOY, dictado: "avísame hoy a las 6" });
  assert.equal(hoyConHora.recordatorio, " Aún no te aviso a la hora exacta.");
  // sin la palabra, o sin fecha, no se dice nada
  assert.equal(plan({ text: "X", due: "mañana" }, { ...HOY, dictado: "anota mañana llamar a Ana" }).recordatorio, "");
  assert.equal(plan({ text: "X" }, { ...HOY, dictado: "recuérdame algo" }).recordatorio, "");
});
