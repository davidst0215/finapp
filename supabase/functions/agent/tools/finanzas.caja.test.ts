// node --experimental-strip-types --test supabase/functions/agent/tools/finanzas.caja.test.ts
// Cerebro de caja en el agente (SPEC-cerebro.md): el contexto arma la entrada del motor, «¿cuánto puedo gastar?» responde con él,
// cada gasto dice cuánto le queda a su bolsa y los pagos de una sola vez se cierran al pagarse. Base falsa: nada toca Supabase.
import "./testlib.ts"; // instala Deno.env antes de cargar los módulos
import test from "node:test";
import assert from "node:assert/strict";
import { finanzas } from "./finanzas.ts";
import { fakeDb as fakeDbLeer } from "./testlib.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { loQueSeDice } from "../respuesta.ts";
import type { EntradaCaja } from "../../_shared/caja.ts";
import type { AgentContext } from "../types.ts";

type Fila = Record<string, unknown>;
// Lima, sábado 24-oct-2026 al mediodía (limaNow lleva la hora de Lima en sus campos UTC, como en agent/index.ts).
const ctx = (db: unknown): AgentContext =>
  ({ supabase: db as AgentContext["supabase"], user: { id: "u1" } as AgentContext["user"], text: "dictado", limaNow: new Date("2026-10-24T12:00:00Z") });
const h = finanzas.handlers;

/** Base en memoria: lectura con orden real (para ver qué pago elige) y escrituras registradas. */
function base(tablas: Record<string, Fila[]> = {}) {
  const inserts: { table: string; row: Fila }[] = [];
  const updates: { table: string; row: Fila; donde: [string, unknown] }[] = [];
  const db = {
    from: (table: string) => {
      let data = tablas[table] ?? [];
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => ((data = data.filter((r) => r[c] === v)), b),
        ilike: (c: string, pat: string) => ((data = data.filter((r) => String(r[c]).toLowerCase().includes(pat.replaceAll("%", "").toLowerCase()))), b),
        order: (c: string) => ((data = [...data].sort((x, y) => String(x[c]).localeCompare(String(y[c])))), b),
        limit: (n: number) => ((data = data.slice(0, n)), b),
        insert: (row: Fila) => {
          inserts.push({ table, row });
          const res = { data: { transaction_id: "t1", ...row }, error: null };
          return Object.assign(Promise.resolve(res), { select: () => ({ single: async () => res }) });
        },
        update: (row: Fila) => ({ eq: async (c: string, v: unknown) => (updates.push({ table, row, donde: [c, v] }), { error: null }) }),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok, ko),
      };
      return b;
    },
  };
  return { db, inserts, updates };
}

const CAJA: EntradaCaja = {
  hoy: "2026-10-24", caja: 470,
  programados: [
    { id: "tel", concepto: "Teléfono", tipo: "expense", monto: 50, frecuencia: "monthly", dia: 22, proxima: "2026-10-22", fin: null },
    { id: "internet", concepto: "Internet", tipo: "expense", monto: 120, frecuencia: "monthly", dia: 28, proxima: "2026-10-28", fin: null },
    { id: "sueldo", concepto: "Sueldo", tipo: "income", monto: 3830, frecuencia: "monthly", dia: 31, proxima: "2026-10-31", fin: null },
  ],
  bolsas: [
    { nombre: "Comida", topeSemanal: 200, categorias: ["Alimentación"], arrastre: false },
    { nombre: "Compras y otros", topeSemanal: 100, categorias: null, arrastre: false },
    { nombre: "Gasolina", topeSemanal: 81, categorias: ["Transporte"], arrastre: true },
  ],
  gastos: [],
  plan: { inicio: "2026-10-24", metaMonto: null, metaFecha: null, colchon: 0 },
};
const acc = { account_id: "deb", account_name: "Tarjeta débito", account_type: "checking", currency_code: "PEN", current_balance: 470 };
const data = (extra: Fila = {}) =>
  ({
    accounts: [acc], categories: [{ category_id: "c1", category_name: "Alimentación", category_type: "expense" }, { category_id: "c2", category_name: "Transporte", category_type: "expense" }],
    goals: [], recurring: [], paidIds: new Set<string>(), recurrentesOk: true, tc: null, caja: CAJA, ...extra,
  }) as unknown as Parameters<typeof h.create_transaction>[2];

test("loadContext arma el plan: caja sin tarjetas, pagos y cobros separados, gastos de la semana y el PLAN DE CAJA en el prompt", async () => {
  const { db } = fakeDbLeer({
    accounts: [
      { user_id: "u1", ...acc, is_active: true, created_at: "2026-10-12T00:00:00Z" },
      { user_id: "u1", account_id: "io", account_name: "Tarjeta iO", account_type: "credit_card", currency_code: "PEN", current_balance: 300, is_active: true, created_at: "2026-10-12T00:00:01Z" },
    ],
    recurring_transactions: [
      { user_id: "u1", is_active: true, recurring_id: "tel", description: "Teléfono", amount: 50, currency_code: "PEN", frequency: "monthly", next_due_date: "2026-10-22", transaction_type: "expense", day_of_month: 22, end_date: null },
      { user_id: "u1", is_active: true, recurring_id: "sueldo", description: "Sueldo", amount: 3830, currency_code: "PEN", frequency: "monthly", next_due_date: "2026-10-31", transaction_type: "income", day_of_month: 31, end_date: null },
    ],
    plan_caja: [{ user_id: "u1", inicio: "2026-10-24", meta_monto: 10500, meta_fecha: "2026-12-31", colchon: 0 }],
    bolsas: [
      { user_id: "u1", nombre: "Comida", tope_semanal: 200, categorias: ["Alimentación"], arrastre: false, orden: 1, tope_nuevo: null, tope_nuevo_desde: null },
      { user_id: "u1", nombre: "Compras y otros", tope_semanal: 100, categorias: null, arrastre: false, orden: 2, tope_nuevo: 70, tope_nuevo_desde: "2026-11-16" },
    ],
    // La categoría embebida no la proyecta la base falsa: el gasto llega sin categoría y va a la bolsa del resto.
    transactions: [{ user_id: "u1", transaction_type: "expense", amount: 12.5, currency_code: "PEN", transaction_date: "2026-10-24T15:00:00Z", recurring_id: null }],
  });
  const { data: d, prompt } = await finanzas.loadContext!(ctx(db));
  assert.deepEqual(d.recurring.map((r) => r.recurring_id), ["tel"], "«¿qué me falta pagar?» no cuenta el sueldo");
  const caja = d.caja!;
  assert.equal(caja.caja, 470, "la tarjeta de crédito no es caja");
  assert.deepEqual(caja.programados.map((p) => [p.id, p.tipo, p.dia]), [["tel", "expense", 22], ["sueldo", "income", 31]]);
  assert.deepEqual(caja.bolsas[1]!.cambio, { desde: "2026-11-16", tope: 70 });
  assert.deepEqual(caja.gastos, [{ fecha: "2026-10-24", monto: 12.5, categoria: null, programado: false }]);
  assert.match(prompt, /PLAN DE CAJA/);
  assert.match(prompt, /Caja hoy: S\/ 470\./);
  assert.match(prompt, /Bolsa Compras y otros: tope S\/ 100, gastado S\/ 13, queda S\/ 88\./);
  assert.match(prompt, /Próximo ingreso: Sueldo el 31 de octubre; antes de eso hay S\/ 420 para todo\./);
  assert.match(prompt, /Esta semana: Teléfono -?S\/ 50 \(vencido\)/);
  assert.match(prompt, /COBROS PROGRAMADOS/);
});

test("loadContext sin la migración 023 (error al leer bolsas): sigue, sin plan", async () => {
  const { db } = fakeDbLeer({});
  const original = db.from;
  db.from = (t: string) => (t === "bolsas" ? { select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: "relation does not exist" } }) }) }) } : original(t)) as never;
  const { data: d, prompt } = await finanzas.loadContext!(ctx(db));
  assert.equal(d.caja, null);
  assert.doesNotMatch(prompt, /PLAN DE CAJA/);
});

test("create_transaction: después de anotar, dice cuánto le queda a la bolsa", async () => {
  const { db } = base();
  const comida = await h.create_transaction({ amount: 17, transaction_type: "expense", description: "Cena", category_name: "Alimentación" }, ctx(db), data());
  assert.equal(comida.message, "Gasto de S/ 17.00 en Cena. Te quedan S/ 183 de comida hasta el domingo primero de noviembre.");
  assert.ok(prepararVoz(loQueSeDice(comida)).length <= VOZ_MAX);
  const sinCategoria = await h.create_transaction({ amount: 2.9, transaction_type: "expense", description: "Aloe vera" }, ctx(db), data());
  assert.match(sinCategoria.message, /Te quedan S\/ 97 de compras y otros/);
  const pasado = await h.create_transaction({ amount: 120, transaction_type: "expense", description: "Gasolina", category_name: "Transporte" }, ctx(db), data());
  assert.match(pasado.message, /Te pasaste S\/ 39 de gasolina esta semana\.$/);
  const ingreso = await h.create_transaction({ amount: 100, transaction_type: "income", description: "Venta" }, ctx(db), data());
  assert.equal(ingreso.message, "Ingreso de S/ 100.00 en Venta.", "un ingreso no toca las bolsas");
  const sinPlan = await h.create_transaction({ amount: 17, transaction_type: "expense", description: "Cena", category_name: "Alimentación" }, ctx(db), data({ caja: null }));
  assert.equal(sinPlan.message, "Gasto de S/ 17.00 en Cena.", "sin plan, como siempre");
});

test("cuanto_puedo_gastar: responde con el motor y la voz cabe en el tope", async () => {
  const r = await h.cuanto_puedo_gastar({}, ctx(base().db), data());
  assert.equal(r.action, "cuanto_puedo_gastar");
  assert.match(r.message, /^Hasta el domingo primero de noviembre te quedan S\/ 381: comida S\/ 200, compras y otros S\/ 100 y gasolina S\/ 81\./);
  assert.match(r.message, /hasta el 30 de octubre solo hay S\/ 300 para todo; el resto, desde el 31 de octubre\./);
  assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX, prepararVoz(loQueSeDice(r)));
  const sinPlan = await h.cuanto_puedo_gastar({}, ctx(base().db), data({ caja: null }));
  assert.equal(sinPlan.action, "error");
});

test("pay_recurring: el de una sola vez se cierra; el cobro dice «cobrado»; con varios Hugo paga el que vence primero", async () => {
  const fila = (id: string, description: string, amount: number, next: string, transaction_type = "expense") =>
    ({ user_id: "u1", is_active: true, recurring_id: id, description, amount, currency_code: "PEN", frequency: "once", account_id: "deb", category_id: null, transaction_type, next_due_date: next, day_of_month: null });
  const { db, inserts, updates } = base({
    recurring_transactions: [fila("h3", "Deuda Hugo (3/3)", 300, "2026-11-30"), fila("h1", "Deuda Hugo (1/3)", 1016, "2026-11-01"), fila("bono", "Bono", 1500, "2026-10-31", "income")],
  });
  const hugo = await h.pay_recurring({ search_description: "hugo" }, ctx(db), data());
  assert.equal(hugo.message, "Deuda Hugo (1/3) pagado, S/ 1016.00. Queda cerrado.");
  assert.deepEqual(updates[0], { table: "recurring_transactions", row: { is_active: false }, donde: ["recurring_id", "h1"] });
  const bono = await h.pay_recurring({ search_description: "bono" }, ctx(db), data());
  assert.equal(bono.message, "Bono cobrado, S/ 1500.00. Queda cerrado.");
  assert.equal(inserts.at(-1)!.row.transaction_type, "income");
});

test("pay_recurring: un mensual de fin de mes avanza al 30-nov, no al 1-dic", async () => {
  const { db, updates } = base({
    recurring_transactions: [{ user_id: "u1", is_active: true, recurring_id: "sub", description: "Subvención", amount: 400, currency_code: "PEN", frequency: "monthly", account_id: "deb", category_id: null, transaction_type: "expense", next_due_date: "2026-10-31", day_of_month: 31 }],
  });
  const r = await h.pay_recurring({ search_description: "subvención" }, ctx(db), data());
  assert.equal(updates[0]!.row.next_due_date, "2026-11-30");
  assert.match(r.message, /Próximo: el 30 de noviembre\.$/);
});

test("create_recurring: «el 1 de noviembre le pago 1000 a Melissa» queda como pago de una sola vez; sin fecha, pregunta", async () => {
  const { db, inserts } = base();
  const sinFecha = await h.create_recurring({ description: "Melissa", amount: 1000, frequency: "once" }, ctx(db), data());
  assert.equal(sinFecha.action, "clarify");
  assert.equal(inserts.length, 0);
  const r = await h.create_recurring({ description: "Melissa", amount: 1000, frequency: "once", due_date: "2026-11-01", category_name: "Deudas" }, ctx(db), data());
  assert.equal(r.message, "Pago de S/ 1000.00 a Melissa anotado para el primero de noviembre.");
  assert.equal(inserts[0]!.row.frequency, "once");
  assert.equal(inserts[0]!.row.next_due_date, "2026-11-01");
  assert.equal(inserts[0]!.row.day_of_month, 1);
  const cobro = await h.create_recurring({ description: "Pago de cliente", amount: 1000, frequency: "once", due_date: "2026-11-30", transaction_type: "income" }, ctx(db), data());
  assert.match(cobro.message, /^Cobro de S\/ 1000\.00/);
  assert.equal(inserts[1]!.row.transaction_type, "income");
});
