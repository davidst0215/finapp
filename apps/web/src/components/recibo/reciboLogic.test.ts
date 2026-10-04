// Corre con Node, no con el bundle de la app: `node --experimental-strip-types --test reciboLogic.test.ts`.
// El tsconfig de la web no trae los tipos de Node, así que solo los dos imports de node:* se silencian
// con @ts-ignore (sigue siendo inocuo si algún día se agregan); el resto se revisa con tipos estrictos.
// @ts-ignore
import { describe, test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import type { FormErrors, ReceiptFormValues } from './reciboLogic.ts';
import {
  MAX_AMOUNT_CENTS,
  buildFormValues,
  centsToInputText,
  coerceAmountCents,
  dateToTimestamp,
  describeDate,
  describeFailure,
  findOthersCategoryId,
  fitWithin,
  formatMoney,
  isValidIsoDate,
  limaToday,
  needsDoubleCheck,
  normalizeReceiptDate,
  parseAmountToCents,
  parseReading,
  pickAccountId,
  readingMessage,
  resolveCategoryId,
  savedMatchesSubmission,
  validateForm,
} from './reciboLogic.ts';

describe('fitWithin (reducción de la foto)', () => {
  test('horizontal grande: el lado mayor queda en 1600', () => {
    assert.deepEqual(fitWithin(4000, 3000), { width: 1600, height: 1200 });
  });
  test('vertical grande: conserva la proporción', () => {
    assert.deepEqual(fitWithin(3000, 4000), { width: 1200, height: 1600 });
  });
  test('cuadrada', () => {
    assert.deepEqual(fitWithin(5000, 5000), { width: 1600, height: 1600 });
  });
  test('nunca amplía una foto chica', () => {
    assert.deepEqual(fitWithin(1000, 800), { width: 1000, height: 800 });
    assert.deepEqual(fitWithin(1600, 1600), { width: 1600, height: 1600 });
  });
  test('redondea a enteros', () => {
    const out = fitWithin(4032, 3024); // cámara típica de celular
    assert.deepEqual(out, { width: 1600, height: 1200 });
    const odd = fitWithin(3001, 2001)!;
    assert.ok(Number.isInteger(odd.width) && Number.isInteger(odd.height));
    assert.equal(odd.width, 1600);
  });
  test('panorama extremo no deja un lado en 0', () => {
    assert.deepEqual(fitWithin(40000, 10), { width: 1600, height: 1 });
  });
  test('lado mayor configurable', () => {
    assert.deepEqual(fitWithin(2000, 1000, 1000), { width: 1000, height: 500 });
  });
  test('medidas inválidas -> null', () => {
    const invalid: [number, number][] = [[0, 100], [100, 0], [-5, 100], [Number.NaN, 100], [100, Infinity]];
    for (const [w, h] of invalid) {
      assert.equal(fitWithin(w, h), null, `${w}x${h}`);
    }
    assert.equal(fitWithin(100, 100, 0), null);
  });
});

describe('parseAmountToCents (monto a 2 decimales)', () => {
  const ok = {
    '86.40': 8640,
    '86,40': 8640,
    '86.4': 8640,
    '86,4': 8640,
    '86': 8600,
    '0.05': 5,
    '.5': 50,
    ',5': 50,
    '86.': 8600,
    'S/ 86.40': 8640,
    'S/86.40': 8640,
    'S/. 86.40': 8640,
    's/ 86,40': 8640,
    '$ 12.00': 1200,
    'US$ 12.00': 1200,
    'USD 12.5': 1250,
    '12.50 soles': 1250,
    '1,234.50': 123450,
    '1.234,50': 123450,
    '1 234,50': 123450,
    '1,234': 123400,
    '12,345': 1234500,
    '86,405': 8640500, // coma + 3 cifras = miles, igual que '1,234'
    '1,234,567': 123456700,
    '1.234.567': 123456700,
    '1,234,567.89': 123456789,
    '0.00': 0,
    '  86.40  ': 8640,
    '00086.40': 8640,
  };
  for (const [text, cents] of Object.entries(ok)) {
    test(`"${text}" -> ${cents}`, () => assert.equal(parseAmountToCents(text), cents));
  }

  const bad = [
    '', ' ', 'abc', 'S/', '.', ',', '-5', '+5', '1e3', '86.405', '1.234', '12.3456',
    '1,23.45', '86.40.50', '1,234,56', '0,123', '1234,567', '12 34 abc', '８６', '86..40',
  ];
  for (const text of bad) {
    test(`rechaza "${text}"`, () => assert.equal(parseAmountToCents(text), null));
  }

  test('no texto -> null', () => {
    for (const v of [null, undefined, 86.4, {}, []]) assert.equal(parseAmountToCents(v), null);
  });
  test('es exacto al centavo (sin errores de coma flotante)', () => {
    assert.equal(parseAmountToCents('0.07'), 7);
    assert.equal(parseAmountToCents('1.10'), 110);
    assert.equal(parseAmountToCents('4.35'), 435);
    assert.equal(parseAmountToCents('19.99'), 1999);
    assert.equal(parseAmountToCents('999999999999.99'), 99999999999999);
  });
  test('más de 12 cifras enteras -> null', () => {
    assert.equal(parseAmountToCents('1234567890123.00'), null);
  });
});

describe('coerceAmountCents (lo que devuelve el modelo)', () => {
  test('números', () => {
    assert.equal(coerceAmountCents(86.4), 8640);
    assert.equal(coerceAmountCents(86), 8600);
    assert.equal(coerceAmountCents(0.07), 7);
    assert.equal(coerceAmountCents(1234.5), 123450);
    assert.equal(coerceAmountCents(86.39999999999999), 8640); // ruido de coma flotante
  });
  test('texto', () => {
    assert.equal(coerceAmountCents('86.40'), 8640);
    assert.equal(coerceAmountCents('86,40'), 8640);
    assert.equal(coerceAmountCents('S/ 1,234.50'), 123450);
  });
  test('salida del modelo ambigua -> null (lectura dudosa)', () => {
    assert.equal(coerceAmountCents(86.405), null); // no se redondea en silencio
    assert.equal(coerceAmountCents(0.005), null);
    assert.equal(coerceAmountCents('86,405'), null);
    assert.equal(coerceAmountCents('12,500'), null);
    assert.equal(coerceAmountCents('1,234.50'), 123450);
    assert.equal(parseAmountToCents('86,405'), 8640500); // lo que escribe David sigue siendo miles
    assert.equal(parseAmountToCents('86,405', { strict: true }), null);
  });
  test('inválidos -> null', () => {
    for (const v of [0, -1, '0', '0.00', Number.NaN, Infinity, null, undefined, 'abc', {}, [], true]) {
      assert.equal(coerceAmountCents(v), null, String(v));
    }
  });
  test('tope de cordura: un RUC o un DNI leído como total no pasa', () => {
    assert.equal(coerceAmountCents(20123456789), null); // RUC
    assert.equal(coerceAmountCents(12345678), null); // DNI
    assert.equal(coerceAmountCents(9999999.99), MAX_AMOUNT_CENTS);
    assert.equal(coerceAmountCents(10000000), null);
  });
});

describe('formato de montos', () => {
  test('formatMoney', () => {
    assert.equal(formatMoney(8640), 'S/ 86.40');
    assert.equal(formatMoney(8640, 'PEN'), 'S/ 86.40');
    assert.equal(formatMoney(4590), 'S/ 45.90');
    assert.equal(formatMoney(123450), 'S/ 1,234.50');
    assert.equal(formatMoney(5), 'S/ 0.05');
    assert.equal(formatMoney(0), 'S/ 0.00');
    assert.equal(formatMoney(100000000), 'S/ 1,000,000.00');
    assert.equal(formatMoney(1200, 'USD'), 'US$ 12.00');
    assert.equal(formatMoney(-8640), '-S/ 86.40');
  });
  test('centsToInputText', () => {
    assert.equal(centsToInputText(8640), '86.40');
    assert.equal(centsToInputText(5), '0.05');
    assert.equal(centsToInputText(123450), '1234.50');
    assert.equal(centsToInputText(100), '1.00');
  });
  test('ida y vuelta: texto -> centavos -> texto no pierde nada', () => {
    for (const cents of [1, 5, 99, 100, 101, 8640, 123450, 999999999]) {
      assert.equal(parseAmountToCents(centsToInputText(cents)), cents);
      assert.equal(parseAmountToCents(formatMoney(cents)), cents);
    }
  });
});

describe('fechas', () => {
  test('limaToday usa America/Lima (UTC-5) aunque el reloj esté en UTC', () => {
    assert.equal(limaToday(Date.UTC(2026, 9, 5, 2, 0)), '2026-10-04'); // 21:00 del 4 en Lima
    assert.equal(limaToday(Date.UTC(2026, 9, 5, 4, 59, 59)), '2026-10-04');
    assert.equal(limaToday(Date.UTC(2026, 9, 5, 5, 0)), '2026-10-05'); // medianoche en Lima
    assert.equal(limaToday(Date.UTC(2026, 11, 31, 23, 0)), '2026-12-31');
    assert.equal(limaToday(Date.UTC(2027, 0, 1, 3, 0)), '2026-12-31');
  });
  test('isValidIsoDate', () => {
    assert.equal(isValidIsoDate('2026-10-04'), true);
    assert.equal(isValidIsoDate('2028-02-29'), true); // bisiesto
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '2026-1-4', '26-10-04', '', 'hoy', '0026-10-04']) {
      assert.equal(isValidIsoDate(bad), false, bad);
    }
    assert.equal(isValidIsoDate('2027-02-29'), false);
  });
  test('normalizeReceiptDate acepta ISO y formatos peruanos (día primero)', () => {
    assert.equal(normalizeReceiptDate('2026-10-04'), '2026-10-04');
    assert.equal(normalizeReceiptDate('2026-10-04T12:58:00'), '2026-10-04');
    assert.equal(normalizeReceiptDate('2026-10-04 12:58'), '2026-10-04');
    assert.equal(normalizeReceiptDate('2026/10/04'), '2026-10-04');
    assert.equal(normalizeReceiptDate('04/10/2026'), '2026-10-04');
    assert.equal(normalizeReceiptDate('4/10/2026'), '2026-10-04');
    assert.equal(normalizeReceiptDate('04-10-2026'), '2026-10-04');
    assert.equal(normalizeReceiptDate('04.10.2026'), '2026-10-04');
    assert.equal(normalizeReceiptDate('04/10/26'), '2026-10-04');
    assert.equal(normalizeReceiptDate('  05/10/2026 12:58 '), '2026-10-05');
  });
  test('normalizeReceiptDate rechaza lo que no es fecha', () => {
    for (const bad of ['', 'ayer', '31/02/2026', '2026-02-30', '13/13/2026', '2026-10', '4/10', null, undefined, 20261004, {}]) {
      assert.equal(normalizeReceiptDate(bad), null, String(bad));
    }
  });
  test('describeDate: la fecha en palabras', () => {
    assert.equal(describeDate('2026-10-04', '2026-10-04'), 'hoy · dom 4 oct');
    assert.equal(describeDate('2026-10-03', '2026-10-04'), 'ayer · sáb 3 oct');
    assert.equal(describeDate('2026-10-01', '2026-10-04'), 'jue 1 oct');
    assert.equal(describeDate('2025-12-31', '2026-01-01'), 'ayer · mié 31 dic');
    assert.equal(describeDate('2025-03-15', '2026-10-04'), 'sáb 15 mar 2025');
    assert.equal(describeDate('2028-02-29', '2028-03-01'), 'ayer · mar 29 feb');
    assert.equal(describeDate('', '2026-10-04'), '');
    assert.equal(describeDate('2026-02-30', '2026-10-04'), '');
  });
  test('dateToTimestamp: hoy conserva la hora real', () => {
    const now = Date.UTC(2026, 9, 5, 2, 30, 15); // 21:30 del 4 de octubre en Lima
    assert.equal(dateToTimestamp('2026-10-04', now), new Date(now).toISOString());
  });
  test('dateToTimestamp: otro día queda a las 12:00 de Lima (17:00 UTC) y no se corre de día', () => {
    const now = Date.UTC(2026, 9, 5, 2, 30, 15);
    assert.equal(dateToTimestamp('2026-10-03', now), '2026-10-03T17:00:00.000Z');
    assert.equal(dateToTimestamp('2026-09-30', now), '2026-09-30T17:00:00.000Z');
    const stored = new Date(dateToTimestamp('2026-10-03', now));
    // visto desde Lima sigue siendo el 3
    assert.equal(limaToday(stored.getTime()), '2026-10-03');
  });
});

describe('parseReading (respuesta de parse-receipt)', () => {
  const today = '2026-10-05';
  const typical = {
    amount: 86.4,
    transaction_type: 'expense',
    description: '  Tottus   Jockey Plaza ',
    category_id: 'cat-ali',
    category_name: 'Alimentación',
    currency_code: 'PEN',
    date: '2026-10-05',
    confidence: 0.93,
    items_detected: 9,
  };

  test('respuesta típica', () => {
    assert.deepEqual(parseReading(typical, today), {
      amountCents: 8640,
      currency: 'PEN',
      description: 'Tottus Jockey Plaza',
      categoryId: 'cat-ali',
      categoryName: 'Alimentación',
      date: '2026-10-05',
      confidence: 0.93,
      itemsDetected: 9,
    });
  });
  test('monto como texto, USD y fecha peruana', () => {
    const r = parseReading({ ...typical, amount: 'S/ 1,234.50', currency_code: 'usd', date: '03/10/2026' }, today);
    assert.equal(r.amountCents, 123450);
    assert.equal(r.currency, 'USD');
    assert.equal(r.date, '2026-10-03');
  });
  test('fecha futura o ilegible -> null (se usará hoy)', () => {
    assert.equal(parseReading({ ...typical, date: '2026-10-06' }, today).date, null);
    assert.equal(parseReading({ ...typical, date: '2062-10-05' }, today).date, null);
    assert.equal(parseReading({ ...typical, date: null }, today).date, null);
    assert.equal(parseReading({ ...typical, date: 'ayer' }, today).date, null);
  });
  test('moneda desconocida cae a soles', () => {
    assert.equal(parseReading({ ...typical, currency_code: 'EUR' }, today).currency, 'PEN');
    assert.equal(parseReading({ ...typical, currency_code: undefined }, today).currency, 'PEN');
  });
  test('confianza: porcentaje se normaliza y lo absurdo se descarta', () => {
    assert.equal(parseReading({ ...typical, confidence: 92 }, today).confidence, 0.92);
    assert.equal(parseReading({ ...typical, confidence: 1 }, today).confidence, 1);
    assert.equal(parseReading({ ...typical, confidence: 0 }, today).confidence, 0);
    assert.equal(parseReading({ ...typical, confidence: 500 }, today).confidence, null);
    assert.equal(parseReading({ ...typical, confidence: -1 }, today).confidence, null);
    assert.equal(parseReading({ ...typical, confidence: 'alta' }, today).confidence, null);
  });
  test('ítems: solo enteros no negativos', () => {
    assert.equal(parseReading({ ...typical, items_detected: '9' }, today).itemsDetected, 9);
    assert.equal(parseReading({ ...typical, items_detected: 2.5 }, today).itemsDetected, null);
    assert.equal(parseReading({ ...typical, items_detected: -1 }, today).itemsDetected, null);
  });
  test('descripción larga se recorta a 120', () => {
    assert.equal(parseReading({ ...typical, description: 'x'.repeat(300) }, today).description.length, 120);
  });
  test('basura no lanza', () => {
    for (const junk of [null, undefined, 'hola', 42, [], {}]) {
      const r = parseReading(junk, today);
      assert.equal(r.amountCents, null);
      assert.equal(r.currency, 'PEN');
      assert.equal(r.description, '');
      assert.equal(r.date, null);
    }
  });
  test('needsDoubleCheck', () => {
    assert.equal(needsDoubleCheck(parseReading({ ...typical, confidence: 0.5 }, today)), true);
    assert.equal(needsDoubleCheck(parseReading({ ...typical, confidence: 0.7 }, today)), false);
    assert.equal(needsDoubleCheck(parseReading({ ...typical, confidence: 0.93 }, today)), false);
    assert.equal(needsDoubleCheck(parseReading({ ...typical, confidence: null }, today)), false);
  });
});

describe('categorías y cuentas', () => {
  const categories = [
    { category_id: 'c1', category_name: 'Alimentación', category_type: 'expense' },
    { category_id: 'c2', category_name: 'Otros gastos', category_type: 'expense' },
    { category_id: 'c3', category_name: 'Sueldo', category_type: 'income' },
    { category_id: 'c4', category_name: 'Transporte', category_type: 'expense' },
  ];
  test('resolveCategoryId por id, por nombre sin tildes y solo gastos', () => {
    assert.equal(resolveCategoryId(categories, { id: 'c4' }), 'c4');
    assert.equal(resolveCategoryId(categories, { id: 'nope', name: 'alimentacion' }), 'c1');
    assert.equal(resolveCategoryId(categories, { name: ' ALIMENTACIÓN ' }), 'c1');
    assert.equal(resolveCategoryId(categories, { id: 'c3' }), null); // ingreso: no vale para un gasto
    assert.equal(resolveCategoryId(categories, { name: 'Sueldo' }), null);
    assert.equal(resolveCategoryId(categories, {}), null);
    assert.equal(resolveCategoryId([], { name: 'Alimentación' }), null);
  });
  test('findOthersCategoryId', () => {
    assert.equal(findOthersCategoryId(categories), 'c2');
    assert.equal(findOthersCategoryId([]), null);
  });

  const accounts = [
    { account_id: 'a1', account_name: 'BCP Débito', currency_code: 'PEN' },
    { account_id: 'a2', account_name: 'Efectivo', currency_code: 'PEN' },
    { account_id: 'a3', account_name: 'Dólares', currency_code: 'USD' },
  ];
  test('pickAccountId', () => {
    assert.equal(pickAccountId(accounts, 'PEN'), 'a1');
    assert.equal(pickAccountId(accounts, 'PEN', 'a2'), 'a2'); // la última usada, misma moneda
    assert.equal(pickAccountId(accounts, 'USD', 'a2'), 'a3'); // la moneda manda sobre la preferida
    const soloSoles = accounts.slice(0, 2);
    assert.equal(pickAccountId(soloSoles, 'USD', 'a2'), 'a2'); // sin cuenta en USD: la preferida
    assert.equal(pickAccountId(soloSoles, 'USD'), 'a1');
    assert.equal(pickAccountId(accounts, 'PEN', 'ya-no-existe'), 'a1');
    assert.equal(pickAccountId([], 'PEN', 'a1'), '');
  });
});

describe('formulario', () => {
  const categories = [
    { category_id: 'c1', category_name: 'Alimentación', category_type: 'expense' },
    { category_id: 'c2', category_name: 'Otros gastos', category_type: 'expense' },
  ];
  const accounts = [{ account_id: 'a1', account_name: 'BCP', currency_code: 'PEN' }];
  const ctx = { today: '2026-10-05', categories, accounts };

  test('buildFormValues desde una lectura', () => {
    const reading = parseReading(
      { amount: 86.4, description: 'Tottus', category_name: 'Alimentacion', currency_code: 'PEN', date: '2026-10-04' },
      ctx.today,
    );
    assert.deepEqual(buildFormValues(reading, ctx), {
      description: 'Tottus',
      amountText: '86.40',
      currency: 'PEN',
      date: '2026-10-04',
      categoryId: 'c1',
      accountId: 'a1',
    });
  });
  test('sin fecha usa hoy y sin categoría cae a "Otros gastos"', () => {
    const reading = parseReading({ amount: 10, description: 'Kiosco' }, ctx.today);
    const v = buildFormValues(reading, ctx);
    assert.equal(v.date, '2026-10-05');
    assert.equal(v.categoryId, 'c2');
  });
  test('entrada a mano: monto vacío y sin categoría elegida por Wabid', () => {
    const v = buildFormValues(null, ctx);
    assert.equal(v.amountText, '');
    assert.equal(v.categoryId, '');
    assert.equal(v.date, '2026-10-05');
    assert.equal(v.accountId, 'a1');
  });

  const valid: ReceiptFormValues = {
    description: '  Tottus  ',
    amountText: '86,40',
    currency: 'PEN',
    date: '2026-10-04',
    categoryId: 'c1',
    accountId: 'a1',
  };
  const vctx = {
    today: '2026-10-05',
    accounts: [
      { account_id: 'a1', currency_code: 'PEN' },
      { account_id: 'a3', currency_code: 'USD' },
    ],
  };
  // validateForm devuelve una unión: estos ayudantes la afirman y la estrechan.
  const errorsOf = (r: ReturnType<typeof validateForm>): FormErrors => {
    assert.equal(r.ok, false);
    return r.ok ? {} : r.errors;
  };

  test('validateForm: ok normaliza todo', () => {
    assert.deepEqual(validateForm(valid, vctx), {
      ok: true,
      value: { description: 'Tottus', amountCents: 8640, currency: 'PEN', date: '2026-10-04', categoryId: 'c1', accountId: 'a1' },
    });
  });
  test('validateForm: descripción vacía -> "Boleta"; categoría vacía -> null', () => {
    const r = validateForm({ ...valid, description: '   ', categoryId: '' }, vctx);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.description, 'Boleta');
    assert.equal(r.value.categoryId, null);
  });
  test('validateForm: monto', () => {
    for (const amountText of ['', 'abc', '86.405', '1.234']) {
      const errors = errorsOf(validateForm({ ...valid, amountText }, vctx));
      assert.ok(errors.amount, amountText);
    }
    assert.match(errorsOf(validateForm({ ...valid, amountText: '0' }, vctx)).amount ?? '', /mayor a cero/);
    assert.match(errorsOf(validateForm({ ...valid, amountText: '99999999' }, vctx)).amount ?? '', /demasiado alto/);
    assert.equal(validateForm({ ...valid, amountText: '9999999.99' }, vctx).ok, true);
  });
  test('validateForm: fecha', () => {
    assert.ok(errorsOf(validateForm({ ...valid, date: '' }, vctx)).date);
    assert.ok(errorsOf(validateForm({ ...valid, date: '2026-02-30' }, vctx)).date);
    assert.match(errorsOf(validateForm({ ...valid, date: '2026-10-06' }, vctx)).date ?? '', /futura/);
    assert.equal(validateForm({ ...valid, date: '2026-10-05' }, vctx).ok, true); // hoy vale
  });
  test('validateForm: cuenta', () => {
    assert.ok(errorsOf(validateForm({ ...valid, accountId: '' }, vctx)).account);
    assert.ok(errorsOf(validateForm({ ...valid, accountId: 'otra' }, vctx)).account);
  });
  test('validateForm: la moneda debe coincidir con la de la cuenta', () => {
    const e = errorsOf(validateForm({ ...valid, currency: 'USD' }, vctx));
    assert.match(e.account ?? '', /soles.*dólares/);
    assert.equal(validateForm({ ...valid, currency: 'USD', accountId: 'a3' }, vctx).ok, true);
    assert.equal(validateForm({ ...valid, accountId: 'a3' }, vctx).ok, false);
  });
  test('validateForm junta todos los errores', () => {
    const errors = errorsOf(validateForm({ ...valid, amountText: '', date: '', accountId: '' }, vctx));
    assert.deepEqual(Object.keys(errors).sort(), ['account', 'amount', 'date']);
  });
});

describe('savedMatchesSubmission (reintento tras respuesta perdida)', () => {
  const v = { description: 'Tottus', amountCents: 8640, currency: 'PEN' as const, date: '2026-10-04', categoryId: 'c1', accountId: 'a1' };
  const saved = { amount: 86.4, account_id: 'a1', category_id: 'c1', currency_code: 'PEN', transaction_date: '2026-10-04T17:00:00.000Z', description: 'Tottus' };
  test('igual -> true (monto numérico o texto)', () => {
    assert.equal(savedMatchesSubmission(saved, v), true);
    assert.equal(savedMatchesSubmission({ ...saved, amount: '86.40' }, v), true);
  });
  test('cualquier diferencia -> false', () => {
    assert.equal(savedMatchesSubmission({ ...saved, amount: 90.1 }, v), false);
    assert.equal(savedMatchesSubmission({ ...saved, account_id: 'a2' }, v), false);
    assert.equal(savedMatchesSubmission({ ...saved, category_id: null }, v), false);
    assert.equal(savedMatchesSubmission({ ...saved, currency_code: 'USD' }, v), false);
    assert.equal(savedMatchesSubmission({ ...saved, transaction_date: '2026-10-03T17:00:00.000Z' }, v), false);
    assert.equal(savedMatchesSubmission({ ...saved, description: 'Otro' }, v), false);
  });
  test('sin categoría en ambos lados -> true; día de Lima, no UTC', () => {
    assert.equal(savedMatchesSubmission({ ...saved, category_id: null }, { ...v, categoryId: null }), true);
    assert.equal(savedMatchesSubmission({ ...saved, transaction_date: '2026-10-05T02:00:00.000Z' }, v), true); // 21:00 del 4 en Lima
  });
});

describe('errores y espera', () => {
  test('describeFailure por estado HTTP', () => {
    assert.equal(describeFailure({ status: 422 }).kind, 'unreadable');
    assert.equal(describeFailure({ status: 500, serverMessage: 'No se pudo leer la boleta' }).kind, 'unreadable');
    assert.equal(describeFailure({ status: 500, serverMessage: 'Modelo no configurado' }).kind, 'unavailable');
    assert.equal(describeFailure({ status: 500 }).kind, 'unavailable');
    assert.equal(describeFailure({ status: 502 }).kind, 'unavailable');
    assert.equal(describeFailure({ status: 401 }).kind, 'auth');
    assert.equal(describeFailure({ status: 403 }).kind, 'auth');
    assert.equal(describeFailure({ status: 413 }).kind, 'too-large');
    assert.equal(describeFailure({ status: 400 }).kind, 'unknown');
    assert.equal(describeFailure({}).kind, 'unknown');
  });
  test('describeFailure: red y tiempo agotado mandan sobre el estado', () => {
    assert.equal(describeFailure({ network: true }).kind, 'network');
    assert.equal(describeFailure({ timedOut: true, status: 500 }).kind, 'timeout');
  });
  test('el mensaje de "no pude leer" pide más luz', () => {
    const p = describeFailure({ status: 422 });
    assert.match(p.title, /No pude leer la boleta/);
    assert.match(p.hint, /luz/);
    assert.equal(p.canWriteByHand, true);
  });
  test('reintentar la misma foto solo cuando puede servir', () => {
    assert.equal(describeFailure({ status: 422 }).canRetry, false);
    assert.equal(describeFailure({ status: 502 }).canRetry, true);
    assert.equal(describeFailure({ network: true }).canRetry, true);
    assert.equal(describeFailure({ timedOut: true }).canRetry, true);
  });
  test('readingMessage avanza con el tiempo', () => {
    assert.deepEqual(readingMessage(0), { text: 'Leyendo la boleta…', slow: false });
    assert.equal(readingMessage(8).slow, false);
    assert.notEqual(readingMessage(8).text, readingMessage(0).text);
    assert.equal(readingMessage(15).slow, true);
    assert.equal(readingMessage(60).slow, true);
  });
});
