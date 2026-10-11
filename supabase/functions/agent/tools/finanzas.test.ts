// node --experimental-strip-types --test supabase/functions/agent/tools/finanzas.test.ts
// Handlers de cuentas y movimientos con una base falsa: nada toca Supabase. Lo que se verifica es QUÉ se insertaría.
import test from "node:test";
import assert from "node:assert/strict";
import { finanzas } from "./finanzas.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { loQueSeDice } from "../respuesta.ts";
import type { AgentContext } from "../types.ts";

type Insert = { table: string; row: Record<string, unknown> };
function fakeDb(error: { code?: string; message: string } | null = null) {
  const inserts: Insert[] = [];
  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        const res = { data: error ? null : { account_id: "nueva", ...row }, error };
        return Object.assign(Promise.resolve(res), { select: () => ({ single: async () => res }) });
      },
    }),
  };
  return { db, inserts };
}
const ctx = (db: unknown, text = "dictado de prueba"): AgentContext =>
  ({ supabase: db as AgentContext["supabase"], user: { id: "u1" } as AgentContext["user"], text, limaNow: new Date("2026-10-11T12:00:00Z") });

const acc = (id: string, name: string, type = "checking", cur = "PEN", bal = 0) => ({ account_id: id, account_name: name, account_type: type, currency_code: cur, current_balance: bal });
const data = (accounts = [acc("a1", "BCP Soles", "checking", "PEN", 1200), acc("a2", "BCP Dólares", "savings", "USD", 300), acc("a3", "Interbank", "checking", "PEN", 500)]) => ({
  accounts, categories: [{ category_id: "c1", category_name: "Alimentación", category_type: "expense" }], goals: [], recurring: [], paidIds: new Set<string>(), recurrentesOk: true,
});
const h = finanzas.handlers;

test("create_account: «Interbank en soles con 500» inserta lo validado y confirma en una frase corta", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.create_account({ account_name: "Interbank", currency_code: "PEN", initial_balance: 500 }, ctx(db), data([]));
  assert.equal(r.action, "create_account");
  assert.deepEqual(inserts, [{
    table: "accounts",
    row: { user_id: "u1", account_name: "Interbank", account_type: "checking", currency_code: "PEN", current_balance: 500, is_active: true },
  }]);
  assert.equal(r.voz, "Creé la cuenta Interbank en soles, con S/ 500.00.");
  assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX);
});

test("create_account: el comentario de Wabid se suma y respeta el tope de voz", async () => {
  const { db } = fakeDb();
  const r = await h.create_account({ account_name: "Caja chica", account_type: "cash", comentario: "Efectivo, qué retro." }, ctx(db), data([]));
  assert.match(r.voz ?? "", /Efectivo, qué retro\.$/);
  assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX);
});

test("create_account: duplicado por nombre no inserta", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.create_account({ account_name: "mi cuenta INTERBANK" }, ctx(db), data());
  assert.equal(r.action, "error");
  assert.match(r.message, /Ya tienes una cuenta llamada «Interbank»/);
  assert.equal(inserts.length, 0);
});

test("create_account: sin nombre pregunta (clarify) y no inserta", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.create_account({ account_type: "savings" }, ctx(db), data([]));
  assert.equal(r.action, "clarify");
  assert.match(r.message, /Cómo se llama/);
  assert.equal(inserts.length, 0);
});

test("create_account: moneda inválida, saldo absurdo y tarjeta con saldo negativo no insertan", async () => {
  const { db, inserts } = fakeDb();
  for (const args of [
    { account_name: "Euro", currency_code: "EUR" },
    { account_name: "Mucho", initial_balance: 9e12 },
    { account_name: "Visa", account_type: "credit_card", initial_balance: -10 },
  ]) {
    const r = await h.create_account(args, ctx(db), data([]));
    assert.equal(r.action, "error", JSON.stringify(args));
  }
  assert.equal(inserts.length, 0);
});

test("create_account: un fallo de la base se dice genérico, sin filtrar el mensaje interno", async () => {
  const { db } = fakeDb({ code: "23514", message: 'new row violates check constraint "accounts_account_type_check"' });
  const original = console.error;
  console.error = () => {};
  try {
    const r = await h.create_account({ account_name: "Cuenta" }, ctx(db), data([]));
    assert.equal(r.action, "error");
    assert.doesNotMatch(r.message, /constraint|violates/);
  } finally {
    console.error = original;
  }
});

test("list_accounts: cuenta, total y voz corta", async () => {
  const r = await h.list_accounts({}, ctx(fakeDb().db), data());
  assert.equal(r.action, "list_accounts");
  assert.match(r.message, /^Tienes 3 cuentas: BCP Soles: S\/ 1,200\.00; BCP Dólares: US\$ 300\.00; Interbank: S\/ 500\.00\./);
  assert.equal(r.voz, "Tienes 3 cuentas; en total S/ 1,700.00 y US$ 300.00.");
  assert.match((await h.list_accounts({}, ctx(fakeDb().db), data([]))).message, /No tienes cuentas todavía/);
});

test("create_transaction: encuentra la cuenta por nombre aproximado y la usa", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.create_transaction(
    { amount: 30, transaction_type: "expense", description: "Almuerzo", category_name: "Alimentación", account: "mi interbank" },
    ctx(db), data(),
  );
  assert.equal(r.action, "create_transaction");
  assert.equal(inserts[0].row.account_id, "a3");
  assert.match(r.message, /Gasto de S\/ 30\.00 en Almuerzo \(Interbank\)\./);
});

test("create_transaction: «la de BCP» con dos BCP pregunta cuál y no inserta", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.create_transaction({ amount: 30, transaction_type: "expense", description: "Taxi", account: "la de BCP" }, ctx(db), data());
  assert.equal(r.action, "clarify");
  assert.equal(r.message, "¿Cuál: BCP Soles o BCP Dólares?");
  assert.equal(inserts.length, 0);
});

test("create_transaction: cuenta desconocida avisa con las cuentas que sí hay", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.create_transaction({ amount: 30, transaction_type: "expense", description: "Taxi", account: "scotiabank" }, ctx(db), data());
  assert.equal(r.action, "error");
  assert.match(r.message, /No encontré una cuenta «scotiabank»\. Tienes: BCP Soles, BCP Dólares o Interbank\./);
  assert.equal(inserts.length, 0);
});

test("create_transaction: sin cuenta nombrada usa la primera de la moneda del movimiento", async () => {
  const { db, inserts } = fakeDb();
  await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Netflix", currency_code: "USD" }, ctx(db), data());
  assert.equal(inserts[0].row.account_id, "a2");
  await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Taxi" }, ctx(db), data());
  assert.equal(inserts[1].row.account_id, "a1");
  // sin cuenta en esa moneda: la primera (comportamiento de siempre)
  await h.create_transaction({ amount: 5, transaction_type: "expense", description: "Café", currency_code: "USD" }, ctx(db), data([acc("z", "Solo soles")]));
  assert.equal(inserts[2].row.account_id, "z");
});

test("create_transaction: sin cuentas, o con monto inválido, no inserta", async () => {
  const { db, inserts } = fakeDb();
  const sin = await h.create_transaction({ amount: 30, transaction_type: "expense", description: "Taxi" }, ctx(db), data([]));
  assert.match(sin.message, /No tienes cuentas todavía/);
  for (const amount of [0, -5, "abc", Number.NaN, 5e12]) {
    const r = await h.create_transaction({ amount, transaction_type: "expense", description: "X" }, ctx(db), data());
    assert.equal(r.action, "error", String(amount));
  }
  assert.equal(inserts.length, 0);
});

test("transfer: «de la de Interbank a BCP soles» con nombres aproximados y la moneda de la cuenta de origen", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.transfer({ amount: 100, from_account: "mi Interbank", to_account: "BCP soles" }, ctx(db), data());
  assert.equal(r.action, "transfer");
  assert.equal(inserts[0].row.account_id, "a3");
  assert.equal(inserts[0].row.transfer_to_account_id, "a1");
  assert.equal(inserts[0].row.currency_code, "PEN");
  assert.equal(r.message, "S/ 100.00 transferidos de Interbank a BCP Soles.");
});

test("transfer: misma cuenta, monedas distintas, cuenta ambigua o desconocida no insertan", async () => {
  const { db, inserts } = fakeDb();
  const casos: [Record<string, unknown>, RegExp][] = [
    [{ amount: 10, from_account: "interbank", to_account: "mi interbank" }, /dos cuentas distintas/],
    [{ amount: 10, from_account: "interbank", to_account: "bcp dólares" }, /soles y dólares/],
    [{ amount: 10, from_account: "la de bcp", to_account: "interbank" }, /¿Cuál: BCP Soles o BCP Dólares\?/],
    [{ amount: 10, from_account: "interbank", to_account: "scotia" }, /No encontré una cuenta «scotia»/],
    [{ amount: 0, from_account: "interbank", to_account: "bcp soles" }, /monto/],
  ];
  for (const [args, esperado] of casos) {
    const r = await h.transfer(args, ctx(db), data());
    assert.match(r.message, esperado, JSON.stringify(args));
  }
  assert.equal(inserts.length, 0);
});

test("las reglas de finanzas explican cuentas y las tools nuevas existen sin nombres repetidos", () => {
  assert.match(finanzas.rules ?? "", /create_account/);
  assert.match(finanzas.rules ?? "", /list_accounts/);
  const nombres = finanzas.definitions.map((d) => d.function.name);
  assert.equal(new Set(nombres).size, nombres.length);
  for (const n of ["create_account", "list_accounts"]) assert.ok(nombres.includes(n), n);
  const crear = finanzas.definitions.find((d) => d.function.name === "create_account")!;
  assert.deepEqual((crear.function.parameters as { required: string[] }).required, ["account_name"]);
});
