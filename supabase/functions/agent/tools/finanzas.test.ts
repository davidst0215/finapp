// node --experimental-strip-types --test supabase/functions/agent/tools/finanzas.test.ts
// Handlers de cuentas y movimientos con una base falsa: nada toca Supabase. Lo que se verifica es QUÉ se insertaría.
import test from "node:test";
import assert from "node:assert/strict";
import { finanzas } from "./finanzas.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { loQueSeDice } from "../respuesta.ts";
import { fakeDb as fakeDbLeer } from "./testlib.ts";
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

test("create_transaction: sin cuenta nombrada va a la primera (como siempre), sin cambiar la elección por la moneda", async () => {
  const { db, inserts } = fakeDb();
  await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Taxi" }, ctx(db), data());
  assert.equal(inserts[0].row.account_id, "a1");
  assert.equal(inserts[0].row.currency_code, "PEN");
  await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Netflix", currency_code: "PEN" }, ctx(db), data());
  assert.equal(inserts[1].row.account_id, "a1", "la moneda dicha coincide con la de accounts[0]");
  const r = await h.create_transaction({ amount: 5, transaction_type: "expense", description: "Café" }, ctx(db), data([acc("z", "Solo soles")]));
  assert.equal(inserts[2].row.account_id, "z");
  assert.doesNotMatch(r.message, /\(/, "con una sola cuenta no hace falta decir cuál");
});

test("create_transaction SIN cuenta nombrada: si la moneda dicha difiere de la de accounts[0], pregunta igual que con cuenta nombrada", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Netflix", currency_code: "USD" }, ctx(db), data());
  assert.equal(r.action, "clarify");
  assert.equal(r.message, "Dijiste dólares, pero BCP Soles es en soles. ¿Con cuál: BCP Dólares?");
  const sinDolares = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "X", currency_code: "USD" }, ctx(db), data([acc("a3", "Interbank")]));
  assert.equal(sinDolares.message, "Dijiste dólares, pero Interbank es en soles. No tienes cuentas en dólares.");
  const alReves = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "X", currency_code: "PEN" }, ctx(db), data([acc("d1", "BCP Dólares", "savings", "USD"), acc("a3", "Interbank")]));
  assert.equal(alReves.message, "Dijiste soles, pero BCP Dólares es en dólares. ¿Con cuál: Interbank?");
  assert.equal(inserts.length, 0);
  // sin decir moneda no pregunta (se queda en accounts[0], como siempre)
  await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Taxi" }, ctx(db), data());
  assert.equal(inserts.length, 1);
});

test("currency_code solo se pasa si David dijo la moneda: la descripción y las reglas lo dicen", () => {
  const def = finanzas.definitions.find((d) => d.function.name === "create_transaction")!;
  const desc = (def.function.parameters as { properties: { currency_code: { description: string } } }).properties.currency_code.description;
  assert.match(desc, /Solo si David dijo la moneda/);
  assert.match(desc, /vacío si no la dijo/);
  assert.doesNotMatch(desc, /por defecto/);
  assert.match(finanzas.rules ?? "", /currency_code solo si David dijo la moneda; vacío si no/);
});

test("create_transaction: con varias cuentas y sin nombrar, el mensaje dice a cuál fue", async () => {
  const { db } = fakeDb();
  const r = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Taxi" }, ctx(db), data());
  assert.equal(r.message, "Gasto de S/ 20.00 en Taxi (BCP Soles).");
});

test("loadContext ordena las cuentas por antigüedad: accounts[0] es siempre la más vieja", async () => {
  const filas = [
    { user_id: "u1", account_id: "b", account_name: "Nueva", account_type: "checking", currency_code: "PEN", current_balance: 0, is_active: true, created_at: "2026-02-01T00:00:00Z" },
    { user_id: "u1", account_id: "a", account_name: "Vieja", account_type: "checking", currency_code: "PEN", current_balance: 0, is_active: true, created_at: "2026-01-01T00:00:00Z" },
    { user_id: "u1", account_id: "c", account_name: "Misma hora, id mayor", account_type: "checking", currency_code: "PEN", current_balance: 0, is_active: true, created_at: "2026-02-01T00:00:00Z" },
    { user_id: "otro", account_id: "x", account_name: "Ajena", account_type: "checking", currency_code: "PEN", current_balance: 0, is_active: true, created_at: "2025-01-01T00:00:00Z" },
  ];
  const { db } = fakeDbLeer({ accounts: filas });
  const { data: d, prompt } = await finanzas.loadContext!(ctx(db));
  assert.deepEqual(d.accounts.map((a) => a.account_id), ["a", "b", "c"]);
  assert.match(prompt, /CUENTAS: Vieja \(cuenta corriente\): S\/ 0\.00, Nueva/);
});

test("create_transaction: una cuenta nombrada de otra moneda que el movimiento PREGUNTA y no inserta", async () => {
  const { db, inserts } = fakeDb();
  const r = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Netflix", currency_code: "USD", account: "mi Interbank" }, ctx(db), data());
  assert.equal(r.action, "clarify");
  assert.equal(r.message, "Interbank está en soles, no en dólares. ¿Con cuál: BCP Dólares?");
  assert.ok(prepararVoz(loQueSeDice(r)).endsWith("?"));
  const sinDolares = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "X", currency_code: "USD", account: "interbank" }, ctx(db), data([acc("a3", "Interbank")]));
  assert.equal(sinDolares.message, "Interbank está en soles, no en dólares. No tienes cuentas en dólares.");
  const alReves = await h.create_transaction({ amount: 20, transaction_type: "expense", description: "X", currency_code: "PEN", account: "bcp dólares" }, ctx(db), data());
  assert.equal(alReves.action, "clarify");
  assert.match(alReves.message, /^BCP Dólares está en dólares, no en soles\./); // con cuenta nombrada: dice que ESA cuenta es de otra moneda
  assert.equal(inserts.length, 0);
});

test("create_transaction: una cuenta nombrada sin moneda dicha usa la moneda de esa cuenta", async () => {
  const { db, inserts } = fakeDb();
  await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Netflix", account: "bcp dólares" }, ctx(db), data());
  assert.equal(inserts[0].row.account_id, "a2");
  assert.equal(inserts[0].row.currency_code, "USD");
  await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Netflix", currency_code: "USD", account: "bcp dólares" }, ctx(db), data());
  assert.equal(inserts[1].row.currency_code, "USD");
  await h.create_transaction({ amount: 20, transaction_type: "expense", description: "Taxi", account: "interbank" }, ctx(db), data());
  assert.equal(inserts[2].row.currency_code, "PEN");
});

test("create_transaction y transfer: «1,5» es 1,5 y «1,500» es 1500; una coma ambigua se rechaza (nunca 15)", async () => {
  const { db, inserts } = fakeDb();
  await h.create_transaction({ amount: "1,5", transaction_type: "expense", description: "Chicle" }, ctx(db), data());
  await h.create_transaction({ amount: "1,500", transaction_type: "expense", description: "Alquiler" }, ctx(db), data());
  assert.deepEqual(inserts.map((i) => i.row.amount), [1.5, 1500]);
  const mal = await h.create_transaction({ amount: "1,2345", transaction_type: "expense", description: "X" }, ctx(db), data());
  assert.equal(mal.action, "error");
  const t = await h.transfer({ amount: "2,5", from_account: "interbank", to_account: "bcp soles" }, ctx(db), data());
  assert.equal(t.message, "S/ 2.50 transferidos de Interbank a BCP Soles.");
  assert.equal((await h.transfer({ amount: "2,5,5", from_account: "interbank", to_account: "bcp soles" }, ctx(db), data())).action, "error");
});

test("cuenta desconocida: «la tarjeta Falabella» con una sola tarjeta NO se carga a ella", async () => {
  const { db, inserts } = fakeDb();
  const cuentas = data([acc("t1", "BBVA Oro", "credit_card"), acc("a1", "Interbank")]);
  const r = await h.create_transaction({ amount: 30, transaction_type: "expense", description: "Cena", account: "la tarjeta Falabella" }, ctx(db), cuentas);
  assert.equal(r.action, "error");
  assert.match(r.message, /No encontré una cuenta «la tarjeta Falabella»\. Tienes: BBVA Oro o Interbank\./);
  assert.equal(inserts.length, 0);
  await h.create_transaction({ amount: 30, transaction_type: "expense", description: "Cena", account: "la tarjeta" }, ctx(db), cuentas);
  assert.equal(inserts[0].row.account_id, "t1");
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
