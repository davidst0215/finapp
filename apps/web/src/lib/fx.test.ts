// Corre con Node: `node --experimental-strip-types --test fx.test.ts`.
// @ts-ignore
import { test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import {
  aSoles,
  conversionDePatrimonio,
  conversionDeTotal,
  diaLima,
  equivalenteEnSoles,
  hayQueRefrescar,
  juntarTotales,
  leerTipoCambio,
  notaConversion,
  patrimonio,
  tasaDeFecha,
  textoRangoTc,
  textoTc,
  totalEnSoles,
  type TipoCambio,
} from './fx.ts';

const TC: TipoCambio = { valor: 3.5, fecha: '2026-10-07', fuente: 'BCRP · SBS venta', obtenido_en: '2026-10-11T15:00:00Z' };

test('aSoles: PEN no cambia, USD multiplica y redondea, lo demás es null', () => {
  assert.equal(aSoles(100, 'PEN', TC), 100);
  assert.equal(aSoles(100, undefined, TC), 100);
  assert.equal(aSoles(100, 'USD', { valor: 3.453 }), 345.3);
  assert.equal(aSoles(0.1, 'usd', { valor: 3.45 }), 0.35);
  assert.equal(aSoles(100, 'USD', null), null);
  assert.equal(aSoles(100, 'EUR', TC), null);
});

test('leerTipoCambio: acepta la fila de la tabla (valor como texto) y rechaza lo absurdo', () => {
  assert.deepEqual(leerTipoCambio({ valor: '3.453', fecha: '2026-10-07', fuente: 'x', obtenido_en: 'y' }), { valor: 3.453, fecha: '2026-10-07', fuente: 'x', obtenido_en: 'y' });
  assert.equal(leerTipoCambio({ valor: 0, fecha: '2026-10-07' }), null);
  assert.equal(leerTipoCambio({ valor: 3400, fecha: '2026-10-07' }), null);
  assert.equal(leerTipoCambio({ valor: 3.4 }), null);
  assert.equal(leerTipoCambio(null), null);
});

test('hayQueRefrescar: sin valor, vencido (>6 h) o ilegible sí; reciente no', () => {
  const ahora = new Date('2026-10-11T17:00:00Z');
  assert.equal(hayQueRefrescar(null, ahora), true);
  assert.equal(hayQueRefrescar({ ...TC, obtenido_en: '2026-10-11T12:30:00Z' }, ahora), false);
  assert.equal(hayQueRefrescar({ ...TC, obtenido_en: '2026-10-11T10:00:00Z' }, ahora), true);
  assert.equal(hayQueRefrescar({ ...TC, obtenido_en: '' }, ahora), true);
});

test('diaLima: un gasto a las 22:00 del 4 en Lima es del 4 aunque en UTC ya sea el 5', () => {
  assert.equal(diaLima('2026-10-05T03:00:00Z'), '2026-10-04');
  assert.equal(diaLima('2026-10-05T05:00:00Z'), '2026-10-05');
  assert.equal(diaLima(new Date('2026-10-05T04:59:00Z')), '2026-10-04');
});

test('tasaDeFecha: el último valor <= la fecha; antes del primero, el primero', () => {
  const h = [{ fecha: '2026-10-05', valor: 3.5 }, { fecha: '2026-10-01', valor: 3.4 }];
  assert.equal(tasaDeFecha(h, '2026-10-03'), 3.4);
  assert.equal(tasaDeFecha(h, '2026-10-09'), 3.5);
  assert.equal(tasaDeFecha(h, '2026-09-01'), 3.4);
  assert.equal(tasaDeFecha([], '2026-10-03'), null);
});

test('patrimonio: la tarjeta resta, los dólares se convierten y se informan aparte', () => {
  const p = patrimonio(
    [
      { account_type: 'checking', currency_code: 'PEN', current_balance: 1000 },
      { account_type: 'credit_card', currency_code: 'PEN', current_balance: 200 },
      { account_type: 'savings', currency_code: 'USD', current_balance: '500' },
      { account_type: 'credit_card', currency_code: 'USD', current_balance: 100 },
    ],
    TC,
  );
  assert.deepEqual(p, { soles: 2200, pen: 800, usd: 400, hayUsd: true, usdEnSoles: 1400, otrasMonedas: false });
});

test('patrimonio: con dólares y sin tipo de cambio NO los suma como soles', () => {
  const p = patrimonio([{ account_type: 'checking', currency_code: 'PEN', current_balance: 1000 }, { account_type: 'savings', currency_code: 'USD', current_balance: 500 }], null);
  assert.equal(p.soles, 1000);
  assert.equal(p.usdEnSoles, null);
  assert.equal(patrimonio([], null).soles, 0);
});

test('totalEnSoles: cada dólar con el tipo de SU día; el rango usado se informa', () => {
  const h = [{ fecha: '2026-10-01', valor: 3.4 }, { fecha: '2026-10-05', valor: 3.5 }];
  const t = totalEnSoles(
    [
      { monto: 100, moneda: 'PEN', fecha: '2026-10-10' },
      { monto: 10, moneda: 'USD', fecha: '2026-10-02' }, // 34
      { monto: 10, moneda: 'USD', fecha: '2026-10-06' }, // 35
    ],
    TC,
    h,
  );
  assert.deepEqual(t, { soles: 169, usd: 20, usdEnSoles: 69, usdSinConvertir: 0, tcMin: 3.4, tcMax: 3.5 });
});

test('totalEnSoles: sin historial usa el tipo vigente; sin ninguno, los dólares quedan fuera y se cuentan aparte', () => {
  const items = [{ monto: 100, moneda: 'PEN' }, { monto: 10, moneda: 'USD', fecha: '2026-10-02' }, { monto: 7, moneda: 'EUR' }];
  assert.deepEqual(totalEnSoles(items, TC), { soles: 135, usd: 10, usdEnSoles: 35, usdSinConvertir: 0, tcMin: 3.5, tcMax: 3.5 });
  assert.deepEqual(totalEnSoles(items, null), { soles: 100, usd: 0, usdEnSoles: 0, usdSinConvertir: 10, tcMin: null, tcMax: null });
  assert.deepEqual(totalEnSoles([], TC), { soles: 0, usd: 0, usdEnSoles: 0, usdSinConvertir: 0, tcMin: null, tcMax: null });
});

test('textoRangoTc: un valor, un rango, y la fecha cuando el valor es viejo', () => {
  assert.equal(textoRangoTc(3.45, 3.45), 'TC 3.45');
  assert.equal(textoRangoTc(3.435, 3.453), 'TC 3.435–3.453');
  assert.equal(textoRangoTc(3.45, 3.45, '2026-10-07', '2026-10-11'), 'TC 3.45', 'hasta 4 días no se avisa');
  assert.equal(textoRangoTc(3.45, 3.45, '2026-10-05', '2026-10-11'), 'TC 3.45 del 5 oct');
  assert.equal(textoTc(3.75), '3.75');
});

test('notaConversion: «Incluye US$ 500.00 ≈ S/ 1,750.00 (TC 3.5)»; sin tipo de cambio avisa que no se sumó; sin dólares, nada', () => {
  const p = patrimonio([{ account_type: 'savings', currency_code: 'USD', current_balance: 500 }], TC);
  assert.equal(notaConversion(conversionDePatrimonio(p, TC), '2026-10-11'), 'Incluye US$ 500.00 ≈ S/ 1,750.00 (TC 3.5)');
  const sin = patrimonio([{ account_type: 'savings', currency_code: 'USD', current_balance: 500 }], null);
  assert.equal(notaConversion(conversionDePatrimonio(sin, null), '2026-10-11'), 'US$ 500.00 sin sumar: falta el tipo de cambio');
  assert.equal(notaConversion(conversionDePatrimonio(patrimonio([], TC), TC), '2026-10-11'), null);
  // deuda neta en dólares
  const deuda = patrimonio([{ account_type: 'credit_card', currency_code: 'USD', current_balance: 100 }], TC);
  assert.equal(notaConversion(conversionDePatrimonio(deuda, TC), '2026-10-11'), 'Incluye −US$ 100.00 ≈ −S/ 350.00 (TC 3.5)');
  // un total de movimientos con rango de tipos
  const t = totalEnSoles([{ monto: 10, moneda: 'USD', fecha: '2026-10-02' }, { monto: 10, moneda: 'USD', fecha: '2026-10-06' }], TC, [{ fecha: '2026-10-01', valor: 3.4 }, { fecha: '2026-10-05', valor: 3.5 }]);
  assert.equal(notaConversion(conversionDeTotal(t, '2026-10-07'), '2026-10-11', 'Incluye'), 'Incluye US$ 20.00 ≈ S/ 69.00 (TC 3.4–3.5)');
  assert.equal(notaConversion(conversionDeTotal(totalEnSoles([{ monto: 10, moneda: 'USD' }], null)), '2026-10-11'), 'US$ 10.00 sin sumar: falta el tipo de cambio');
  // un tipo de cambio viejo lleva su fecha
  assert.match(notaConversion(conversionDePatrimonio(p, { ...TC, fecha: '2026-10-01' }), '2026-10-11') ?? '', /\(TC 3\.5 del 1 oct\)$/);
});

test('equivalenteEnSoles: solo para cuentas en dólares y con tipo de cambio', () => {
  assert.equal(equivalenteEnSoles(500, 'USD', TC, '2026-10-11'), '≈ S/ 1,750.00 (TC 3.5)');
  assert.equal(equivalenteEnSoles(500, 'PEN', TC, '2026-10-11'), null);
  assert.equal(equivalenteEnSoles(500, 'USD', null, '2026-10-11'), null);
  assert.equal(equivalenteEnSoles(-100, 'USD', TC, '2026-10-11'), '≈ S/ 350.00 (TC 3.5)');
});

test('juntarTotales: suma soles, dólares y el rango de tipos de cambio de ambos', () => {
  const a = totalEnSoles([{ monto: 10, moneda: 'USD', fecha: '2026-10-02' }], TC, [{ fecha: '2026-10-01', valor: 3.4 }]);
  const b = totalEnSoles([{ monto: 100, moneda: 'PEN' }, { monto: 10, moneda: 'USD', fecha: '2026-10-06' }], TC, [{ fecha: '2026-10-05', valor: 3.5 }]);
  assert.deepEqual(juntarTotales(a, b), { soles: 169, usd: 20, usdEnSoles: 69, usdSinConvertir: 0, tcMin: 3.4, tcMax: 3.5 });
  assert.equal(juntarTotales(totalEnSoles([], TC), totalEnSoles([], TC)).tcMin, null);
});
