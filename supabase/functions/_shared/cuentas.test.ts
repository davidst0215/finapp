// node --experimental-strip-types --test supabase/functions/_shared/cuentas.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  buscarCuenta, fraseCuentaCreada, fraseCuentas, mismoNombre, monedaDesdeTexto, monto, numeroDictado, opcionesHabladas, tipoDesdeTexto, validarCuentaNueva,
  type CuentaMin,
} from "./cuentas.ts";

const cta = (id: string, nombre: string, tipo = "checking", moneda = "PEN", saldo = 0): CuentaMin =>
  ({ account_id: id, account_name: nombre, account_type: tipo, currency_code: moneda, current_balance: saldo });

const CUENTAS = [
  cta("1", "BCP Soles", "checking", "PEN", 1200),
  cta("2", "BCP Dólares", "savings", "USD", 300),
  cta("3", "Interbank", "checking", "PEN", 500),
  cta("4", "Visa Oro", "credit_card", "PEN", 800),
  cta("5", "Efectivo", "cash", "PEN", 80),
];

test("validarCuentaNueva: solo el nombre alcanza; el resto toma valores por defecto", () => {
  const v = validarCuentaNueva({ account_name: "Interbank" }, []);
  assert.deepEqual(v, { ok: true, cuenta: { account_name: "Interbank", account_type: "checking", currency_code: "PEN", current_balance: 0 } });
});

test("validarCuentaNueva: «Interbank en soles con 500» y los tipos y monedas dichos a la peruana", () => {
  const v = validarCuentaNueva({ account_name: "  Interbank ", currency_code: "soles", initial_balance: 500 }, []);
  assert.equal(v.ok && v.cuenta.currency_code, "PEN");
  assert.equal(v.ok && v.cuenta.current_balance, 500);
  const d = validarCuentaNueva({ account_name: "Wise", account_type: "ahorros", currency_code: "dólares", initial_balance: "1,250.5" }, []);
  assert.deepEqual(d.ok && d.cuenta, { account_name: "Wise", account_type: "savings", currency_code: "USD", current_balance: 1250.5 });
  assert.equal(validarCuentaNueva({ account_name: "Visa", account_type: "tarjeta de crédito" }, []).ok, true);
});

test("validarCuentaNueva: sin nombre pregunta, nunca inventa", () => {
  for (const args of [{}, { account_name: "" }, { account_name: "   " }, { account_name: 7 }]) {
    const v = validarCuentaNueva(args, []);
    assert.equal(v.ok, false);
    assert.match(v.ok ? "" : v.error, /Cómo se llama/);
  }
});

test("validarCuentaNueva: rechaza tipo, moneda y saldo que no se entienden o no caben", () => {
  const err = (args: Record<string, unknown>) => {
    const v = validarCuentaNueva({ account_name: "X1", ...args }, []);
    assert.equal(v.ok, false, JSON.stringify(args));
    return v.ok ? "" : v.error;
  };
  assert.match(err({ account_type: "criptomoneda" }), /tipo/);
  assert.match(err({ currency_code: "EUR" }), /soles o dólares/);
  assert.match(err({ currency_code: "yenes" }), /soles o dólares/);
  assert.match(err({ initial_balance: "mucho" }), /saldo/);
  assert.match(err({ initial_balance: Number.NaN }), /saldo/);
  assert.match(err({ initial_balance: Infinity }), /saldo|grande/);
  assert.match(err({ initial_balance: 5e12 }), /grande/);
  assert.match(err({ account_type: "credit_card", initial_balance: -50 }), /debes/);
  assert.match(err({ account_name: "a".repeat(101) }), /largo/);
  assert.match(err({ account_name: "---" }), /letras o números/);
});

test("validarCuentaNueva: acepta saldo negativo en una cuenta normal y redondea a céntimos", () => {
  const v = validarCuentaNueva({ account_name: "Sobregiro", initial_balance: -120.456 }, []);
  assert.equal(v.ok && v.cuenta.current_balance, -120.46);
  const s = validarCuentaNueva({ account_name: "Caja", initial_balance: 0.1 + 0.2 }, []);
  assert.equal(s.ok && s.cuenta.current_balance, 0.3);
});

test("validarCuentaNueva: limpia saltos y espacios del nombre", () => {
  const v = validarCuentaNueva({ account_name: "  BBVA\n  Continental\t" }, []);
  assert.equal(v.ok && v.cuenta.account_name, "BBVA Continental");
});

test("validarCuentaNueva: no duplica por nombre (tildes, mayúsculas, «cuenta», orden)", () => {
  const existentes = [cta("1", "Interbank"), cta("2", "Banco de Crédito")];
  for (const nombre of ["interbank", "INTERBANK", "Cuenta Interbank", "mi cuenta interbank", "Interbank "]) {
    const v = validarCuentaNueva({ account_name: nombre }, existentes);
    assert.equal(v.ok, false, nombre);
    assert.equal(!v.ok && v.duplicada?.account_id, "1");
  }
  assert.equal(validarCuentaNueva({ account_name: "Banco Crédito de" }, existentes).ok, false); // mismas palabras, otro orden
  // un nombre distinto o más largo sí es otra cuenta
  assert.equal(validarCuentaNueva({ account_name: "Interbank Dólares" }, existentes).ok, true);
  assert.equal(validarCuentaNueva({ account_name: "BCP" }, existentes).ok, true);
});

test("mismoNombre: sin relleno ni tildes", () => {
  assert.equal(mismoNombre("Crédito BCP", "credito bcp"), true);
  assert.equal(mismoNombre("La cuenta de BCP", "bcp"), true);
  assert.equal(mismoNombre("BCP Soles", "BCP"), false);
});

test("tipoDesdeTexto y monedaDesdeTexto", () => {
  assert.equal(tipoDesdeTexto("credit_card"), "credit_card");
  assert.equal(tipoDesdeTexto("Ahorros"), "savings");
  assert.equal(tipoDesdeTexto("tarjeta"), "credit_card");
  assert.equal(tipoDesdeTexto("efectivo"), "cash");
  assert.equal(tipoDesdeTexto("Inversión"), "investment");
  assert.equal(tipoDesdeTexto("banco"), "checking");
  assert.equal(tipoDesdeTexto("moto"), null);
  assert.equal(tipoDesdeTexto(undefined), null);
  assert.equal(monedaDesdeTexto("PEN"), "PEN");
  assert.equal(monedaDesdeTexto("soles"), "PEN");
  assert.equal(monedaDesdeTexto("Dólares"), "USD");
  assert.equal(monedaDesdeTexto("$"), "USD");
  assert.equal(monedaDesdeTexto("euros"), null);
});

test("buscarCuenta: nombre aproximado — «la de BCP», «mi Interbank»", () => {
  const uno = (q: string) => {
    const r = buscarCuenta(q, CUENTAS);
    assert.equal(r.kind, "one", q);
    return r.kind === "one" ? r.cuenta.account_name : "";
  };
  assert.equal(uno("mi Interbank"), "Interbank");
  assert.equal(uno("la cuenta de interbank"), "Interbank");
  assert.equal(uno("INTERBANK"), "Interbank");
  assert.equal(uno("bcp dolares"), "BCP Dólares");
  assert.equal(uno("la de BCP en dólares"), "BCP Dólares");
  assert.equal(uno("visa"), "Visa Oro");
  assert.equal(uno("la efectivo"), "Efectivo");
  // por tipo cuando solo hay una de ese tipo
  assert.equal(uno("mi tarjeta"), "Visa Oro");
  assert.equal(uno("el efectivo"), "Efectivo");
});

test("buscarCuenta: «la de BCP» con dos BCP pregunta; el nombre exacto gana", () => {
  const r = buscarCuenta("la de BCP", CUENTAS);
  assert.equal(r.kind, "many");
  assert.deepEqual(r.kind === "many" ? r.cuentas.map((c) => c.account_name) : [], ["BCP Soles", "BCP Dólares"]);
  const soloUno = buscarCuenta("bcp", [cta("1", "BCP"), cta("2", "BCP Dólares")]);
  assert.equal(soloUno.kind === "one" && soloUno.cuenta.account_id, "1");
});

test("buscarCuenta: sin coincidencia, vacía o con basura", () => {
  assert.equal(buscarCuenta("scotiabank", CUENTAS).kind, "none");
  assert.equal(buscarCuenta("", CUENTAS).kind, "none");
  assert.equal(buscarCuenta("la de", CUENTAS).kind, "none");
  assert.equal(buscarCuenta(undefined, CUENTAS).kind, "none");
  assert.equal(buscarCuenta("interbank", []).kind, "none");
  // dos tarjetas: «la tarjeta» es ambigua
  const dos = [cta("1", "Visa", "credit_card"), cta("2", "Master", "credit_card")];
  assert.equal(buscarCuenta("la tarjeta", dos).kind, "many");
});

test("buscarCuenta: el tipo sirve SOLO si todas las palabras son de tipo; una palabra de más es otra cuenta (se pregunta, no se carga a la única tarjeta)", () => {
  const unaTarjeta = [cta("1", "BBVA Oro", "credit_card"), cta("2", "Interbank", "checking"), cta("3", "BCP Ahorro Plus", "savings"), cta("4", "Efectivo", "cash")];
  // puros: sí
  for (const q of ["la tarjeta", "mi tarjeta de crédito", "la tc", "tarjeta de credito"]) {
    const r = buscarCuenta(q, unaTarjeta);
    assert.equal(r.kind === "one" && r.cuenta.account_id, "1", q);
  }
  assert.equal(buscarCuenta("mis ahorros", [cta("1", "Mi caja", "savings"), cta("2", "Interbank")]).kind, "one");
  // con una palabra que no es de tipo: no
  for (const q of ["la tarjeta Falabella", "mastercard", "mi visa", "la visa de falabella", "ahorros de Scotiabank", "la tarjeta del BCP", "efectivo del viaje"]) {
    assert.equal(buscarCuenta(q, unaTarjeta).kind, "none", q);
  }
  // por nombre sigue funcionando: «visa» es parte del nombre de esta
  assert.equal(buscarCuenta("la visa", [cta("1", "Visa Oro", "credit_card"), cta("2", "Interbank")]).kind, "one");
  // tipos mezclados en una misma frase no son un tipo
  assert.equal(buscarCuenta("tarjeta de ahorros", unaTarjeta).kind, "none");
  // dos de ese tipo puro: se pregunta
  const dos = buscarCuenta("las tarjetas", [cta("1", "Visa", "credit_card"), cta("2", "Master", "credit_card")]);
  assert.equal(dos.kind === "many" && dos.cuentas.length, 2);
});

test("tipoDesdeTexto: visa y mastercard son marcas, no tipos", () => {
  assert.equal(tipoDesdeTexto("visa"), null);
  assert.equal(tipoDesdeTexto("mastercard"), null);
  assert.equal(validarCuentaNueva({ account_name: "X1", account_type: "visa" }, []).ok, false);
});

test("numeroDictado: la coma es de miles o es un decimal claro; nunca 1,5 → 15", () => {
  const casos: [unknown, number | null][] = [
    [500, 500], ["500", 500], ["500.25", 500.25], [" 500 ", 500], ["-120", -120],
    ["1,500", 1500], ["12,345", 12345], ["1,234,567", 1234567], ["1,234.50", 1234.5], ["1,5", 1.5], ["12,50", 12.5], ["0,5", 0.5], ["-2,5", -2.5],
    ["S/ 500", 500], ["US$ 1,250.5", 1250.5], ["$20", 20], ["1 500", 1500],
    ["1,2345", null], ["1,5,0", null], ["1,234,5", null], ["12,3456", null], ["1.5.0", null], [",5", null], ["1,", null], ["5e3", null], ["abc", null], ["", null],
    [Number.NaN, null], [Infinity, null], [null, null], [undefined, null], [{}, null],
  ];
  for (const [entrada, esperado] of casos) assert.equal(numeroDictado(entrada), esperado, JSON.stringify(entrada));
});

test("numeroDictado: «1.500» y «2.000» (punto + 3 decimales) son ambiguos → null, no 1,5 ni 2", () => {
  for (const t of ["1.500", "2.000", "US$ 1.500", "S/ 2.000", "-1.500", "10.500", "100.500", "999.999"]) assert.equal(numeroDictado(t), null, t);
  // los que no son ambiguos siguen leyéndose
  const claros: [string, number][] = [["1.50", 1.5], ["1.5", 1.5], ["2.0", 2], ["1.5000", 1.5], ["0.500", 0.5], ["1500.250", 1500.25], ["1,500.250", 1500.25], ["500", 500], ["1500", 1500]];
  for (const [t, n] of claros) assert.equal(numeroDictado(t), n, t);
  // y en un saldo se pide repetirlo en vez de guardar 2
  const v = validarCuentaNueva({ account_name: "Caja X", initial_balance: "2.000" }, []);
  assert.equal(v.ok, false);
});

test("numeroDictado: «0,500» NO es 500 (el primer grupo de miles no empieza en 0)", () => {
  for (const t of ["0,500", "00,500", "01,500", "0,500,000", "-0,500"]) assert.equal(numeroDictado(t), null, t);
  assert.equal(numeroDictado("0,5"), 0.5);
  assert.equal(numeroDictado("0,50"), 0.5);
  assert.equal(numeroDictado("1,500"), 1500);
  assert.equal(numeroDictado("999,999"), 999999);
  assert.equal(numeroDictado("12,345,678"), 12345678);
  assert.equal(validarCuentaNueva({ account_name: "Caja Y", initial_balance: "0,500" }, []).ok, false);
});

test("buscarCuenta: abreviaturas («scotia» → Scotiabank, «inter» → Interbank) solo si el resultado es único", () => {
  const cs = [cta("1", "Scotiabank Soles"), cta("2", "Scotiabank Dólares", "savings", "USD"), cta("3", "Interbank"), cta("4", "BCP")];
  assert.equal(buscarCuenta("inter", cs).kind === "one" && (buscarCuenta("inter", cs) as { cuenta: CuentaMin }).cuenta.account_id, "3");
  assert.equal(buscarCuenta("la de inter", cs).kind, "one");
  // dos Scotiabank: se pregunta
  const scotia = buscarCuenta("scotia", cs);
  assert.equal(scotia.kind, "many");
  assert.deepEqual(scotia.kind === "many" ? scotia.cuentas.map((c) => c.account_id) : [], ["1", "2"]);
  // con otra palabra del nombre queda única
  const soles = buscarCuenta("scotia soles", cs);
  assert.equal(soles.kind === "one" && soles.cuenta.account_id, "1");
  // «inter» ambiguo si hay dos
  assert.equal(buscarCuenta("inter", [...cs, cta("5", "Intercorp")]).kind, "many");
  // demasiado corto o sin relación: nada
  assert.equal(buscarCuenta("in", cs).kind, "none");
  assert.equal(buscarCuenta("sco", [cta("1", "Scotiabank")]).kind, "one"); // 3 letras alcanzan si es única
  assert.equal(buscarCuenta("xyz", cs).kind, "none");
  // el nombre exacto sigue ganando a la abreviatura: «bcp» no es prefijo de nada más
  assert.equal(buscarCuenta("bcp", cs).kind === "one" && (buscarCuenta("bcp", cs) as { cuenta: CuentaMin }).cuenta.account_id, "4");
  // lo de tipo con una palabra de más sigue sin cargarse a una cuenta ajena
  assert.equal(buscarCuenta("ahorros de scotiabank", [cta("1", "BBVA Oro", "savings")]).kind, "none");
  assert.equal(buscarCuenta("la tarjeta falabella", [cta("1", "BBVA Oro", "credit_card")]).kind, "none");
});

test("tipoDesdeTexto: «otro/otra» ya no son un tipo (solo el código other)", () => {
  assert.equal(tipoDesdeTexto("otro"), null);
  assert.equal(tipoDesdeTexto("otra"), null);
  assert.equal(tipoDesdeTexto("other"), "other");
  assert.equal(validarCuentaNueva({ account_name: "Rara", account_type: "otra" }, []).ok, false);
  assert.equal(validarCuentaNueva({ account_name: "Rara", account_type: "other" }, []).ok, true);
  // y «otra» como palabra suelta no resuelve a la única cuenta de tipo other
  assert.equal(buscarCuenta("la otra", [cta("1", "Cuenta rara", "other"), cta("2", "BCP")]).kind, "none");
});

test("validarCuentaNueva: «1,5» de saldo es 1,5 (o se rechaza), jamás 15", () => {
  const saldo = (initial_balance: unknown) => {
    const v = validarCuentaNueva({ account_name: "Caja X", initial_balance }, []);
    return v.ok ? v.cuenta.current_balance : null;
  };
  assert.equal(saldo("1,5"), 1.5);
  assert.equal(saldo("1,500"), 1500);
  assert.equal(saldo("1,2345"), null);
  assert.equal(saldo("1,5,0"), null);
});

test("buscarCuenta: una cuenta cuyo nombre es solo relleno («Mi cuenta») sigue encontrándose", () => {
  const cs = [cta("1", "Mi cuenta"), cta("2", "BCP")];
  const r = buscarCuenta("mi cuenta", cs);
  assert.equal(r.kind === "one" && r.cuenta.account_id, "1");
  assert.equal(buscarCuenta("la cuenta", cs).kind, "none");
  assert.equal(validarCuentaNueva({ account_name: "Mi Cuenta" }, cs).ok, false, "y no se duplica");
});

test("buscarCuenta: encuentra la cuenta recién creada con el mismo nombre que se validó", () => {
  const v = validarCuentaNueva({ account_name: "Interbank Ahorro Mujer", account_type: "savings" }, []);
  assert.equal(v.ok, true);
  const nueva = cta("9", v.ok ? v.cuenta.account_name : "", "savings");
  assert.equal(buscarCuenta("mi interbank", [nueva]).kind, "one");
  assert.equal(buscarCuenta("interbank ahorro", [nueva]).kind, "one");
  assert.equal(buscarCuenta("ahorros", [nueva]).kind, "one");
});

test("frases: cuenta creada (pantalla y voz)", () => {
  const f = fraseCuentaCreada({ account_name: "Interbank", account_type: "checking", currency_code: "PEN", current_balance: 500 });
  assert.equal(f.message, "Creé la cuenta «Interbank» (cuenta corriente en soles), con S/ 500.00.");
  assert.equal(f.voz, "Creé la cuenta Interbank en soles, con S/ 500.00.");
  const t = fraseCuentaCreada({ account_name: "Visa", account_type: "credit_card", currency_code: "USD", current_balance: 1200 });
  assert.match(t.voz, /tarjeta Visa en dólares, con deuda de US\$ 1,200\.00/);
  const sin = fraseCuentaCreada({ account_name: "Caja", account_type: "cash", currency_code: "PEN", current_balance: 0 });
  assert.equal(sin.voz, "Creé la cuenta Caja en soles.");
});

test("frases: la voz de «cuenta creada» siempre cabe en el tope, sin cortar un monto", async () => {
  const { paraVoz, prepararVoz, VOZ_MAX } = await import("./voz.ts");
  const nombre = "Cuenta de ahorros del banco internacional";
  const casos = [
    { account_name: nombre, account_type: "credit_card", currency_code: "USD", current_balance: 123456.78 },
    { account_name: nombre, account_type: "checking", currency_code: "PEN", current_balance: 987654.32 },
    { account_name: "BCP", account_type: "savings", currency_code: "PEN", current_balance: 500 },
  ] as const;
  for (const c of casos) {
    const f = fraseCuentaCreada({ ...c });
    const hablado = prepararVoz(f.voz);
    assert.equal(hablado, paraVoz(f.voz), "el tope no corta nada: lo que se dice es la frase entera");
    assert.ok(hablado.length <= VOZ_MAX, hablado);
    assert.match(hablado, /\.$/);
  }
  assert.match(fraseCuentaCreada({ ...casos[0] }).voz, /^Creé la tarjeta /);
  assert.equal(fraseCuentaCreada({ ...casos[2] }).voz, "Creé la cuenta BCP en soles, con S/ 500.00.");
});

test("frases: lista de cuentas con total por moneda; las tarjetas restan", () => {
  const f = fraseCuentas(CUENTAS);
  assert.match(f.message, /^Tienes 5 cuentas: BCP Soles: S\/ 1,200\.00; BCP Dólares: US\$ 300\.00;/);
  assert.match(f.message, /Visa Oro: debes S\/ 800\.00/);
  assert.match(f.message, /Total: S\/ 980\.00 y US\$ 300\.00\.$/); // 1200 + 500 + 80 − 800
  assert.equal(f.voz, "Tienes 5 cuentas; en total S/ 980.00 y US$ 300.00.");
  assert.ok(f.voz.length <= 60, "una frase corta, pensada para el tope de voz");
  assert.match(fraseCuentas([]).voz, /No tienes cuentas/);
  assert.match(fraseCuentas([cta("1", "Solo")]).message, /Tienes 1 cuenta:/);
});

test("frases: la voz de la lista redondea los totales para no pasar el tope (la pantalla lleva los céntimos)", async () => {
  const { prepararVoz, VOZ_MAX } = await import("./voz.ts");
  const grandes = [cta("1", "BCP", "checking", "PEN", 12345.67), cta("2", "Wise", "savings", "USD", 8765.43)];
  const f = fraseCuentas(grandes);
  assert.match(f.message, /Total: S\/ 12,345\.67 y US\$ 8,765\.43\.$/);
  // con el tope de 250 los dos totales grandes caben enteros y redondeados (antes, con 100, se decía solo el primero)
  assert.equal(f.voz, "Tienes 2 cuentas; en total S/ 12,346.00 y US$ 8,765.00.");
  const hablado = prepararVoz(f.voz);
  assert.equal(hablado, "Tienes 2 cuentas; en total doce mil trescientos cuarenta y seis soles y ocho mil setecientos sesenta y cinco dólares.");
  assert.ok(hablado.length <= VOZ_MAX);
  // con totales cortos caben los dos
  assert.equal(fraseCuentas([cta("1", "BCP", "checking", "PEN", 500), cta("2", "Wise", "savings", "USD", 20)]).voz, "Tienes 2 cuentas; en total S/ 500.00 y US$ 20.00.");
});

test("monto y opcionesHabladas", () => {
  assert.equal(monto(1780, "PEN"), "S/ 1,780.00");
  assert.equal(monto(20, "USD"), "US$ 20.00");
  assert.equal(monto(-5.5, "PEN"), "-S/ 5.50");
  assert.equal(opcionesHabladas(CUENTAS.slice(0, 2)), "BCP Soles o BCP Dólares");
  assert.equal(opcionesHabladas(CUENTAS.slice(0, 4)), "BCP Soles, BCP Dólares o Interbank");
});

test("frases: con tipo de cambio la lista da el total EN SOLES, los dólares convertidos, y la voz los menciona corto", async () => {
  const { prepararVoz, VOZ_MAX } = await import("./voz.ts");
  const tc = { valor: 3.5, fecha: "2026-10-07" };
  const f = fraseCuentas(CUENTAS, tc); // 1200 + 500 + 80 − 800 = 980 soles; 300 dólares → 1050 soles
  assert.match(f.message, /BCP Dólares: US\$ 300\.00 \(≈ S\/ 1,050\.00\)/);
  assert.match(f.message, /Visa Oro: debes S\/ 800\.00/);
  assert.match(f.message, /Total: S\/ 2,030\.00 \(incluye US\$ 300\.00 a TC 3\.5\)\.$/);
  assert.equal(f.voz, "Tienes 5 cuentas; en total S/ 2,030.00, incluye US$ 300.00.");
  assert.ok(prepararVoz(f.voz).length <= VOZ_MAX);
});

test("frases: si el total en soles + dólares no cabe en la voz, se dice solo el total en soles (nunca un monto cortado)", async () => {
  const { prepararVoz, VOZ_MAX } = await import("./voz.ts");
  const f = fraseCuentas([cta("1", "BCP", "checking", "PEN", 12345.67), cta("2", "Wise", "savings", "USD", 8765.43)], { valor: 3.45, fecha: "x" });
  assert.match(f.message, /Total: S\/ 42,586\.\d\d \(incluye US\$ 8,765\.43 a TC 3\.45\)\.$/);
  assert.match(f.voz, /^Tienes 2 cuentas; en total S\/ 42,586\.00\.$|^Tienes 2 cuentas; en total S\/ 42,586\.00, incluye US\$ 8,765\.00\.$/);
  assert.ok(prepararVoz(f.voz).length <= VOZ_MAX, prepararVoz(f.voz));
});

test("frases: una tarjeta en dólares resta su deuda convertida; sin dólares el tipo de cambio no cambia nada", () => {
  const tc = { valor: 3.5, fecha: "x" };
  const f = fraseCuentas([cta("1", "BCP", "checking", "PEN", 1000), cta("2", "Visa USD", "credit_card", "USD", 100)], tc);
  assert.match(f.message, /Visa USD: debes US\$ 100\.00 \(≈ S\/ 350\.00\)/);
  assert.match(f.message, /Total: S\/ 650\.00 \(incluye -US\$ 100\.00 a TC 3\.5\)\.$/);
  assert.equal(fraseCuentas(CUENTAS.filter((c) => c.currency_code === "PEN"), tc).voz, fraseCuentas(CUENTAS.filter((c) => c.currency_code === "PEN")).voz);
});

test("frases: dólares sin tipo de cambio → total por moneda como antes (jamás sumados como soles)", () => {
  assert.equal(fraseCuentas(CUENTAS, null).voz, fraseCuentas(CUENTAS).voz);
  assert.match(fraseCuentas(CUENTAS, null).message, /Total: S\/ 980\.00 y US\$ 300\.00\.$/);
});
