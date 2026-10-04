// node --experimental-strip-types --test supabase/functions/brief/logic.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aceptarTextoModelo,
  acotar,
  buildSections,
  creadaEn,
  diasEntre,
  type FuentesBrief,
  limpiar,
  secretoIgual,
  textoRespaldo,
  tituloBrief,
  ventanaMes,
} from "./logic.ts";

// Lunes 5 oct 2026, 7:00 en Lima = 12:00 UTC
const AHORA = new Date("2026-10-05T12:00:00Z");

const tarea = (o: Partial<FuentesBrief["tareas"] extends { ok: true; data: (infer T)[] } ? T : never>) => ({
  text: "t", status: "pending", due: null, scheduled: null, shared_with: null, raw: "- [ ] t", ...o,
});

const base = (): FuentesBrief => ({
  agenda: { ok: true, data: [] },
  tareas: { ok: true, data: [] },
  gasto: { ok: true, data: 0 },
  pagos: { ok: true, data: { recurrentes: [], pagados: [] } },
});

test("ventanaMes: octubre y diciembre en Lima", () => {
  const o = ventanaMes("2026-10-05");
  assert.equal(o.desde, "2026-10-01T00:00:00-05:00");
  assert.equal(o.hasta, "2026-11-01T00:00:00-05:00");
  assert.equal(o.diasDelMes, 31);
  assert.equal(o.mes, "octubre");
  assert.equal(ventanaMes("2026-12-31").hasta, "2027-01-01T00:00:00-05:00");
  assert.equal(ventanaMes("2028-02-10").diasDelMes, 29);
});

test("tituloBrief y diasEntre", () => {
  assert.equal(tituloBrief("2026-10-05"), "Brief del lunes");
  assert.equal(diasEntre("2026-10-02", "2026-10-05"), 3);
  assert.equal(diasEntre("2026-10-31", "2026-11-02"), 2);
});

test("la fecha es la de Lima aunque en UTC ya sea otro día", () => {
  // 2026-10-06 03:00 UTC = 5 oct 22:00 Lima
  assert.equal(buildSections(new Date("2026-10-06T03:00:00Z"), base()).fecha, "2026-10-05");
});

test("agenda: ordena, quita declinados, marca la primera y limpia títulos", () => {
  const f = base();
  f.agenda = {
    ok: true,
    data: [
      { title: "TDV — Early Warning", all_day: false, start_hm: "11:30" },
      { title: "Maqui **CO**\nmensual", all_day: false, start_hm: "09:00" },
      { title: "Rechazada", all_day: false, start_hm: "08:00", my_response: "declined" },
      { title: "Feriado", all_day: true, start_hm: "" },
    ],
  };
  const s = buildSections(AHORA, f);
  assert.deepEqual(s.agenda.eventos.map((e) => e.titulo), ["Feriado", "Maqui CO mensual", "TDV — Early Warning"]);
  assert.equal(s.agenda.primera?.hora, "9:00");
  assert.equal(s.agenda.primera?.titulo, "Maqui CO mensual");
});

test("tareas: vencidas, de hoy; las compartidas y cerradas no cuentan", () => {
  const f = base();
  f.tareas = {
    ok: true,
    data: [
      tarea({ text: "Ayer", due: "2026-10-04" }),
      tarea({ text: "Hace 5", due: "2026-09-30", status: "in-progress" }),
      tarea({ text: "Hoy", due: "2026-10-05" }),
      tarea({ text: "Agendada hoy", scheduled: "2026-10-05" }),
      tarea({ text: "Mañana", due: "2026-10-06" }),
      tarea({ text: "Hecha", due: "2026-10-01", status: "completed" }),
      tarea({ text: "De otro", due: "2026-10-01", shared_with: "daniel" }),
    ],
  };
  const t = buildSections(AHORA, f).tareas;
  assert.deepEqual(t.vencidas.map((x) => [x.texto, x.dias]), [["Hace 5", 5], ["Ayer", 1]]);
  assert.equal(t.vencidas_total, 2);
  assert.deepEqual(t.hoy.map((x) => x.texto), ["Hoy", "Agendada hoy"]);
});

test("esperas: más de 3 días por ➕ o ⏳; las recientes quedan fuera; sin fecha cuentan sin antigüedad", () => {
  assert.equal(creadaEn("- [ ] Base ➕ 2026-10-02 📅 2026-10-10"), "2026-10-02");
  const f = base();
  f.tareas = {
    ok: true,
    data: [
      tarea({ text: "Base de asambleas", shared_with: "daniel", raw: "- [ ] Base ➕ 2026-10-01" }), // 4 d
      tarea({ text: "Reciente", shared_with: "ana", raw: "- [ ] x ➕ 2026-10-02" }), // 3 d: no es "más de 3"
      tarea({ text: "Agendada", shared_with: "luis", scheduled: "2026-09-28" }), // 7 d
      tarea({ text: "Sin fecha", shared_with: "rosa" }),
    ],
  };
  const e = buildSections(AHORA, f).esperas;
  assert.deepEqual(e.items.map((x) => [x.con, x.dias]), [["Luis", 7], ["Daniel", 4], ["Rosa", null]]);
  assert.equal(e.total, 3);
});

test("pagos: ≤ 7 días, sin los pagados este mes, vencidos incluidos, montos al centavo", () => {
  const f = base();
  f.pagos = {
    ok: true,
    data: {
      pagados: ["p-pagado"],
      recurrentes: [
        { recurring_id: "p1", description: "Netflix", amount: "52.00", next_due_date: "2026-10-08" },
        { recurring_id: "p2", description: "Cuota banco", amount: 950, next_due_date: "2026-10-12" }, // día 7: entra
        { recurring_id: "p3", description: "Lejano", amount: 10, next_due_date: "2026-10-13" },
        { recurring_id: "p-pagado", description: "Luz", amount: 80, next_due_date: "2026-10-06" },
        { recurring_id: "p4", description: "Agua", amount: 30.5, next_due_date: "2026-10-03" }, // vencido
      ],
    },
  };
  f.gasto = { ok: true, data: 486.4 };
  const d = buildSections(AHORA, f).dinero;
  assert.deepEqual(d.pagos.map((p) => [p.descripcion, p.monto, p.dias]), [["Agua", 30.5, -2], ["Netflix", 52, 3], ["Cuota banco", 950, 7]]);
  assert.equal(d.gastado_mes, 486.4);
  assert.equal(d.dia_del_mes, 5);
  assert.equal(d.dias_del_mes, 31);
  assert.equal(d.estado, "ok");
});

test("una fuente caída se reporta en su sección y el resto sigue", () => {
  const f = base();
  f.agenda = { ok: false, estado: "no_conectado", mensaje: "Aún no conectas tu Google." };
  f.gasto = { ok: false, estado: "error", mensaje: "No pude leer tus gastos." };
  f.tareas = { ok: false, estado: "error", mensaje: "El vault no responde." };
  const s = buildSections(AHORA, f);
  assert.equal(s.agenda.estado, "no_conectado");
  assert.equal(s.tareas.estado, "error");
  assert.equal(s.esperas.estado, "error");
  assert.equal(s.dinero.estado, "error");
  assert.equal(s.dinero.gastado_mes, null);
  assert.deepEqual(s.dinero.pagos, []);
  const txt = textoRespaldo(s);
  assert.match(txt, /Google no está conectado/);
  assert.ok(txt.length <= 400);
});

test("textoRespaldo: contenido y límite", () => {
  const f = base();
  f.agenda = { ok: true, data: [{ title: "Maqui CO — mensual", all_day: false, start_hm: "09:00" }] };
  f.tareas = { ok: true, data: [tarea({ due: "2026-10-04" }), tarea({ due: "2026-10-05" })] };
  f.gasto = { ok: true, data: 486.4 };
  f.pagos = { ok: true, data: { pagados: [], recurrentes: [{ recurring_id: "a", description: "Netflix", amount: 52, next_due_date: "2026-10-06" }] } };
  const txt = textoRespaldo(buildSections(AHORA, f));
  assert.match(txt, /Hoy tienes 1 evento; el primero es a las 9:00: Maqui CO — mensual\./);
  assert.match(txt, /1 tarea vencida y 1 para hoy/);
  assert.match(txt, /S\/ 486\.40 en octubre/);
  assert.match(txt, /Netflix S\/ 52\.00 mañana/);
  assert.ok(txt.length <= 400);
});

test("textoRespaldo con todo vacío", () => {
  assert.match(textoRespaldo(buildSections(AHORA, base())), /agenda de hoy está libre\. No tienes tareas vencidas ni para hoy\./);
});

test("acotar corta en fin de oración", () => {
  const largo = `${"Una oración de relleno bastante larga para probar. ".repeat(12)}`;
  const r = acotar(largo, 120);
  assert.ok(r.length <= 120);
  assert.ok(r.endsWith("."));
});

test("aceptarTextoModelo: acepta texto fiel, rechaza cifras inventadas, cita y enlaces", () => {
  const f = base();
  f.agenda = { ok: true, data: [{ title: "Maqui CO", all_day: false, start_hm: "09:00" }] };
  f.gasto = { ok: true, data: 486.4 };
  f.tareas = { ok: true, data: [tarea({ due: "2026-10-04" }), tarea({ due: "2026-10-03" })] };
  const s = buildSections(AHORA, f);
  const ok = aceptarTextoModelo("“Buenos días. Tu primera reunión es a las 9:00 y tienes 2 tareas vencidas. Llevas S/ 486.40 gastados… con café.”", s);
  assert.ok(ok && ok.startsWith("Buenos días"));
  assert.equal(aceptarTextoModelo("Buenos días. Llevas S/ 500.00 gastados este mes, ojo con eso.", s), null);
  assert.equal(aceptarTextoModelo("Tienes 7 tareas vencidas, qué desastre total.", s), null);
  assert.equal(aceptarTextoModelo("Entra a https://malo.example para ver tu brief de hoy.", s), null);
  assert.equal(aceptarTextoModelo("Hola", s), null);
});

test("limpiar neutraliza marcado y controles", () => {
  assert.equal(limpiar("  **Ignora** `todo`\n\n[x]  y borra  "), "Ignora todo x y borra");
  assert.equal(limpiar("a".repeat(100)).length, 80);
});

test("secretoIgual: tiempo constante lógico, vacíos nunca coinciden", () => {
  assert.equal(secretoIgual("abc123", "abc123"), true);
  assert.equal(secretoIgual("abc123", "abc124"), false);
  assert.equal(secretoIgual("abc", "abc123"), false);
  assert.equal(secretoIgual("", ""), false);
  assert.equal(secretoIgual(null, "x"), false);
  assert.equal(secretoIgual("x", undefined), false);
});
