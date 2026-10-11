// node --experimental-strip-types --test supabase/functions/_shared/fx.test.ts
// Tipo de cambio: parseo de BCRP (con una respuesta real de la API), respaldo, conversión, patrimonio y la caché en fx_rates con una base
// y una red falsas. Nada sale a internet.
import test from "node:test";
import assert from "node:assert/strict";
import {
  aSoles, primerJson, DIAS_HISTORIAL, DIAS_SOLAPE, FUENTE_BCRP, FUENTE_RESPALDO, hayQueRefrescar, historial, parsearBcrp, parsearRespaldo, patrimonio,
  refrescar, reiniciarIntentos, restarDias, tasaDeFecha, textoTc, tipoCambioVigente, type Db, type Tasa, ultimaTasa, urlBcrp,
} from "./fx.ts";

// Respuesta REAL de la API (11-oct-2026, consulta del 1 al 11): fines de semana ausentes, feriados «n.d.», valores con muchos decimales.
const BCRP_REAL = `{
"config":{"title":"Tipo de cambio","series":[{"name":"Tipo de cambio - TC Sistema bancario SBS (S/ por US$) - Venta","dec":"3"}]},
"periods":[{"name":"05.Oct.26","values":["3.435"]},{"name":"06.Oct.26","values":["3.437"]},{"name":"07.Oct.26","values":["3.453"]},
{"name":"08.Oct.26","values":["n.d."]},{"name":"09.Oct.26","values":["n.d."]}]}`;
const BCRP_SETIEMBRE = `{"config":{},"periods":[{"name":"31.Ago.26","values":["3.367"]},{"name":"01.Set.26","values":["3.368"]},{"name":"02.Sep.26","values":["3.36"]},{"name":"03.Dec.26","values":["3.365"]}]}`;
const FIREWALL = `<!DOCTYPE html><html><head><script src="/oly-Almost-That-hane-Sey-a-sleepe-Atter-Macduffe" async></script><title></title></head><body></body></html>`;

test("parsearBcrp: toma los días con valor y salta los «n.d.»", () => {
  assert.deepEqual(parsearBcrp(BCRP_REAL), [
    { fecha: "2026-10-05", valor: 3.435 }, { fecha: "2026-10-06", valor: 3.437 }, { fecha: "2026-10-07", valor: 3.453 },
  ]);
});

// Caso REAL (11-oct-2026): tras el JSON válido, BCRP a veces pega un aviso de PHP en HTML y JSON.parse del texto entero falla.
const BCRP_CON_AVISO_PHP = BCRP_REAL +
  "<br />\n<font size='1'><table class='xdebug-error xe-notice' dir='ltr' border='1' cellspacing='0' cellpadding='1'>\n<tr><th>Notice: Undefined offset: 3 in /var/www/{x}.php</th></tr></table></font>";
test("parsearBcrp: tolera el aviso de PHP que BCRP pega después del JSON (visto en vivo)", () => {
  assert.equal(parsearBcrp(BCRP_CON_AVISO_PHP)?.length, 3);
  assert.deepEqual(parsearBcrp(BCRP_CON_AVISO_PHP), parsearBcrp(BCRP_REAL));
});

test("primerJson: respeta llaves y comillas dentro de textos", () => {
  assert.equal(primerJson('basura {"a":"} {","b":{"c":1}} cola }'), '{"a":"} {","b":{"c":1}}');
  assert.equal(primerJson('{"a":"\\"}"}x'), '{"a":"\\"}"}');
  assert.equal(primerJson("sin json"), null);
  assert.equal(primerJson('{"abierto":'), null);
});

test("parsearBcrp: setiembre viene como «Set» (también se acepta Sep/Dec en inglés)", () => {
  assert.deepEqual(parsearBcrp(BCRP_SETIEMBRE)?.map((p) => p.fecha), ["2026-08-31", "2026-09-01", "2026-09-02", "2026-12-03"]);
});

test("parsearBcrp: la página del firewall (HTML con 200) es null, no un error ni un vacío", () => {
  assert.equal(parsearBcrp(FIREWALL), null);
  assert.equal(parsearBcrp(""), null);
  assert.equal(parsearBcrp("{}"), null);
});

test("parsearBcrp: una consulta sin días publicados da [] (no null)", () => {
  assert.deepEqual(parsearBcrp('{"config":{},"periods":[]}'), []);
});

test("parsearBcrp: valores absurdos se descartan (un dólar no vale 0 ni 3400 soles)", () => {
  const j = JSON.stringify({ periods: [{ name: "01.Oct.26", values: ["0"] }, { name: "02.Oct.26", values: ["3400"] }, { name: "03.Oct.26", values: ["-3"] }, { name: "04.Oct.26", values: ["3.4"] }, { name: "Basura", values: ["3.4"] }, { name: "05.Xxx.26", values: ["3.4"] }] });
  assert.deepEqual(parsearBcrp(j), [{ fecha: "2026-10-04", valor: 3.4 }]);
});

test("parsearRespaldo: toma PEN; rechaza lo que no sea éxito o lo absurdo", () => {
  assert.equal(parsearRespaldo({ result: "success", rates: { PEN: 3.442249 } }), 3.442249);
  assert.equal(parsearRespaldo({ result: "error", rates: { PEN: 3.4 } }), null);
  assert.equal(parsearRespaldo({ result: "success", rates: {} }), null);
  assert.equal(parsearRespaldo({ result: "success", rates: { PEN: 0 } }), null);
  assert.equal(parsearRespaldo(null), null);
});

test("urlBcrp y restarDias", () => {
  assert.equal(urlBcrp("2026-10-01", "2026-10-11"), "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04640PD/json/2026-10-01/2026-10-11/esp");
  assert.equal(restarDias("2026-03-02", 7), "2026-02-23");
  assert.equal(restarDias("2026-01-03", 7), "2025-12-27");
});

// ------------------------------------------------------------------------------------------------ conversión
test("aSoles: PEN no cambia, USD multiplica y redondea a céntimos, lo demás es null", () => {
  const tc = { valor: 3.453, fecha: "2026-10-07" };
  assert.equal(aSoles(100, "PEN", tc), 100);
  assert.equal(aSoles(100, null, tc), 100);
  assert.equal(aSoles(100, "USD", tc), 345.3);
  assert.equal(aSoles(0.1, "usd", { valor: 3.45, fecha: "x" }), 0.35); // 0.345 → 0.35 sin errores de coma flotante
  assert.equal(aSoles(100, "USD", null), null, "sin tipo de cambio no se inventa");
  assert.equal(aSoles(100, "USD", { valor: 0, fecha: "x" }), null);
  assert.equal(aSoles(100, "EUR", tc), null);
});

test("textoTc: hasta 3 decimales sin ceros de más", () => {
  assert.equal(textoTc(3.453), "3.453");
  assert.equal(textoTc(3.75), "3.75");
  assert.equal(textoTc(3.4), "3.4");
  assert.equal(textoTc(3.442249), "3.442");
});

test("patrimonio: la tarjeta resta, los dólares se convierten y se informan aparte", () => {
  const tc = { valor: 3.5, fecha: "2026-10-07" };
  const p = patrimonio([
    { account_type: "checking", currency_code: "PEN", current_balance: 1000 },
    { account_type: "credit_card", currency_code: "PEN", current_balance: 200 }, // deuda
    { account_type: "savings", currency_code: "USD", current_balance: "500" }, // numeric llega como texto
    { account_type: "credit_card", currency_code: "USD", current_balance: 100 },
  ], tc);
  assert.deepEqual(p, { soles: 800 + 1400 , pen: 800, usd: 400, hayUsd: true, usdEnSoles: 1400, otrasMonedas: false });
});

test("patrimonio: con dólares y sin tipo de cambio el total NO los suma como soles", () => {
  const p = patrimonio([
    { account_type: "checking", currency_code: "PEN", current_balance: 1000 },
    { account_type: "savings", currency_code: "USD", current_balance: 500 },
  ], null);
  assert.equal(p.soles, 1000);
  assert.equal(p.usd, 500);
  assert.equal(p.usdEnSoles, null);
});

test("patrimonio: sin dólares no hace falta tipo de cambio; otra moneda se avisa y no se suma", () => {
  assert.deepEqual(patrimonio([{ account_type: "cash", currency_code: "PEN", current_balance: 50 }], null), { soles: 50, pen: 50, usd: 0, hayUsd: false, usdEnSoles: 0, otrasMonedas: false });
  const e = patrimonio([{ account_type: "cash", currency_code: "EUR", current_balance: 50 }, { account_type: "cash", current_balance: 5 }], null);
  assert.equal(e.otrasMonedas, true);
  assert.equal(e.soles, 5, "una cuenta sin moneda cuenta como soles; el euro no entra");
});

test("tasaDeFecha: el último valor <= la fecha; antes del primero, el primero; sin nada, null", () => {
  const h = [{ fecha: "2026-10-05", valor: 3.5 }, { fecha: "2026-10-01", valor: 3.4 }];
  assert.equal(tasaDeFecha(h, "2026-10-03"), 3.4);
  assert.equal(tasaDeFecha(h, "2026-10-05"), 3.5);
  assert.equal(tasaDeFecha(h, "2026-12-31"), 3.5);
  assert.equal(tasaDeFecha(h, "2026-09-01"), 3.4);
  assert.equal(tasaDeFecha([], "2026-10-05"), null);
});

// ------------------------------------------------------------------------------------------------ caché
type Fila = Record<string, unknown>;
/** fx_rates en memoria con el mismo encadenado que usa fx.ts. `falla` hace fallar la escritura. */
function baseFalsa(inicial: Fila[] = [], opts: { falla?: boolean } = {}) {
  const filas = [...inicial];
  const upserts: Fila[][] = [];
  const db = {
    from: (_t: string) => {
      let data = filas;
      let cols: string[] | null = null;
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: (c: string) => ((cols = c.split(",").map((x) => x.trim())), b),
        eq: (c: string, v: unknown) => ((data = data.filter((r) => r[c] === v)), b),
        gte: (c: string, v: string) => ((data = data.filter((r) => String(r[c]) >= v)), b),
        lt: (c: string, v: string) => ((data = data.filter((r) => String(r[c]) < v)), b),
        order: (c: string, o?: { ascending?: boolean }) => {
          const d = o?.ascending === false ? -1 : 1;
          data = [...data].sort((x, y) => (String(x[c]) < String(y[c]) ? -d : String(x[c]) > String(y[c]) ? d : 0));
          return b;
        },
        limit: (n: number) => ((data = data.slice(0, n)), b),
        upsert: async (nuevas: Fila[]) => {
          if (opts.falla) return { error: { message: "rls" } };
          upserts.push(nuevas);
          for (const n of nuevas) {
            const i = filas.findIndex((r) => r.par === n.par && r.fecha === n.fecha);
            if (i >= 0) filas[i] = { ...filas[i], ...n }; else filas.push(n);
          }
          return { error: null };
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve({ data: cols ? data.map((r) => Object.fromEntries(cols!.map((c) => [c, r[c]]))) : data, error: null }).then(ok, ko),
      };
      return b;
    },
  };
  return { db: db as unknown as Db, filas, upserts };
}
type Pedido = { url: string };
/** fetch guionado por URL: cada fuente responde con un texto, un estado o se cae. */
function redFalsa(bcrp: string | { status: number } | "cae", respaldo: object | { status: number } | "cae") {
  const pedidos: Pedido[] = [];
  const f = (async (url: string) => {
    pedidos.push({ url: String(url) });
    const r = String(url).includes("bcrp.gob.pe") ? bcrp : respaldo;
    if (r === "cae") throw new Error("sin red");
    if (typeof r === "object" && "status" in r) return { ok: false, status: r.status, text: async () => "", json: async () => ({}) };
    const texto = typeof r === "string" ? r : JSON.stringify(r);
    return { ok: true, status: 200, text: async () => texto, json: async () => JSON.parse(texto) };
  }) as unknown as typeof fetch;
  return { f, pedidos };
}
const AHORA = new Date("2026-10-11T17:00:00Z");
const HOY = "2026-10-11";
const RESP_OK = { result: "success", rates: { PEN: 3.442249 } };
const fila = (fecha: string, valor: number, obtenido: string, fuente = FUENTE_BCRP): Fila => ({ par: "USD/PEN", fecha, valor, fuente, obtenido_en: obtenido });

test("refrescar: BCRP bien → guarda los días publicados con su fuente; sin historial pide un año", async () => {
  reiniciarIntentos();
  const { db, filas } = baseFalsa();
  const { f, pedidos } = redFalsa(BCRP_REAL, RESP_OK);
  const r = await refrescar(db, { ahora: AHORA, hoy: HOY, f });
  assert.deepEqual(r, { fuente: FUENTE_BCRP, filas: 3 });
  assert.deepEqual(filas.map((x) => [x.fecha, x.valor, x.fuente]), [["2026-10-05", 3.435, FUENTE_BCRP], ["2026-10-06", 3.437, FUENTE_BCRP], ["2026-10-07", 3.453, FUENTE_BCRP]]);
  assert.equal(pedidos.length, 1, "BCRP respondió: no se toca el respaldo");
  assert.ok(pedidos[0]!.url.includes(`/${restarDias(HOY, DIAS_HISTORIAL)}/${HOY}/`), "primera vez: un año atrás");
});

test("refrescar: con historial pide desde unos días antes del último (para tomar correcciones) y actualiza obtenido_en", async () => {
  const { db, filas } = baseFalsa([fila("2026-10-05", 3.4, "2026-10-06T00:00:00Z")]);
  const { f, pedidos } = redFalsa(BCRP_REAL, RESP_OK);
  await refrescar(db, { ahora: AHORA, hoy: HOY, f });
  assert.ok(pedidos[0]!.url.includes(`/${restarDias("2026-10-05", DIAS_SOLAPE)}/${HOY}/`));
  const cinco = filas.find((x) => x.fecha === "2026-10-05")!;
  assert.equal(cinco.valor, 3.435, "el valor corregido pisa al viejo");
  assert.equal(cinco.obtenido_en, AHORA.toISOString());
});

test("refrescar: firewall de BCRP (HTML) → usa el respaldo con la fecha de hoy y lo dice en la fuente", async () => {
  const { db, filas } = baseFalsa();
  const { f, pedidos } = redFalsa(FIREWALL, RESP_OK);
  const r = await refrescar(db, { ahora: AHORA, hoy: HOY, f });
  assert.deepEqual(r, { fuente: FUENTE_RESPALDO, filas: 1 });
  assert.deepEqual(filas.map((x) => [x.fecha, x.valor, x.fuente]), [[HOY, 3.442249, FUENTE_RESPALDO]]);
  assert.equal(pedidos.length, 3, "BCRP dos veces (el firewall es intermitente) y luego el respaldo");
});

test("refrescar: BCRP sin días publicados, o caído, también cae al respaldo", async () => {
  for (const bcrp of ['{"periods":[]}', { status: 500 }, "cae"] as const) {
    const { db, filas } = baseFalsa();
    const { f } = redFalsa(bcrp, RESP_OK);
    assert.equal((await refrescar(db, { ahora: AHORA, hoy: HOY, f }))?.fuente, FUENTE_RESPALDO);
    assert.equal(filas.length, 1);
  }
});

test("refrescar: si ninguna fuente responde devuelve null y no toca lo guardado", async () => {
  const previo = [fila("2026-10-07", 3.453, "2026-10-08T00:00:00Z")];
  for (const [b, r] of [["cae", "cae"], [FIREWALL, { status: 429 }], [FIREWALL, { result: "error" }]] as const) {
    const { db, filas, upserts } = baseFalsa(previo);
    const { f } = redFalsa(b, r);
    assert.equal(await refrescar(db, { ahora: AHORA, hoy: HOY, f }), null);
    assert.equal(upserts.length, 0);
    assert.deepEqual(filas, previo);
  }
});

test("refrescar: si la base rechaza la escritura devuelve null (no finge que guardó)", async () => {
  const { db } = baseFalsa([], { falla: true });
  const { f } = redFalsa(BCRP_REAL, RESP_OK);
  assert.equal(await refrescar(db, { ahora: AHORA, hoy: HOY, f }), null);
});

test("hayQueRefrescar: vacío, vencido (>6 h) o con fecha ilegible sí; reciente no", () => {
  const t = (obtenido: string): Tasa => ({ par: "USD/PEN", fecha: "2026-10-07", valor: 3.4, fuente: "x", obtenido_en: obtenido });
  assert.equal(hayQueRefrescar(null, AHORA), true);
  assert.equal(hayQueRefrescar(t("2026-10-11T12:30:00Z"), AHORA), false); // hace 4,5 h
  assert.equal(hayQueRefrescar(t("2026-10-11T10:00:00Z"), AHORA), true); // hace 7 h
  assert.equal(hayQueRefrescar(t("basura"), AHORA), true);
});

test("tipoCambioVigente: lo reciente se devuelve sin tocar la red", async () => {
  reiniciarIntentos();
  const { db } = baseFalsa([fila("2026-10-07", 3.453, "2026-10-11T15:00:00Z")]);
  const { f, pedidos } = redFalsa(BCRP_REAL, RESP_OK);
  const r = await tipoCambioVigente(db, { ahora: AHORA, hoy: HOY, f });
  assert.equal(r.actualizado, false);
  assert.equal(r.tasa?.valor, 3.453);
  assert.equal(pedidos.length, 0);
});

test("tipoCambioVigente: vencido → refresca y devuelve el nuevo; los números llegan como número", async () => {
  reiniciarIntentos();
  const { db } = baseFalsa([fila("2026-10-02", 3.4, "2026-10-09T00:00:00Z")]);
  const { f } = redFalsa(BCRP_REAL, RESP_OK);
  const r = await tipoCambioVigente(db, { ahora: AHORA, hoy: HOY, f });
  assert.equal(r.actualizado, true);
  assert.deepEqual([r.tasa?.fecha, r.tasa?.valor], ["2026-10-07", 3.453]);
});

test("tipoCambioVigente: si todo falla devuelve el último valor guardado y no insiste antes de 5 minutos", async () => {
  reiniciarIntentos();
  const { db } = baseFalsa([fila("2026-10-07", 3.453, "2026-10-09T00:00:00Z")]);
  const { f, pedidos } = redFalsa("cae", "cae");
  const r1 = await tipoCambioVigente(db, { ahora: AHORA, hoy: HOY, f });
  assert.equal(r1.actualizado, false);
  assert.equal(r1.tasa?.valor, 3.453, "último valor conocido");
  const antes = pedidos.length;
  assert.ok(antes >= 1);
  await tipoCambioVigente(db, { ahora: new Date(AHORA.getTime() + 60_000), hoy: HOY, f });
  assert.equal(pedidos.length, antes, "un minuto después no vuelve a golpear a BCRP");
  await tipoCambioVigente(db, { ahora: new Date(AHORA.getTime() + 6 * 60_000), hoy: HOY, f });
  assert.ok(pedidos.length > antes, "a los 6 minutos sí reintenta");
});

test("tipoCambioVigente: sin nada guardado y sin red → tasa null (el llamador dice «sin tipo de cambio»)", async () => {
  reiniciarIntentos();
  const { db } = baseFalsa();
  const { f } = redFalsa("cae", "cae");
  assert.deepEqual(await tipoCambioVigente(db, { ahora: AHORA, hoy: HOY, f }), { tasa: null, actualizado: false });
});

test("ultimaTasa e historial: leen lo guardado como números y ordenan bien", async () => {
  const { db } = baseFalsa([fila("2026-10-01", 3.4, "x"), fila("2026-10-07", "3.453" as unknown as number, "y"), fila("2026-09-20", 3.3, "z")]);
  const u = await ultimaTasa(db);
  assert.deepEqual([u?.fecha, u?.valor], ["2026-10-07", 3.453]);
  assert.deepEqual(await historial(db, "2026-10-01"), [{ fecha: "2026-09-20", valor: 3.3 }, { fecha: "2026-10-01", valor: 3.4 }, { fecha: "2026-10-07", valor: 3.453 }]);
  assert.equal(await ultimaTasa(baseFalsa().db), null);
});
