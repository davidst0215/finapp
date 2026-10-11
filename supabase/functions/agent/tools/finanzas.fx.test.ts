// node --experimental-strip-types --test supabase/functions/agent/tools/finanzas.fx.test.ts
// Multimoneda del agente: el contexto trae los totales en soles (dólares convertidos), la moneda de cada movimiento coincide con la de su
// cuenta y los mensajes dicen US$ cuando corresponde. Base y red falsas: nada toca Supabase.
import "./testlib.ts"; // instala Deno.env antes de cargar los módulos
import test from "node:test";
import assert from "node:assert/strict";
import { finanzas } from "./finanzas.ts";
import { recurrentesEnSoles, resumenRecurrentes, vozRecurrentes } from "./recurrentes.ts";
import { fakeDb as fakeDbLeer } from "./testlib.ts";
import type { AgentContext } from "../types.ts";

type Fila = Record<string, unknown>;
/** Base en memoria con lectura (eq/ilike/order/limit) y escritura registrada (insert/update/delete). */
function base(tablas: Record<string, Fila[]> = {}) {
  const inserts: { table: string; row: Fila }[] = [];
  const updates: { table: string; row: Fila; donde: [string, unknown] | null }[] = [];
  const deletes: { table: string; donde: [string, unknown] | null }[] = [];
  const db = {
    from: (table: string) => {
      let data = tablas[table] ?? [];
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => ((data = data.filter((r) => r[c] === v)), b),
        ilike: (c: string, pat: string) => {
          const q = pat.replaceAll("%", "").toLowerCase();
          data = data.filter((r) => String(r[c]).toLowerCase().includes(q));
          return b;
        },
        order: () => b,
        limit: (n: number) => ((data = data.slice(0, n)), b),
        insert: (row: Fila) => {
          inserts.push({ table, row });
          const res = { data: { transaction_id: "t1", ...row }, error: null };
          return Object.assign(Promise.resolve(res), { select: () => ({ single: async () => res }) });
        },
        update: (row: Fila) => ({ eq: async (c: string, v: unknown) => (updates.push({ table, row, donde: [c, v] }), { error: null }) }),
        delete: () => ({ eq: async (c: string, v: unknown) => (deletes.push({ table, donde: [c, v] }), { error: null }) }),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok, ko),
      };
      return b;
    },
  };
  return { db, inserts, updates, deletes };
}
const ctx = (db: unknown): AgentContext =>
  ({ supabase: db as AgentContext["supabase"], user: { id: "u1" } as AgentContext["user"], text: "dictado", limaNow: new Date("2026-10-11T12:00:00Z") });
const acc = (id: string, name: string, type = "checking", cur = "PEN", bal = 0) => ({ account_id: id, account_name: name, account_type: type, currency_code: cur, current_balance: bal });
const TC = { par: "USD/PEN", fecha: "2026-10-07", valor: 3.5, fuente: "BCRP · SBS venta", obtenido_en: "2026-10-11T10:00:00Z" };
const data = (accounts: ReturnType<typeof acc>[], extra: Fila = {}) =>
  ({ accounts, categories: [], goals: [], recurring: [], paidIds: new Set<string>(), recurrentesOk: true, tc: TC, ...extra }) as unknown as Parameters<typeof finanzas.handlers.create_transaction>[2];
const h = finanzas.handlers;

// ---------------------------------------------------------------------------------------------- contexto
const MESES = { total_income: 1500, total_expenses: 800, net_balance: 700, transaction_count: 9, top_category_name: "Comida", top_category_amount: 300, income_usd: 0, expenses_usd: 40 };
const cuentas = (): Fila[] => [
  { user_id: "u1", ...acc("a", "Interbank", "checking", "PEN", 1000), is_active: true, created_at: "2026-01-01T00:00:00Z" },
  { user_id: "u1", ...acc("b", "Wise", "savings", "USD", 500), is_active: true, created_at: "2026-01-02T00:00:00Z" },
  { user_id: "u1", ...acc("c", "Visa", "credit_card", "PEN", 200), is_active: true, created_at: "2026-01-03T00:00:00Z" },
];
const leer = (tablas: Record<string, Fila[]>, mes: Fila = MESES) => fakeDbLeer(tablas, { fn_get_monthly_summary: () => [mes] }).db;

test("loadContext con dólares: tipo de cambio, patrimonio neto en soles, dólares del mes y movimientos con su símbolo", async () => {
  const db = leer({
    accounts: cuentas(),
    fx_rates: [{ par: "USD/PEN", fecha: "2026-10-07", valor: 3.5, fuente: "BCRP · SBS venta", obtenido_en: "2026-10-11T10:00:00Z" }],
    transactions: [
      { user_id: "u1", description: "Netflix", amount: 15, currency_code: "USD", transaction_type: "expense", transaction_date: "2026-10-10T15:00:00Z", category: null },
      { user_id: "u1", description: "Almuerzo", amount: 30, currency_code: "PEN", transaction_type: "expense", transaction_date: "2026-10-10T16:00:00Z", category: null },
    ],
    recurring_transactions: [
      { user_id: "u1", is_active: true, recurring_id: "r1", description: "Hosting", amount: 10, currency_code: "USD", frequency: "monthly", next_due_date: "2026-10-20" },
      { user_id: "u1", is_active: true, recurring_id: "r2", description: "Alquiler", amount: 1000, currency_code: "PEN", frequency: "monthly", next_due_date: "2026-10-05" },
    ],
  });
  const { prompt, data: d } = await finanzas.loadContext!(ctx(db));
  assert.match(prompt, /^TIPO DE CAMBIO: US\$ 1 = S\/ 3\.5 \(BCRP · SBS venta, el 7 de octubre\)\./);
  assert.match(prompt, /PATRIMONIO NETO EN SOLES: S\/ 2,550\.00 \(incluye US\$ 500\.00 = S\/ 1,750\.00 al tipo de cambio\)/); // 1000 − 200 + 500×3.5
  assert.match(prompt, /- De eso en dólares: gastos US\$ 40, ingresos US\$ 0/);
  assert.match(prompt, /Wise \(cuenta de ahorros\): US\$ 500\.00/, "cada cuenta en su moneda");
  assert.match(prompt, /-US\$15 Netflix/);
  assert.match(prompt, /-S\/30 Almuerzo/);
  assert.match(prompt, /Total fijo mensual: S\/1035\.00/, "10 dólares = S/ 35 más el alquiler");
  assert.equal(d.tc?.valor, 3.5);
  assert.equal(d.recurring.find((r) => r.recurring_id === "r1")?.original, "US$ 10.00");
});

test("loadContext con dólares y SIN tipo de cambio: avisa y no los suma como soles", async () => {
  const { prompt, data: d } = await finanzas.loadContext!(ctx(leer({ accounts: cuentas() })));
  assert.match(prompt, /AVISO: hay dólares pero todavía no hay tipo de cambio guardado/);
  assert.match(prompt, /PATRIMONIO NETO EN SOLES: S\/ 800\.00 \(SIN contar US\$ 500\.00: falta el tipo de cambio\)/);
  assert.equal(d.tc, null);
});

test("loadContext sin dólares: ni línea de tipo de cambio ni aviso; el patrimonio resta la tarjeta", async () => {
  const soloSoles = cuentas().filter((c) => c.currency_code === "PEN");
  const { prompt } = await finanzas.loadContext!(ctx(leer({ accounts: soloSoles }, { ...MESES, expenses_usd: 0 })));
  assert.doesNotMatch(prompt, /TIPO DE CAMBIO|AVISO/);
  assert.match(prompt, /PATRIMONIO NETO EN SOLES: S\/ 800\.00$/m);
  assert.match(prompt, /^MES ACTUAL/, "el contexto sigue empezando como siempre cuando no hay dólares");
});

// ---------------------------------------------------------------------------------------------- recurrentes
const rec = (id: string, d: string, amount: number, cur: string | null, due = "2026-10-20") => ({ recurring_id: id, description: d, amount, currency_code: cur, frequency: "monthly", next_due_date: due });

test("recurrentesEnSoles: el pago en dólares pasa a soles con su original; PEN, otra moneda o sin tipo de cambio quedan como están", () => {
  const lista = [rec("1", "Hosting", 10, "USD"), rec("2", "Alquiler", 1000, "PEN"), rec("3", "Sin moneda", 5, null), rec("4", "Euros", 8, "EUR")];
  const r = recurrentesEnSoles(lista, TC);
  assert.deepEqual([r[0]!.amount, r[0]!.currency_code, r[0]!.original], [35, "PEN", "US$ 10.00"]);
  assert.equal(r[1], lista[1]);
  assert.equal(r[2], lista[2]);
  assert.equal(r[3], lista[3], "una moneda que no se convierte no se toca");
  assert.equal(recurrentesEnSoles(lista, null)[0], lista[0], "sin tipo de cambio queda en dólares");
});

test("resumenRecurrentes y vozRecurrentes: el pago convertido muestra el original; el no convertido va en dólares y no suma", () => {
  const convertido = recurrentesEnSoles([rec("1", "Hosting", 10, "USD"), rec("2", "Alquiler", 1000, "PEN", "2026-10-05")], TC);
  const txt = resumenRecurrentes(convertido, new Set(), "2026-10-11", "pending");
  assert.match(txt, /^Te faltan S\/ 1035\.00: /);
  assert.match(txt, /Hosting S\/ 35\.00 \(US\$ 10\.00\)/);
  const crudo = [rec("1", "Hosting", 10, "USD"), rec("2", "Alquiler", 1000, "PEN", "2026-10-05")];
  const sinTc = resumenRecurrentes(crudo, new Set(), "2026-10-11", "pending");
  assert.match(sinTc, /^Te faltan S\/ 1000\.00: /, "los dólares sin convertir no entran en la suma");
  assert.match(sinTc, /Hosting US\$ 10\.00/);
  assert.match(vozRecurrentes([rec("1", "Hosting", 10, "USD")], new Set(), "2026-10-11", "pending"), /Hosting US\$ 10/);
});

// ---------------------------------------------------------------------------------------------- handlers
test("create_transaction sin moneda ni cuenta: si la más antigua es en dólares, el gasto en soles va a la primera cuenta en soles", async () => {
  const { db, inserts } = base();
  const d = data([acc("u", "Wise", "savings", "USD", 100), acc("p", "Interbank", "checking", "PEN", 500)]);
  const r = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Taxi" }, ctx(db), d);
  assert.equal(r.action, "create_transaction");
  assert.deepEqual([inserts[0]!.row.account_id, inserts[0]!.row.currency_code], ["p", "PEN"], "moneda y cuenta coinciden: la base lo exige");
  assert.match(r.message, /Gasto de S\/ 20\.00 en Taxi \(Interbank\)\./);
});

test("create_transaction sin moneda ni cuenta y solo con cuentas en dólares: pregunta, no inserta", async () => {
  const { db, inserts } = base();
  const r = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Taxi" }, ctx(db), data([acc("u", "Wise", "savings", "USD", 100)]));
  assert.equal(r.action, "clarify");
  assert.match(r.message, /Solo tienes cuentas en dólares/);
  assert.equal(inserts.length, 0);
  // y si lo dijo en dólares va a esa cuenta
  const ok = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Taxi", currency_code: "USD" }, ctx(db), data([acc("u", "Wise", "savings", "USD", 100)]));
  assert.equal(ok.action, "create_transaction");
  assert.deepEqual([inserts[0]!.row.account_id, inserts[0]!.row.currency_code], ["u", "USD"]);
});

test("create_recurring: el pago fijo lleva la moneda de su cuenta (la primera en soles, o la primera) para poder pagarlo después", async () => {
  const { db, inserts } = base();
  await h.create_recurring({ description: "Netflix", amount: 45, frequency: "monthly" }, ctx(db), data([acc("u", "Wise", "savings", "USD"), acc("p", "BCP")]));
  assert.deepEqual([inserts[0]!.row.account_id, inserts[0]!.row.currency_code], ["p", "PEN"]);
  await h.create_recurring({ description: "Hosting", amount: 10, frequency: "monthly" }, ctx(db), data([acc("u", "Wise", "savings", "USD")]));
  assert.deepEqual([inserts[1]!.row.account_id, inserts[1]!.row.currency_code], ["u", "USD"]);
});

test("pay_recurring: el pago lleva la moneda del recurrente (antes iba siempre PEN) y el mensaje dice US$", async () => {
  const { db, inserts, updates } = base({
    recurring_transactions: [{ user_id: "u1", is_active: true, recurring_id: "r1", description: "Hosting", amount: 10, currency_code: "USD", frequency: "monthly", account_id: "u", category_id: null, transaction_type: "expense", next_due_date: "2026-10-20" }],
  });
  const r = await h.pay_recurring({ search_description: "hosting" }, ctx(db), data([acc("u", "Wise", "savings", "USD")]));
  assert.equal(inserts[0]!.row.currency_code, "USD");
  assert.equal(inserts[0]!.row.account_id, "u");
  assert.match(r.message, /^Hosting pagado, US\$ 10\.00\./);
  assert.equal(updates[0]!.row.next_due_date, "2026-11-20");
});

test("edit_transaction y delete_transaction: dicen la moneda del movimiento y no tocan current_balance (lo hace el trigger)", async () => {
  const { db, updates, deletes } = base({
    transactions: [{ user_id: "u1", transaction_id: "t9", description: "Netflix", amount: 15, currency_code: "USD", transaction_date: "2026-10-10" }],
  });
  const e = await h.edit_transaction({ search_description: "netflix", new_amount: 12 }, ctx(db), data([]));
  assert.match(e.message, /actualizado: US\$ 12\.00/);
  assert.deepEqual(updates.map((u) => [u.table, Object.keys(u.row)]), [["transactions", ["amount"]]]);
  const d = await h.delete_transaction({ search_description: "netflix" }, ctx(db), data([]));
  assert.match(d.message, /de US\$ 15\.00 eliminado/);
  assert.deepEqual(deletes.map((x) => x.table), ["transactions"]);
  assert.ok(![...updates].some((u) => u.table === "accounts") && !deletes.some((x) => x.table === "accounts"), "el agente nunca escribe en accounts");
});

test("list_accounts con tipo de cambio: total en soles, dólares mencionados cortos y los datos para la pantalla", async () => {
  const cs = [acc("1", "Interbank", "checking", "PEN", 1000), acc("2", "Wise", "savings", "USD", 500), acc("3", "Visa", "credit_card", "PEN", 200)];
  const r = await h.list_accounts({}, ctx(base().db), data(cs));
  assert.match(r.message, /Wise: US\$ 500\.00 \(≈ S\/ 1,750\.00\)/);
  assert.match(r.message, /Total: S\/ 2,550\.00 \(incluye US\$ 500\.00 a TC 3\.5\)\.$/);
  assert.equal(r.voz, "Tienes 3 cuentas; en total S/ 2,550.00, incluye US$ 500.00.");
  assert.ok((r.voz ?? "").length <= 100);
  const dd = r.data as { total_soles: number; usd: number; tipo_cambio: { valor: number } };
  assert.deepEqual([dd.total_soles, dd.usd, dd.tipo_cambio.valor], [2550, 500, 3.5]);
  const sin = await h.list_accounts({}, ctx(base().db), data(cs, { tc: null }));
  assert.match(sin.message, /Total: S\/ 800\.00 y US\$ 500\.00\.$/, "sin tipo de cambio: por moneda, nunca sumados");
  assert.equal((sin.data as { tipo_cambio: unknown }).tipo_cambio, null);
});

test("las reglas del agente piden totales en soles con los dólares mencionados cortos", () => {
  assert.match(finanzas.rules ?? "", /SIEMPRE en soles/);
  assert.match(finanzas.rules ?? "", /nunca sumes dólares como soles/);
});
