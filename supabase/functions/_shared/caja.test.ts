import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bolsaDe, type Bolsa, type EntradaCaja, estadoBolsas, fraseCuantoPuedo, fraseRestante, periodoDe, type Programado, proyectar, siguienteFecha } from "./caja.ts";

// Los datos de David al 24-oct-2026 (Documents/Wabid/cierre-2026-v5.json): caja real S/ 470, Melissa el 1-nov, Hugo en tres partes.
const mes = (id: string, concepto: string, monto: number, dia: number, proxima: string, tipo: "income" | "expense" = "expense"): Programado =>
  ({ id, concepto, tipo, monto, frecuencia: "monthly", dia, proxima, fin: null });
const una = (id: string, concepto: string, monto: number, fecha: string, tipo: "income" | "expense" = "expense"): Programado =>
  ({ id, concepto, tipo, monto, frecuencia: "once", dia: null, proxima: fecha, fin: null });
const PROGRAMADOS: Programado[] = [
  mes("tel", "Teléfono", 50, 22, "2026-10-22"), // vencido: la prueba de punta a punta
  mes("agua", "Agua", 50, 25, "2026-10-25"),
  mes("spotify", "Spotify", 27, 26, "2026-10-26"),
  mes("internet", "Internet", 120, 28, "2026-10-28"),
  mes("microsoft", "Microsoft", 9.4, 30, "2026-10-30"),
  mes("disney", "Disney Plus", 8.5, 30, "2026-11-30"), // octubre ya pagado
  mes("netflix", "Netflix", 59, 4, "2026-11-04"),
  mes("eleven", "ElevenLabs", 21, 11, "2026-11-11"),
  mes("subvencion", "Subvención", 400, 31, "2026-10-31"),
  mes("estac", "Estacionamiento", 150, 1, "2026-11-01"),
  mes("loki", "Gastos Loki", 500, 1, "2026-11-01"),
  mes("banco", "Deuda banco", 920, 2, "2026-11-02"),
  una("melissa", "Deuda Melissa", 1000, "2026-11-01"),
  una("hugo1", "Deuda Hugo (1/3)", 1016, "2026-11-01"),
  una("hugo2", "Deuda Hugo (2/3)", 1150, "2026-11-15"),
  una("hugo3", "Deuda Hugo (3/3)", 300, "2026-11-30"),
  una("yape", "Deuda Yape", 364, "2026-11-02"),
  una("interbank", "Deuda Interbank", 400, "2026-11-15"),
  mes("sueldo", "Sueldo", 3830, 31, "2026-10-31", "income"),
  una("bono", "Bono", 1500, "2026-10-31", "income"),
  una("cts", "CTS", 2625, "2026-11-15", "income"),
  una("grati", "Gratificación", 4905, "2026-12-15", "income"),
  una("cobro-nov", "Pago por cobrar (nov)", 1000, "2026-11-30", "income"),
  una("cobro-dic", "Pago por cobrar (dic)", 1500, "2026-12-31", "income"),
];
const BOLSAS: Bolsa[] = [
  { nombre: "Comida", topeSemanal: 200, categorias: ["Alimentación"], arrastre: false },
  { nombre: "Compras y otros", topeSemanal: 100, categorias: null, arrastre: false, cambio: { desde: "2026-11-16", tope: 70 } },
  { nombre: "Gasolina", topeSemanal: 81, categorias: ["Transporte"], arrastre: true },
];
const PLAN = { inicio: "2026-10-24", metaMonto: 10500, metaFecha: "2026-12-31", colchon: 0 };
const david = (cambios: Partial<EntradaCaja> = {}): EntradaCaja =>
  ({ hoy: "2026-10-24", caja: 470, programados: PROGRAMADOS, bolsas: BOLSAS, gastos: [], plan: PLAN, ...cambios });

describe("siguienteFecha", () => {
  it("fin de mes no salta un mes (Date#setMonth sí: 31-oct → 1-dic)", () => {
    assert.equal(siguienteFecha("2026-10-31", "monthly", 31), "2026-11-30");
    assert.equal(siguienteFecha("2026-11-30", "monthly", 31), "2026-12-31");
    assert.equal(siguienteFecha("2027-01-31", "monthly", 31), "2027-02-28");
    assert.equal(siguienteFecha("2026-12-15", "monthly", 15), "2027-01-15");
  });
  it("sin día guardado usa el de la fecha; semanales, trimestrales y 'once'", () => {
    assert.equal(siguienteFecha("2026-10-22", "monthly"), "2026-11-22");
    assert.equal(siguienteFecha("2026-10-24", "weekly"), "2026-10-31");
    assert.equal(siguienteFecha("2026-11-30", "quarterly", 30), "2027-02-28");
    assert.equal(siguienteFecha("2026-11-01", "once"), "2026-11-01");
  });
});

describe("periodoDe: la semana de las bolsas", () => {
  it("el plan arrancó un sábado: el 24 y 25-oct cuentan en la semana del 26 al 1-nov", () => {
    assert.deepEqual(periodoDe("2026-10-24", "2026-10-24"), { desde: "2026-10-24", hasta: "2026-11-01" });
    assert.deepEqual(periodoDe("2026-10-29", "2026-10-24"), { desde: "2026-10-24", hasta: "2026-11-01" });
    assert.deepEqual(periodoDe("2026-11-02", "2026-10-24"), { desde: "2026-11-02", hasta: "2026-11-08" });
  });
  it("sin plan, o con un plan que arrancó un miércoles: de lunes (o del inicio) a domingo", () => {
    assert.deepEqual(periodoDe("2026-10-24", null), { desde: "2026-10-19", hasta: "2026-10-25" });
    assert.deepEqual(periodoDe("2026-11-06", "2026-11-04"), { desde: "2026-11-04", hasta: "2026-11-08" });
  });
});

describe("bolsas", () => {
  it("cada gasto a su bolsa; lo que no tiene bolsa propia (o no tiene categoría) va al resto", () => {
    assert.equal(bolsaDe("Alimentación", BOLSAS)!.nombre, "Comida");
    assert.equal(bolsaDe("transporte", BOLSAS)!.nombre, "Gasolina");
    assert.equal(bolsaDe("Regalos", BOLSAS)!.nombre, "Compras y otros");
    assert.equal(bolsaDe(null, BOLSAS)!.nombre, "Compras y otros");
    assert.equal(bolsaDe("Ropa", [BOLSAS[0]!]), null, "sin bolsa resto, no se descuenta de ninguna");
  });
  it("descuenta lo gastado desde el inicio del periodo; un pago programado (subvención) no toca la bolsa", () => {
    const e = david({
      gastos: [
        { fecha: "2026-10-24", monto: 17, categoria: "Alimentación", programado: false },
        { fecha: "2026-10-25", monto: 2.9, categoria: null, programado: false },
        { fecha: "2026-10-22", monto: 30, categoria: "Alimentación", programado: false }, // antes del plan: no cuenta
        { fecha: "2026-10-24", monto: 400, categoria: "Alimentación", programado: true },
      ],
      hoy: "2026-10-25",
    });
    const [comida, compras, gasolina] = estadoBolsas(e);
    assert.deepEqual(comida, { nombre: "Comida", tope: 20000, gastado: 1700, queda: 18300 });
    assert.equal(compras!.queda, 10000 - 290);
    assert.equal(gasolina!.queda, 8100);
  });
  it("gasolina con arrastre: lo que no cargaste una semana se suma a la siguiente", () => {
    const e = david({ hoy: "2026-11-10", gastos: [{ fecha: "2026-11-03", monto: 60, categoria: "Transporte", programado: false }] });
    const gasolina = estadoBolsas(e)[2]!;
    assert.equal(gasolina.queda, 3 * 8100 - 6000, "tres semanas desde el inicio (24-oct, 2-nov y 9-nov) menos lo cargado");
    assert.equal(gasolina.gastado, 0, "esta semana todavía no carga");
  });
  it("el tope nuevo rige desde su fecha: compras 100 hasta el 15-nov, 70 desde el 16", () => {
    assert.equal(estadoBolsas(david({ hoy: "2026-11-15" }))[1]!.tope, 10000);
    assert.equal(estadoBolsas(david({ hoy: "2026-11-16" }))[1]!.tope, 7000);
  });
});

describe("proyectar con los datos de David (24-oct)", () => {
  const p = proyectar(david());
  it("paridad con el prototipo HTML: sin gasto variable, las mismas cifras día por día", () => {
    const sin = (f: string) => p.serie.find((x) => x.fecha === f)!.sinVariables;
    assert.equal(sin("2026-10-30"), 21360, "S/ 213.60 antes del sueldo");
    assert.equal(sin("2026-11-14"), 111360);
    assert.equal(sin("2026-11-29"), 194160);
    assert.equal(sin("2026-12-31"), 1397380, "S/ 13,973.80 al 31-dic");
    assert.deepEqual(p.errores, []);
  });
  it("lo vencido cuenta hoy: el teléfono del 22-oct entra el 24", () => {
    const tel = p.eventos.find((ev) => ev.id === "tel")!;
    assert.equal(tel.efectiva, "2026-10-24");
    assert.equal(tel.vencido, true);
  });
  it("el sueldo de fin de mes cae el 30-nov y el 31-dic (no salta a diciembre)", () => {
    assert.deepEqual(p.eventos.filter((ev) => ev.id === "sueldo").map((ev) => ev.fecha), ["2026-10-31", "2026-11-30", "2026-12-31"]);
  });
  it("antes del sueldo del 31 solo hay S/ 213.60; el próximo ingreso es el del 31-oct", () => {
    assert.equal(p.proximoIngreso!.efectiva, "2026-10-31");
    assert.equal(p.disponibleHastaIngreso, 21360);
  });
  it("con las tres bolsas y compras a 70 desde el 16-nov, se cumple la meta de S/ 10,500", () => {
    assert.ok(p.meta && p.meta.holgura >= 0, `cierre ${p.meta?.cierre}`);
    // 3 semanas a S/ 381 (24-oct al 15-nov), 6 a S/ 351 (compras a 70) y del 28 al 31-dic 4 días repartidos por bolsa:
    // comida 2858 + 3×2857, compras 4×1000, gasolina 1158 + 3×1157 = 20058 céntimos.
    assert.equal(p.meta!.cierre, 1397380 - (3 * 38100 + 6 * 35100 + 20058), "13,973.80 menos lo reservado en bolsas");
  });
  it("gastando parejo la semana del 24, la caja queda corta antes del sueldo: el aviso lo dice primero", () => {
    assert.equal(p.faltante!.fecha, "2026-10-29");
    const f = fraseCuantoPuedo(p, "2026-10-24");
    assert.equal(f.message, "Hasta el domingo primero de noviembre te quedan S/ 381: comida S/ 200, compras y otros S/ 100 y gasolina S/ 81. " +
      "Ojo: hasta el 30 de octubre solo hay S/ 214 para todo; el resto, desde el 31 de octubre.");
    assert.ok(f.voz.startsWith("Hasta el domingo primero de noviembre te quedan: comida S/ 200"), f.voz);
    assert.ok(f.voz.includes("solo hay S/ 214 para todo"), f.voz);
  });
  it("el libre no rompe nada: gastarlo hoy deja la caja y la meta en su límite, no por debajo", () => {
    const sinFalta = proyectar(david({ caja: 470 + 200 })); // con S/ 200 más hoy, la semana del sueldo ya no queda corta
    assert.equal(sinFalta.faltante, null);
    assert.ok(sinFalta.libre > 0);
    const gastado = proyectar(david({ caja: 470 + 200 - sinFalta.libre / 100 }));
    assert.ok(gastado.minimo.saldo >= 0 && gastado.meta!.holgura >= 0);
    assert.equal(gastado.libre, 0);
  });
});

describe("frases", () => {
  it("después de anotar un gasto, lo que queda de su bolsa", () => {
    const p = periodoDe("2026-10-24", "2026-10-24");
    assert.equal(fraseRestante({ nombre: "Comida", tope: 20000, gastado: 1700, queda: 18300 }, p, "2026-10-24"), "Te quedan S/ 183 de comida hasta el domingo primero de noviembre.");
    assert.equal(fraseRestante({ nombre: "Comida", tope: 20000, gastado: 22000, queda: -2000 }, p, "2026-10-30"), "Te pasaste S/ 20 de comida esta semana.");
    assert.equal(fraseRestante({ nombre: "Comida", tope: 20000, gastado: 0, queda: 20000 }, periodoDe("2026-11-03", "2026-10-24"), "2026-11-03"), "Te quedan S/ 200 de comida hasta el domingo.");
  });
  it("sin bolsas: invita a crear un tope", () => {
    const f = fraseCuantoPuedo(proyectar(david({ bolsas: [] })), "2026-10-24");
    assert.ok(f.voz.startsWith("Aún no tienes topes semanales"), f.voz);
  });
});
