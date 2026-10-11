// node --experimental-strip-types --test supabase/functions/agent/tools/avisosPlan.test.ts
// Cuándo suena un recordatorio, en hora de Lima: hoy / mañana / «el jueves», hora ya pasada, medianoche (22:30 de Lima ya es el día
// siguiente en UTC), cambio de mes, «en N minutos», y a cuál recordatorio se refiere «cancela…». `ahora` es siempre un instante real.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buscarRecordatorio, enMinutosHablado, type FilaAviso, fraseAvisoTarea, fraseCreado, fraseLista, HORA_POR_DEFECTO, limpiarTitulo, palabrasClave,
  planDeTarea, planearRecordatorio, type PlanRecordatorio, preguntaCual,
} from "./avisosPlan.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { loQueSeDice } from "../respuesta.ts";

// Domingo 11 de octubre de 2026, 12:00 en Lima (17:00 UTC).
const DOMINGO = new Date("2026-10-11T17:00:00Z");
const plan = (args: Record<string, unknown>, ahora = DOMINGO): PlanRecordatorio => {
  const r = planearRecordatorio(args, { ahora });
  assert.ok("plan" in r, `se esperaba un plan y salió ${JSON.stringify("respuesta" in r ? r.respuesta : r)}`);
  return r.plan;
};
const pregunta = (args: Record<string, unknown>, ahora = DOMINGO) => {
  const r = planearRecordatorio(args, { ahora });
  assert.ok("respuesta" in r, `se esperaba una pregunta o un error y salió ${JSON.stringify("plan" in r ? r.plan : r)}`);
  return r.respuesta;
};
const iso = (p: PlanRecordatorio) => p.cuando.toISOString();

test("«recuérdame llamar a Marco a las 5» (hoy, 17:00 de Lima) suena a las 22:00 UTC", () => {
  const p = plan({ text: "llamar a Marco", time: "17:00" });
  assert.equal(iso(p), "2026-10-11T22:00:00.000Z");
  assert.equal(p.titulo, "Llamar a Marco");
  assert.deepEqual([p.fecha, p.hora, p.horaPorDefecto], ["2026-10-11", "17:00", false]);
  assert.equal(p.hablado, "hoy a las cinco de la tarde");
});

test("solo la hora: si aún no pasó es hoy; si ya pasó, mañana", () => {
  assert.equal(iso(plan({ text: "X", time: "18:30" })), "2026-10-11T23:30:00.000Z");
  const pasada = plan({ text: "X", time: "09:00" });
  assert.equal(iso(pasada), "2026-10-12T14:00:00.000Z", "las 9:00 de hoy ya pasaron: mañana");
  assert.equal(pasada.hablado, "mañana a las nueve de la mañana");
  assert.equal(pasada.horaPorDefecto, false, "la hora la dijo David");
  assert.equal(iso(plan({ text: "X", time: "12:00" })), "2026-10-12T17:00:00.000Z", "las 12:00 en punto ya son: mañana");
});

test("«el jueves a las 9»: el próximo jueves (15 de octubre) a las 9:00 de Lima", () => {
  const p = plan({ text: "Revisar el simulador", due: "jueves", time: "09:00" });
  assert.equal(iso(p), "2026-10-15T14:00:00.000Z");
  assert.equal(p.hablado, "el jueves 15 de octubre a las nueve de la mañana");
  // si hoy es jueves, «el jueves» es el de la semana siguiente
  const jueves = new Date("2026-10-15T17:00:00Z");
  assert.equal(plan({ text: "X", due: "jueves", time: "09:00" }, jueves).fecha, "2026-10-22");
});

test("mañana, pasado mañana y +N salen a la hora pedida", () => {
  assert.equal(iso(plan({ text: "X", due: "mañana", time: "08:00" })), "2026-10-12T13:00:00.000Z");
  assert.equal(plan({ text: "X", due: "pasado mañana", time: "08:00" }).fecha, "2026-10-13");
  assert.equal(plan({ text: "X", due: "+3", time: "08:00" }).fecha, "2026-10-14");
});

test("solo el día: suena a las 9:00 (por defecto); hoy sin hora, con las 9:00 ya pasadas, pregunta", () => {
  const p = plan({ text: "Pagar la luz", due: "viernes" });
  assert.deepEqual([p.fecha, p.hora, p.horaPorDefecto], ["2026-10-16", HORA_POR_DEFECTO, true]);
  assert.equal(iso(p), "2026-10-16T14:00:00.000Z");
  const hoy = pregunta({ text: "X", due: "hoy" });
  assert.equal(hoy.action, "clarify");
  assert.match(hoy.message, /nueve de hoy ya pasaron/);
  // antes de las 9:00 de Lima, «hoy» sí vale
  assert.equal(iso(plan({ text: "X", due: "hoy" }, new Date("2026-10-11T11:00:00Z"))), "2026-10-11T14:00:00.000Z");
});

test("medianoche: a las 22:30 de Lima (03:30 UTC del día siguiente) «hoy» y «mañana» siguen siendo los de Lima", () => {
  const noche = new Date("2026-10-12T03:30:00Z"); // domingo 11, 22:30 en Lima
  assert.equal(iso(plan({ text: "X", due: "hoy", time: "23:00" }, noche)), "2026-10-12T04:00:00.000Z");
  assert.equal(plan({ text: "X", due: "hoy", time: "23:00" }, noche).hablado, "hoy a las once de la noche");
  assert.equal(iso(plan({ text: "X", due: "mañana", time: "08:00" }, noche)), "2026-10-12T13:00:00.000Z");
  assert.equal(plan({ text: "X", due: "mañana", time: "08:00" }, noche).fecha, "2026-10-12");
  // la hora sola «00:10» cuando son las 22:30: es la de esta madrugada (mañana en Lima), no «hoy» a las 00:10
  assert.equal(plan({ text: "X", time: "00:10" }, noche).fecha, "2026-10-12");
  assert.equal(iso(plan({ text: "X", time: "00:10" }, noche)), "2026-10-12T05:10:00.000Z");
});

test("cambio de mes: a las 23:50 del 31 de octubre, «00:10» y «en 30 minutos» caen el 1 de noviembre; «hoy 23:55» sigue siendo octubre", () => {
  const finDeMes = new Date("2026-11-01T04:50:00Z"); // 31-oct 23:50 en Lima
  const madrugada = plan({ text: "X", time: "00:10" }, finDeMes);
  assert.deepEqual([madrugada.fecha, madrugada.hora, iso(madrugada)], ["2026-11-01", "00:10", "2026-11-01T05:10:00.000Z"]);
  const media = plan({ text: "X", en_minutos: 30 }, finDeMes);
  assert.deepEqual([media.fecha, media.hora, media.hablado], ["2026-11-01", "00:20", "en 30 minutos"]);
  const casi = plan({ text: "X", due: "hoy", time: "23:55" }, finDeMes);
  assert.deepEqual([casi.fecha, iso(casi)], ["2026-10-31", "2026-11-01T04:55:00.000Z"]);
  assert.equal(plan({ text: "X", due: "mañana", time: "08:00" }, finDeMes).fecha, "2026-11-01");
  assert.equal(plan({ text: "X", due: "1 de noviembre", time: "08:00" }, finDeMes).fecha, "2026-11-01");
  assert.equal(plan({ text: "X", due: "fin de mes", time: "23:59" }, finDeMes).fecha, "2026-10-31");
});

test("«en N minutos»: relativo a ahora, sin día ni hora; con día u hora se ignora", () => {
  assert.equal(iso(plan({ text: "Sacar la pizza", en_minutos: 20 })), "2026-10-11T17:20:00.000Z");
  assert.equal(plan({ text: "X", en_minutos: "20" }).hablado, "en 20 minutos", "el modelo a veces manda el número como texto");
  assert.equal(enMinutosHablado(1), "en un minuto");
  assert.equal(enMinutosHablado(60), "en una hora");
  assert.equal(enMinutosHablado(120), "en 2 horas");
  assert.equal(enMinutosHablado(90), "en 90 minutos");
  assert.equal(enMinutosHablado(1440), "en un día");
  for (const malo of [0, -5, "abc", 7 * 24 * 60 + 1, Number.NaN]) {
    const r = pregunta({ text: "X", en_minutos: malo });
    assert.equal(r.action, "clarify", String(malo));
  }
  assert.equal(iso(plan({ text: "X", en_minutos: 20, time: "18:00" })), "2026-10-11T23:00:00.000Z", "si dio hora, manda la hora");
  // El modelo a veces añade un día (due: "hoy" / "mañana") a «en 20 minutos»: sin time, en_minutos gana y el día se ignora.
  const conDia = plan({ text: "Sacar la pizza", en_minutos: 20, due: "hoy" });
  assert.deepEqual([iso(conDia), conDia.hablado], ["2026-10-11T17:20:00.000Z", "en 20 minutos"]);
  assert.equal(iso(plan({ text: "X", en_minutos: 20, due: "mañana" })), "2026-10-11T17:20:00.000Z", "aunque el día sea otro");
  // Sin en_minutos, un día solo sigue siendo las 9:00 (y hoy con las 9:00 ya pasadas, se pregunta).
  assert.equal(pregunta({ text: "X", due: "hoy" }).action, "clarify");
});

test("lo que no se entiende o ya pasó se pregunta, no se adivina", () => {
  assert.equal(pregunta({ text: "X" }).message, "¿Cuándo te aviso? Dime el día o la hora.");
  assert.equal(pregunta({ text: "X" }).voz, "¿Cuándo te aviso?");
  assert.match(pregunta({ text: "X", time: "tardecito" }).message, /No entendí la hora/);
  assert.match(pregunta({ text: "X", due: "cuando se pueda", time: "10:00" }).message, /No entendí la fecha «cuando se pueda»/);
  assert.match(pregunta({ text: "X", due: "2026-10-01", time: "10:00" }).message, /Esa hora ya pasó/);
  assert.match(pregunta({ text: "X", due: "hoy", time: "11:00" }).message, /Esa hora ya pasó/);
  assert.match(pregunta({ text: "X", due: "2028-01-01", time: "10:00" }).message, /más de un año/);
  assert.equal(pregunta({ text: "   ", time: "17:00" }).action, "error");
  assert.equal(pregunta({ time: "17:00" }).action, "error");
});

test("limpiarTitulo: una línea, mayúscula inicial, sin punto final ni marcado, máximo 120", () => {
  assert.equal(limpiarTitulo("  llamar a marco.  "), "Llamar a marco");
  assert.equal(limpiarTitulo("revisar\n**el** `simulador`\t!"), "Revisar el simulador");
  assert.equal(limpiarTitulo("   "), "");
  assert.equal(limpiarTitulo(undefined), "");
  const largo = limpiarTitulo("a".repeat(300));
  assert.equal(largo.length, 120);
  assert.ok(largo.endsWith("…"));
});

test("frases: pantalla con el título, voz con solo el cuándo y siempre dentro del tope de voz", () => {
  const p = plan({ text: "Revisar el simulador de nova fondos con el equipo de normativa", due: "jueves", time: "09:00" });
  const f = fraseCreado(p);
  assert.equal(f.message, "Hecho. Te aviso el jueves 15 de octubre a las nueve de la mañana: «Revisar el simulador de nova fondos con el equipo».", "la pantalla acorta el título a 60 sin partir palabras");
  assert.equal(p.titulo, "Revisar el simulador de nova fondos con el equipo de normativa", "pero el aviso guardado lleva el título completo");
  assert.equal(f.voz, "Hecho, te aviso el jueves 15 de octubre a las nueve de la mañana.");
  assert.ok(prepararVoz(f.voz).length <= VOZ_MAX);
  assert.match(fraseCreado(p, true).message, /^Ya lo tenía anotado\./);
  // el peor caso de fecha larga sigue cabiendo
  const largo = plan({ text: "X", due: "2027-10-05", time: "20:45" });
  assert.ok(prepararVoz(fraseCreado(largo).voz).length <= VOZ_MAX, fraseCreado(largo).voz);
});

const fila = (id: string, titulo: string, cuando: string, extra: Partial<FilaAviso> = {}): FilaAviso => ({ aviso_id: id, titulo, cuando, origen: "recordatorio", ...extra });

test("lista: vacía, una y varias; la voz dice cuántas y la próxima", () => {
  assert.equal(fraseLista([], DOMINGO).message, "No tienes recordatorios pendientes.");
  const una = fraseLista([fila("1", "Llamar a Marco", "2026-10-11T22:00:00Z")], DOMINGO);
  assert.equal(una.message, "Tienes 1 recordatorio: «Llamar a Marco» hoy a las cinco de la tarde.");
  assert.equal(una.voz, "Tienes uno: Llamar a Marco, hoy a las cinco de la tarde.");
  const varias = fraseLista([fila("1", "Llamar a Marco", "2026-10-11T22:00:00Z"), fila("2", "Revisar el simulador", "2026-10-15T14:00:00Z")], DOMINGO);
  assert.equal(varias.message, "Tienes 2 recordatorios: «Llamar a Marco» hoy a las cinco de la tarde; «Revisar el simulador» el jueves 15 de octubre a las nueve de la mañana.");
  assert.equal(varias.voz, "Tienes 2. El próximo: Llamar a Marco, hoy a las cinco de la tarde.");
  for (const r of [una, varias]) assert.ok(prepararVoz(loQueSeDice({ message: r.message, voz: r.voz })).length <= VOZ_MAX);
});

test("cancelar: palabras, tildes, único sin palabras, empates y nada", () => {
  const filas = [
    fila("1", "Llamar a Marco", "2026-10-11T22:00:00Z"),
    fila("2", "Revisar el simulador", "2026-10-15T14:00:00Z", { origen: "tarea", tarea_texto: "Revisar el simulador de Novafondos" }),
    fila("3", "Llamar a Ana", "2026-10-16T14:00:00Z"),
  ];
  const uno = (s: unknown) => {
    const b = buscarRecordatorio(s, filas);
    assert.equal(b.kind, "one", `«${s}» → ${b.kind}`);
    return b.kind === "one" ? b.fila.aviso_id : "";
  };
  assert.equal(uno("el recordatorio de Marco"), "1");
  assert.equal(uno("simulador"), "2");
  assert.equal(uno("novafondos"), "2", "también busca en el texto de la tarea");
  assert.equal(uno("LLAMAR a MARCO"), "1");
  assert.equal(uno("el de Ana"), "3");
  assert.equal(buscarRecordatorio("llamar", filas).kind, "many", "dos llamadas: se pregunta");
  assert.equal(buscarRecordatorio("", filas).kind, "many", "sin palabras y con varios: se pregunta");
  assert.equal(buscarRecordatorio("el recordatorio", filas).kind, "many", "«recordatorio» no es una palabra clave");
  assert.equal(buscarRecordatorio("dentista", filas).kind, "none");
  assert.equal(buscarRecordatorio("dentista", []).kind, "none");
  const solo = buscarRecordatorio("el recordatorio", [filas[0]!]);
  assert.equal(solo.kind === "one" && solo.fila.aviso_id, "1", "con uno solo, sin palabras es ese");
  // la mitad de las palabras alcanza solo si es el único que las tiene
  assert.equal(buscarRecordatorio("simulador reunión", filas).kind, "one");
  assert.deepEqual(palabrasClave("Cancela el recordatorio de la reunión con Ñandú"), ["cancela", "reunion", "nandu"]);
  const q = preguntaCual(filas.slice(0, 3));
  assert.equal(q.message, "¿Cuál recordatorio: «Llamar a Marco», «Revisar el simulador» o «Llamar a Ana»?");
  assert.ok(q.voz.endsWith("?") && prepararVoz(q.voz).length <= VOZ_MAX);
});

test("recordatorio de una tarea: planDeTarea respeta la hora; pasada, no programa; la frase confirma sin repetir lo que la tarea ya dijo", () => {
  const ok = planDeTarea("Llamar a Ana", { fecha: "2026-10-12", hora: "17:00", porDefecto: false }, DOMINGO);
  assert.ok("plan" in ok);
  assert.equal(ok.plan.cuando.toISOString(), "2026-10-12T22:00:00.000Z");
  assert.equal(ok.plan.titulo, "Llamar a Ana");
  assert.deepEqual(fraseAvisoTarea(ok.plan, "creado"), { message: " Te aviso a esa hora.", voz: " Te aviso." });
  const nueve = planDeTarea("Llamar a Ana", { fecha: "2026-10-12", hora: "09:00", porDefecto: true }, DOMINGO);
  assert.ok("plan" in nueve);
  assert.deepEqual(fraseAvisoTarea(nueve.plan, "creado"), { message: " Te aviso a las nueve de la mañana.", voz: " Te aviso a las nueve de la mañana." });
  assert.deepEqual(planDeTarea("X", { fecha: "2026-10-11", hora: "09:00", porDefecto: true }, DOMINGO), { pasado: true });
  assert.deepEqual(planDeTarea("X", { fecha: "2026-10-11", hora: "12:00", porDefecto: false }, DOMINGO), { pasado: true }, "la hora en punto ya pasó");
  assert.match(fraseAvisoTarea(ok.plan, "lleno").message, /50 recordatorios/);
  assert.equal(fraseAvisoTarea(ok.plan, "error").message, " No pude programar el aviso.");
});
