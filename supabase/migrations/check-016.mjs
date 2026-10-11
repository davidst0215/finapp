// Prueba la migración 016 contra un Postgres real (PGlite, WASM): aplica 001→016 con stubs de auth/vault/cron (016 tres veces:
// idempotencia) y comprueba
//   (a) que NO hay backfill: los saldos de antes quedan intactos,
//   (b) el trigger de saldo: alta, edición de monto, de tipo y de cuenta, borrado, transferencias y tarjeta de crédito (deuda),
//   (c) que una moneda que no coincide con la cuenta se rechaza (y que lo rechazado no mueve ningún saldo),
//   (d) un invariante con operaciones al azar: saldo − Σ efecto(movimientos) no cambia nunca,
//   (e) los resúmenes en soles (fn_get_monthly_summary, fn_get_budget_status, fn_get_spending_by_category) con tipo de cambio por día de Lima,
//   (f) permisos de fx_rates y su CHECK de rango (2 a 6 soles por dólar),
//   (g) la MISMA regla fecha→tasa, día de Lima y conversión redondeada en SQL, en _shared/fx.ts (agente/brief) y en la web (lib/fx.ts).
// (g) importa los .ts directamente: pide Node >= 22.18 (o --experimental-strip-types).
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node supabase/migrations/check-016.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PGLITE_DIR) {
  console.log("PGLITE_DIR no está definido: se omite (instala @electric-sql/pglite en una carpeta temporal y apúntalo ahí).");
  process.exit(0);
}
const url = (...p) => pathToFileURL(path.join(process.env.PGLITE_DIR, ...p)).href;
const { PGlite } = await import(url("dist", "index.js"));
const { unaccent } = await import(url("dist", "contrib", "unaccent.js"));
const dir = import.meta.dirname;
const db = new PGlite({ extensions: { unaccent } });

// --- Stubs de lo que Supabase trae y PGlite no: roles, auth, vault, pg_cron. ---
await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth; CREATE SCHEMA extensions;
  CREATE TABLE auth.users (id uuid primary key);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth, extensions TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  -- Como Supabase: las tablas nuevas de public nacen con todos los permisos para los tres roles (las migraciones los recortan).
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE SCHEMA vault;
  CREATE TABLE vault.secrets (id uuid primary key default gen_random_uuid(), name text, secret text);
  CREATE VIEW vault.decrypted_secrets AS SELECT id, name, secret AS decrypted_secret FROM vault.secrets;
  CREATE FUNCTION vault.create_secret(s text, n text DEFAULT NULL, d text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS
    $$ INSERT INTO vault.secrets (name, secret) VALUES (n, s) RETURNING id $$;
  CREATE FUNCTION vault.update_secret(i uuid, s text) RETURNS void LANGUAGE sql AS $$ UPDATE vault.secrets SET secret = s WHERE id = i $$;
  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobname text);
  CREATE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job VALUES (n); SELECT 1::bigint $$;
  CREATE FUNCTION cron.unschedule(n text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = n; SELECT true $$;
`);
const archivo = (prefijo) => readdirSync(dir).find((f) => f.startsWith(`${prefijo}_`) && f.endsWith(".sql"));
// Las extensiones que PGlite no trae se quitan del texto; sus esquemas ya están simulados arriba.
const sinExtensiones = (sql) => sql.replace(/^CREATE EXTENSION IF NOT EXISTS\s+("uuid-ossp"|supabase_vault|pg_cron|pg_net).*$/gim, "");
const run = (f) => db.exec(sinExtensiones(readFileSync(path.join(dir, f), "utf8")));
for (let n = 1; n <= 15; n++) await run(archivo(String(n).padStart(3, "0")));

// --- Datos de ANTES de 016 (sin trigger: nada mueve los saldos) ---
const U = "aaaaaaaa-0000-4000-8000-000000000001";
const OTRO = "bbbbbbbb-0000-4000-8000-000000000002";
const U2 = "cccccccc-0000-4000-8000-000000000003";
await db.exec(`
  INSERT INTO currencies (currency_code, currency_name, symbol) VALUES ('PEN','Sol','S/'), ('USD','Dólar','$'), ('EUR','Euro','€');
  INSERT INTO auth.users VALUES ('${U}'), ('${OTRO}'), ('${U2}');
  INSERT INTO users (user_id, display_name) VALUES ('${U}','David'), ('${OTRO}','Otro'), ('${U2}','Dos');
`);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const cuenta = async (user, nombre, tipo, moneda, saldo) =>
  (await q(
    `INSERT INTO accounts (user_id, account_name, account_type, currency_code, current_balance) VALUES ($1,$2,$3,$4,$5) RETURNING account_id`,
    [user, nombre, tipo, moneda, saldo],
  ))[0].account_id;
const I = await cuenta(U, "Interbank", "checking", "PEN", 1000);
const I2 = await cuenta(U, "BCP", "checking", "PEN", 300);
const E = await cuenta(U, "Efectivo", "cash", "PEN", 50);
const V = await cuenta(U, "Visa", "credit_card", "PEN", 200); // saldo = deuda
const A = await cuenta(U, "Ahorro USD", "savings", "USD", 500);
const A2 = await cuenta(U, "Wise USD", "checking", "USD", 100);
const AJENA = await cuenta(OTRO, "Ajena", "checking", "PEN", 10);
const cat = (await q(`INSERT INTO categories (user_id, category_name, category_type) VALUES ($1,'Comida','expense') RETURNING category_id`, [U]))[0].category_id;
// Un movimiento que ya existía cuando se aplicó 016: su efecto NUNCA se aplicó al saldo.
const LEGACY = (await q(
  `INSERT INTO transactions (user_id, account_id, transaction_type, amount, currency_code, description) VALUES ($1,$2,'expense',100,'PEN','viejo') RETURNING transaction_id`,
  [U, I],
))[0].transaction_id;
const saldo = async (id) => Number((await q(`SELECT current_balance FROM accounts WHERE account_id = $1`, [id]))[0].current_balance);
const saldosAntes = { I: await saldo(I), I2: await saldo(I2), E: await saldo(E), V: await saldo(V), A: await saldo(A), A2: await saldo(A2) };
assert.equal(saldosAntes.I, 1000, "sin trigger todavía: el gasto viejo no movió nada");

// --- Aplicar 016 (tres veces: idempotente) ---
await run(archivo("016"));
await run(archivo("016"));
await run(archivo("016"));

// (a) sin backfill
assert.deepEqual({ I: await saldo(I), I2: await saldo(I2), E: await saldo(E), V: await saldo(V), A: await saldo(A), A2: await saldo(A2) }, saldosAntes, "016 no toca los saldos existentes");
for (const t of ["trg_tx_aplicar_saldo", "trg_tx_validar"]) {
  assert.equal((await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`, [t]))[0].n, 1, `un solo ${t} tras correr 016 tres veces`);
}
assert.equal((await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_cuenta_validar_cambio'`))[0].n, 1);

// --- Helpers de sesión: como Supabase, cada llamada con el rol y el usuario del JWT ---
const como = async (rol, user, sql, params = []) => {
  await db.exec(`SET ROLE ${rol}; SELECT set_config('request.jwt.claim.sub', '${user ?? ""}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec(`RESET ROLE`);
  }
};
const web = (sql, params) => como("authenticated", U, sql, params);
const falla = async (fn, re, msg) => {
  await assert.rejects(fn, re, msg);
};
const mov = async (cuentaId, tipo, monto, { moneda = "PEN", destino = null, fecha = null, user = U, rol = "authenticated", categoria = null } = {}) =>
  (await como(rol, user,
    `INSERT INTO transactions (user_id, account_id, transaction_type, amount, currency_code, transfer_to_account_id, transaction_date, category_id, description)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), $8, 'x') RETURNING transaction_id`,
    [user, cuentaId, tipo, monto, moneda, destino, fecha, categoria],
  ))[0].transaction_id;
const set = (id, cols) => {
  const ks = Object.keys(cols);
  return web(`UPDATE transactions SET ${ks.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE transaction_id = $1`, [id, ...ks.map((k) => cols[k])]);
};
const borrar = (id) => web(`DELETE FROM transactions WHERE transaction_id = $1`, [id]);

// (b) trigger de saldo — cuenta normal
let g = await mov(I, "expense", 100);
assert.equal(await saldo(I), 900, "gasto: saldo − monto");
const ing = await mov(I, "income", 50);
assert.equal(await saldo(I), 950, "ingreso: saldo + monto");
await set(g, { amount: 130 });
assert.equal(await saldo(I), 920, "editar monto 100→130 mueve la diferencia");
await set(g, { description: "solo texto" });
assert.equal(await saldo(I), 920, "editar la descripción no mueve el saldo");
await set(g, { transaction_type: "income" });
assert.equal(await saldo(I), 1180, "gasto→ingreso: de −130 a +130");
await set(g, { transaction_type: "expense" });
assert.equal(await saldo(I), 920);
await set(g, { account_id: I2 });
assert.deepEqual([await saldo(I), await saldo(I2)], [1050, 170], "cambiar de cuenta: devuelve a la vieja y cobra a la nueva");
await borrar(g);
assert.deepEqual([await saldo(I), await saldo(I2)], [1050, 300], "borrar revierte");
await borrar(ing);
assert.equal(await saldo(I), 1000);

// transferencias: origen −, destino +
const tr = await mov(I, "transfer", 200, { destino: E });
assert.deepEqual([await saldo(I), await saldo(E)], [800, 250], "transferencia: origen −, destino +");
await set(tr, { amount: 250 });
assert.deepEqual([await saldo(I), await saldo(E)], [750, 300], "editar el monto de la transferencia mueve ambas cuentas");
await set(tr, { transfer_to_account_id: I2 });
assert.deepEqual([await saldo(I), await saldo(E), await saldo(I2)], [750, 50, 550], "cambiar el destino devuelve al viejo y paga al nuevo");
await set(tr, { transaction_type: "expense", transfer_to_account_id: null });
assert.deepEqual([await saldo(I), await saldo(E), await saldo(I2)], [750, 50, 300], "transferencia→gasto: el destino se revierte y el origen sigue restando");
await set(tr, { transaction_type: "transfer", transfer_to_account_id: E });
assert.deepEqual([await saldo(I), await saldo(E)], [750, 300]);
await borrar(tr);
assert.deepEqual([await saldo(I), await saldo(E)], [1000, 50], "borrar la transferencia revierte las dos cuentas");

// tarjeta de crédito: el saldo es la DEUDA
assert.equal(await saldo(V), 200);
const compra = await mov(V, "expense", 80);
assert.equal(await saldo(V), 280, "compra con tarjeta: la deuda sube");
const reembolso = await mov(V, "income", 30);
assert.equal(await saldo(V), 250, "ingreso/reembolso en tarjeta: la deuda baja");
const pago = await mov(I, "transfer", 100, { destino: V });
assert.deepEqual([await saldo(I), await saldo(V)], [900, 150], "pagar la tarjeta desde el banco: el banco baja y la deuda baja");
const adelanto = await mov(V, "transfer", 40, { destino: E });
assert.deepEqual([await saldo(V), await saldo(E)], [190, 90], "adelanto de efectivo: la deuda sube y el efectivo sube");
await borrar(adelanto); await borrar(pago); await borrar(reembolso); await borrar(compra);
assert.deepEqual([await saldo(I), await saldo(V), await saldo(E)], [1000, 200, 50]);

// dólares
const gusd = await mov(A, "expense", 20, { moneda: "USD" });
assert.equal(await saldo(A), 480);
const tusd = await mov(A, "transfer", 100, { moneda: "USD", destino: A2 });
assert.deepEqual([await saldo(A), await saldo(A2)], [380, 200], "transferencia USD→USD");
await borrar(tusd); await borrar(gusd);
assert.deepEqual([await saldo(A), await saldo(A2)], [500, 100]);

// movimiento anterior a 016: editarlo o borrarlo mueve el saldo por la diferencia (invariante, ver cabecera de la migración)
await set(LEGACY, { description: "viejo editado" });
assert.equal(await saldo(I), 1000, "tocar solo texto de un movimiento viejo no mueve nada");
await borrar(LEGACY);
assert.equal(await saldo(I), 1100, "borrar un movimiento viejo devuelve su monto");
await mov(I, "expense", 100); // vuelve al estado base para lo que sigue
assert.equal(await saldo(I), 1000);

// (c) monedas que no coinciden y datos incoherentes: se rechazan y NO mueven ningún saldo
const base = { I: await saldo(I), A: await saldo(A), E: await saldo(E), V: await saldo(V) };
await falla(() => mov(I, "expense", 10, { moneda: "USD" }), /es en USD y la cuenta .Interbank. es en PEN/, "USD en cuenta PEN");
await falla(() => mov(A, "expense", 10, { moneda: "PEN" }), /es en PEN y la cuenta .Ahorro USD. es en USD/, "PEN en cuenta USD");
await falla(() => mov(I, "transfer", 10, { destino: A }), /No se transfiere entre monedas distintas/, "PEN→cuenta USD");
await falla(() => mov(A, "transfer", 10, { moneda: "USD", destino: E }), /No se transfiere entre monedas distintas/, "USD→cuenta PEN");
await falla(() => mov(I, "transfer", 10, { destino: I }), /dos cuentas distintas/, "a la misma cuenta");
await falla(() => mov(I, "transfer", 10), /necesita cuenta de destino/, "sin destino");
await falla(() => mov(AJENA, "expense", 10), /no existe o no es tuya/, "cuenta de otro dueño (con RLS)");
await falla(() => mov(AJENA, "expense", 10, { rol: "service_role" }), /no existe o no es tuya/, "cuenta de otro dueño (rol de servicio, sin RLS)");
await falla(() => mov(I, "transfer", 10, { destino: AJENA }), /destino no existe o no es tuya/, "destino de otro dueño");
const valido = await mov(I, "expense", 10);
await falla(() => set(valido, { currency_code: "USD" }), /es en USD y la cuenta/, "editar la moneda a otra");
await falla(() => set(valido, { account_id: A }), /es en PEN y la cuenta .Ahorro USD./, "mover un gasto en soles a la cuenta en dólares");
await falla(() => set(valido, { transaction_type: "transfer" }), /necesita cuenta de destino/, "convertir en transferencia sin destino");
await falla(() => web(`UPDATE transactions SET amount = 0 WHERE transaction_id = $1`, [valido]), /check|amount/i, "el CHECK amount > 0 sigue vigente");
await borrar(valido);
assert.deepEqual({ I: await saldo(I), A: await saldo(A), E: await saldo(E), V: await saldo(V) }, base, "lo rechazado no movió ningún saldo");
// EUR: una cuenta en EUR acepta movimientos en EUR (la validación es "misma moneda", no una lista)
const EU = await cuenta(U, "Euros", "cash", "EUR", 5);
const eur = await mov(EU, "expense", 2, { moneda: "EUR" });
assert.equal(await saldo(EU), 3);
await borrar(eur);

// cuentas: moneda y tarjeta no cambian si ya hay movimientos
const conMov = await mov(I, "expense", 1);
await falla(() => web(`UPDATE accounts SET currency_code = 'USD' WHERE account_id = $1`, [I]), /ya tiene movimientos/, "cambiar moneda con movimientos");
await falla(() => web(`UPDATE accounts SET account_type = 'credit_card' WHERE account_id = $1`, [I]), /ya tiene movimientos/, "pasar a tarjeta con movimientos");
await web(`UPDATE accounts SET account_type = 'savings', account_name = 'Interbank ahorro' WHERE account_id = $1`, [I]); // checking→savings: mismo signo, vale
await web(`UPDATE accounts SET account_type = 'checking', account_name = 'Interbank' WHERE account_id = $1`, [I]);
await borrar(conMov);
const sinMov = await cuenta(U, "Vacía", "checking", "PEN", 0);
await web(`UPDATE accounts SET currency_code = 'USD' WHERE account_id = $1`, [sinMov]); // sin movimientos sí se puede
const destinoTr = await mov(E, "transfer", 1, { destino: I2 });
await falla(() => web(`UPDATE accounts SET currency_code = 'USD' WHERE account_id = $1`, [I2]), /ya tiene movimientos/, "también cuenta la cuenta destino");
await borrar(destinoTr);

// borrar la cuenta/usuario en cascada no revienta por el trigger
const uTemp = "dddddddd-0000-4000-8000-000000000004";
await db.exec(`INSERT INTO auth.users VALUES ('${uTemp}'); INSERT INTO users (user_id, display_name) VALUES ('${uTemp}','Temp');`);
const aT = await cuenta(uTemp, "T", "checking", "PEN", 10);
await mov(aT, "expense", 3, { user: uTemp });
await db.exec(`DELETE FROM transactions WHERE user_id = '${uTemp}'; DELETE FROM accounts WHERE user_id = '${uTemp}'; DELETE FROM users WHERE user_id = '${uTemp}'`);

// (d) invariante con operaciones al azar: saldo − Σ efecto(movimientos) es constante por cuenta
const TIPOS = new Map();
for (const r of await q(`SELECT account_id, account_type, currency_code FROM accounts WHERE user_id = $1`, [U])) TIPOS.set(r.account_id, r);
const efecto = (tipoCuenta, esDestino, tipoMov, monto) => {
  const base = esDestino ? (tipoMov === "transfer" ? monto : 0) : tipoMov === "income" ? monto : tipoMov === "expense" || tipoMov === "transfer" ? -monto : 0;
  return tipoCuenta === "credit_card" ? -base : base;
};
const constantes = async () => {
  const out = {};
  for (const [id, c] of TIPOS) out[id] = Math.round((await saldo(id)) * 100);
  for (const t of await q(`SELECT account_id, transfer_to_account_id, transaction_type, amount FROM transactions WHERE user_id = $1`, [U])) {
    out[t.account_id] -= Math.round(efecto(TIPOS.get(t.account_id).account_type, false, t.transaction_type, Number(t.amount)) * 100);
    if (t.transaction_type === "transfer" && t.transfer_to_account_id) {
      out[t.transfer_to_account_id] -= Math.round(efecto(TIPOS.get(t.transfer_to_account_id).account_type, true, t.transaction_type, Number(t.amount)) * 100);
    }
  }
  return out;
};
const antesRandom = await constantes();
let seed = 20261011;
const rnd = (n) => ((seed = (seed * 1664525 + 1013904223) % 4294967296), Math.floor((seed / 4294967296) * n));
const ids = [...TIPOS.keys()].filter((id) => id !== sinMov);
const deMoneda = (m, excluir) => ids.filter((id) => TIPOS.get(id).currency_code === m && id !== excluir);
let hechas = 0, rechazadas = 0;
for (let i = 0; i < 400; i++) {
  const vivos = (await q(`SELECT transaction_id, account_id, transfer_to_account_id, transaction_type, currency_code FROM transactions WHERE user_id = $1`, [U]));
  const op = rnd(10);
  try {
    if (op < 5 || vivos.length < 3) {
      const c = ids[rnd(ids.length)];
      const moneda = TIPOS.get(c).currency_code;
      const tipo = ["income", "expense", "transfer"][rnd(3)];
      const otras = deMoneda(moneda, c);
      await mov(c, tipo, (1 + rnd(50000)) / 100, { moneda, destino: tipo === "transfer" ? otras[rnd(otras.length)] : null });
    } else if (op < 8) {
      const t = vivos[rnd(vivos.length)];
      const k = rnd(4);
      if (k === 0) await set(t.transaction_id, { amount: (1 + rnd(50000)) / 100 });
      else if (k === 1) {
        const tipo = ["income", "expense", "transfer"][rnd(3)];
        const otras = deMoneda(t.currency_code, t.account_id);
        await set(t.transaction_id, tipo === "transfer" ? { transaction_type: tipo, transfer_to_account_id: otras[rnd(otras.length)] ?? null } : { transaction_type: tipo, transfer_to_account_id: null });
      } else if (k === 2) await set(t.transaction_id, { account_id: ids[rnd(ids.length)] }); // a veces de otra moneda: se rechaza
      else await set(t.transaction_id, { transfer_to_account_id: ids[rnd(ids.length)] });
    } else {
      await borrar(vivos[rnd(vivos.length)].transaction_id);
    }
    hechas++;
  } catch (e) {
    assert.match(String(e.message), /moneda|monedas|distintas|destino|es en|no existe/i, `solo rechazos esperados: ${e.message}`);
    rechazadas++;
  }
}
assert.ok(hechas > 200 && rechazadas > 10, `hubo operaciones aplicadas (${hechas}) y rechazadas (${rechazadas})`);
assert.deepEqual(await constantes(), antesRandom, "saldo − Σ efecto(movimientos) no cambió tras 400 operaciones al azar");

// (e) resúmenes en soles — usuario aparte (U2) para no mezclar con lo de arriba
const P = await cuenta(U2, "Soles", "checking", "PEN", 0);
const D = await cuenta(U2, "Dólares", "checking", "USD", 0);
const EUR2 = await cuenta(U2, "Euros", "checking", "EUR", 0);
const cat2 = (await q(`INSERT INTO categories (user_id, category_name, category_type) VALUES ($1,'Comida','expense'), ($1,'Viajes','expense') RETURNING category_id, category_name`, [U2]));
const comida = cat2.find((c) => c.category_name === "Comida").category_id;
const viajes = cat2.find((c) => c.category_name === "Viajes").category_id;
const m2 = (cuentaId, tipo, monto, moneda, fecha, categoria) => mov(cuentaId, tipo, monto, { moneda, fecha, user: U2, categoria });
const resumen = async (y, m) => (await como("authenticated", U2, `SELECT * FROM fn_get_monthly_summary($1,$2)`, [y, m]))[0];

// sin ninguna tasa: el dólar queda fuera de la suma en soles (no se cuenta como soles)
await m2(P, "expense", 100, "PEN", "2026-03-10T15:00:00Z", comida);
await m2(D, "expense", 10, "USD", "2026-03-11T15:00:00Z", comida);
let r = await resumen(2026, 3);
assert.equal(Number(r.total_expenses), 100, "sin tipo de cambio el USD no se suma como soles");
assert.equal(Number(r.expenses_usd), 10, "pero se informa cuánto fue en dólares");
assert.equal((await como("authenticated", U2, `SELECT fx_tasa('USD', '2026-03-11') AS t`))[0].t, null);

// con tasas por día
await como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN','2026-10-01',3.40,'prueba'), ('USD/PEN','2026-10-05',3.50,'prueba')`);
await m2(P, "expense", 100, "PEN", "2026-10-10T15:00:00Z", comida);
await m2(D, "expense", 10, "USD", "2026-10-02T15:00:00Z", comida);           // 3.40 → 34.00
await m2(D, "expense", 10, "USD", "2026-10-06T15:00:00Z", viajes);           // 3.50 → 35.00
await m2(D, "expense", 10, "USD", "2026-10-05T03:00:00Z", viajes);           // 22:00 del 4 en Lima → tasa del 4 (3.40) → 34.00, no la del 5
await m2(D, "income", 100, "USD", "2026-10-07T15:00:00Z", null);             // 350.00
await m2(P, "income", 1000, "PEN", "2026-10-08T15:00:00Z", null);
await m2(EUR2, "expense", 50, "EUR", "2026-10-09T15:00:00Z", comida);        // sin tasa EUR: queda fuera
await m2(P, "transfer", 77, "PEN", "2026-10-09T15:00:00Z", null).catch(() => {}); // sin destino: se rechaza; no suma
r = await resumen(2026, 10);
assert.equal(Number(r.total_expenses), 100 + 34 + 35 + 34, "gastos: PEN + USD convertidos con la tasa de cada día de Lima; el EUR sin tasa queda fuera");
assert.equal(Number(r.total_income), 1000 + 350);
assert.equal(Number(r.net_balance), 1350 - 203);
assert.equal(Number(r.expenses_usd), 30);
assert.equal(Number(r.income_usd), 100);
assert.equal(r.top_category_name, "Comida", "la categoría más gastada se mide en soles (100+34=134 vs 35+34=69)");
assert.equal(Number(r.top_category_amount), 134);
// una categoría cuyo ÚNICO gasto es en una moneda sin tasa suma NULL: no puede ganar como «la mayor» (ORDER BY ... NULLS LAST)
const soloEur = (await q(`INSERT INTO categories (user_id, category_name, category_type) VALUES ($1,'Solo euros','expense') RETURNING category_id`, [U2]))[0].category_id;
await m2(EUR2, "expense", 80, "EUR", "2026-10-09T16:00:00Z", soloEur);
r = await resumen(2026, 10);
assert.equal(r.top_category_name, "Comida", "la categoría sin tasa (suma NULL) no queda como top");
assert.equal(Number(r.top_category_amount), 134);
// antes de la primera tasa conocida vale la primera conocida (no 1)
await m2(D, "expense", 10, "USD", "2026-09-20T15:00:00Z", comida);
assert.equal(Number((await resumen(2026, 9)).total_expenses), 34, "antes de la primera fecha conocida vale la primera (3.40)");

const cats = await como("authenticated", U2, `SELECT category_name, total_amount, transaction_count, percentage FROM fn_get_spending_by_category('2026-10-01','2026-10-31')`);
assert.deepEqual(cats.map((c) => [c.category_name, Number(c.total_amount), Number(c.transaction_count)]), [["Comida", 134, 3], ["Viajes", 69, 2], ["Solo euros", 0, 1]], "gastos por categoría en soles (el EUR sin tasa cuenta 1 movimiento pero suma 0; una categoría solo con euros queda al final)");
assert.equal(Number(cats[0].percentage), Math.round((134 / 203) * 1000) / 10);

// presupuesto del mes en curso (usa CURRENT_DATE): US$ 100 hoy × la tasa de hoy (3.60) = 360
await como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN', (now() AT TIME ZONE 'America/Lima')::date, 3.60, 'prueba hoy') ON CONFLICT (par, fecha) DO UPDATE SET valor = 3.60`);
const ocio = (await q(`INSERT INTO categories (user_id, category_name, category_type) VALUES ($1,'Ocio','expense') RETURNING category_id`, [U2]))[0].category_id; // categoría propia: no depende del mes en que corra la prueba
await db.exec(`INSERT INTO budgets (user_id, category_id, amount_limit, period_type) VALUES ('${U2}', '${ocio}', 1000, 'monthly')`);
await m2(D, "expense", 100, "USD", null, ocio);
const pres = (await como("authenticated", U2, `SELECT amount_limit, amount_spent, percentage_used, remaining FROM fn_get_budget_status()`))[0];
assert.equal(Number(pres.amount_spent), 360, "el presupuesto en soles cuenta los dólares convertidos");
assert.equal(Number(pres.remaining), 640);
assert.equal(Number(pres.percentage_used), 36);

// (f) permisos de fx_rates
await falla(() => como("authenticated", U2, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN','2026-10-09',9,'x')`), /permission denied/i, "authenticated no escribe fx_rates");
await falla(() => como("authenticated", U2, `UPDATE fx_rates SET valor = 9`), /permission denied/i);
await falla(() => como("anon", null, `SELECT * FROM fx_rates`), /permission denied/i, "anon no lee");
assert.equal((await como("authenticated", U2, `SELECT count(*)::int AS n FROM fx_rates`))[0].n, (await q(`SELECT count(*)::int AS n FROM fx_rates`))[0].n, "authenticated sí lee");
await como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN','2026-10-05',3.51,'otra') ON CONFLICT (par, fecha) DO UPDATE SET valor = EXCLUDED.valor, fuente = EXCLUDED.fuente`);
assert.equal(Number((await como("authenticated", U2, `SELECT valor FROM fx_rates WHERE fecha = '2026-10-05'`))[0].valor), 3.51, "service_role hace upsert");
await falla(() => como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('usd/pen','2026-10-09',3,'x')`), /check/i, "par mal formado");
await falla(() => como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN','2026-10-09',0,'x')`), /check/i, "valor <= 0");
await falla(() => como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN','2026-10-09',1.99,'x')`), /check/i, "menos de 2 soles por dólar es un dato roto");
await falla(() => como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN','2026-10-09',6.01,'x')`), /check/i, "más de 6 soles por dólar es un dato roto");
await como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN','2026-10-12',2,'borde'), ('USD/PEN','2026-10-13',6,'borde')`); // los bordes valen
await como("service_role", null, `DELETE FROM fx_rates WHERE fuente = 'borde'`);
await falla(() => como("authenticated", U2, `DELETE FROM fx_rates`), /permission denied/i, "authenticated no borra");
assert.deepEqual(
  (await q(`SELECT has_table_privilege('authenticated','fx_rates','SELECT') AS s, has_table_privilege('authenticated','fx_rates','INSERT') AS i, has_table_privilege('authenticated','fx_rates','TRUNCATE') AS t, has_table_privilege('anon','fx_rates','SELECT') AS a`))[0],
  { s: true, i: false, t: false, a: false },
  "authenticated solo SELECT; anon nada (como en la 007)",
);

// (g) la misma regla en tres sitios: fx_tasa()/fn_a_soles()/día de Lima en SQL, tasaDeFecha()/aSoles()/limaDateKey() en _shared (agente, brief)
//     y tasaDeFecha()/aSoles()/diaLima() en la web. Un solo caso, tres respuestas que deben coincidir.
let fxFn, fxWeb, tiempo;
try {
  const ts = (...p) => pathToFileURL(path.join(dir, "..", ...p)).href;
  fxFn = await import(ts("functions", "_shared", "fx.ts"));
  tiempo = await import(ts("functions", "_shared", "google", "time.ts"));
  fxWeb = await import(pathToFileURL(path.join(dir, "..", "..", "apps", "web", "src", "lib", "fx.ts")).href);
} catch (e) {
  throw new Error(`No pude importar los .ts para comparar con SQL (hace falta Node >= 22.18 o --experimental-strip-types): ${e.message}`);
}
await como("service_role", null, `INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN','2026-11-02',3.455,'prueba g') ON CONFLICT (par, fecha) DO UPDATE SET valor = 3.455`);
const historial = (await q(`SELECT fecha::text AS fecha, valor::float8 AS valor FROM fx_rates WHERE par = 'USD/PEN'`)).map((r) => ({ fecha: r.fecha, valor: Number(r.valor) }));
for (const f of ["2020-01-01", "2026-09-01", "2026-10-01", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-09", "2026-11-01", "2026-11-02", "2026-12-31", "2031-01-01"]) {
  const sql = Number((await q(`SELECT fx_tasa('USD', $1::date) AS t`, [f]))[0].t);
  assert.equal(fxFn.tasaDeFecha(historial, f), sql, `tasaDeFecha (_shared) = fx_tasa (SQL) en ${f}`);
  assert.equal(fxWeb.tasaDeFecha(historial, f), sql, `tasaDeFecha (web) = fx_tasa (SQL) en ${f}`);
}
for (const t of ["2026-10-05T03:00:00Z", "2026-10-05T04:59:59Z", "2026-10-05T05:00:00Z", "2026-10-04T23:59:59-05:00", "2026-12-31T04:59:59Z", "2027-01-01T04:59:59Z", "2027-01-01T05:00:00Z", "2026-03-01T00:00:00Z"]) {
  const sql = (await q(`SELECT (($1::timestamptz) AT TIME ZONE 'America/Lima')::date::text AS d`, [t]))[0].d;
  assert.equal(fxWeb.diaLima(t), sql, `diaLima (web) = día de Lima (SQL) en ${t}`);
  assert.equal(tiempo.limaDateKey(new Date(t)), sql, `limaDateKey (_shared) = día de Lima (SQL) en ${t}`);
}
for (const [monto, fecha] of [[1, "2026-11-02"], [2, "2026-11-02"], [0.1, "2026-11-02"], [0.01, "2026-11-02"], [10.01, "2026-11-03"], [33.33, "2026-11-02"], [7.77, "2026-10-04"], [1234.56, "2026-11-02"], [999999.99, "2026-10-09"]]) {
  const sql = Number((await q(`SELECT fn_a_soles($1::numeric, 'USD', $2::date) AS s`, [monto, fecha]))[0].s);
  const valor = fxFn.tasaDeFecha(historial, fecha);
  assert.equal(fxFn.aSoles(monto, "USD", { valor, fecha }), sql, `aSoles (_shared) = fn_a_soles (SQL, redondeada a céntimos) para US$ ${monto} el ${fecha}`);
  assert.equal(fxWeb.aSoles(monto, "USD", { valor }), sql, `aSoles (web) = fn_a_soles (SQL) para US$ ${monto} el ${fecha}`);
}
assert.equal(Number((await q(`SELECT fn_a_soles(10, 'PEN', '2026-10-05'::date) AS s`))[0].s), 10, "los soles no se tocan");
assert.equal((await q(`SELECT fn_a_soles(10, 'EUR', '2026-10-05'::date) AS s`))[0].s, null, "sin tasa para esa moneda: NULL, nunca «vale lo mismo»");

// 016 una vez más encima de todo: sigue siendo idempotente y no toca datos
const snapshot = JSON.stringify(await q(`SELECT account_id, current_balance FROM accounts ORDER BY account_id`));
await run(archivo("016"));
assert.equal(JSON.stringify(await q(`SELECT account_id, current_balance FROM accounts ORDER BY account_id`)), snapshot, "correr 016 de nuevo no mueve saldos");

console.log(`check-016 OK (${hechas} operaciones al azar aplicadas, ${rechazadas} rechazadas)`);
