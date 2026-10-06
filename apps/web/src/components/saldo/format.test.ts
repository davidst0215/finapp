// Corre con Node: `node --experimental-strip-types --test format.test.ts`.
// @ts-ignore
import { test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { caracteres, usd } from './format.ts';

test('montos con dos decimales', () => {
  assert.equal(usd(9.7289), 'US$ 9.73');
  assert.equal(usd(0), 'US$ 0.00');
});

test('caracteres con separador de miles fijo, sin depender del locale', () => {
  assert.equal(caracteres(1200, 100000), '1,200 de 100,000 caracteres');
  assert.equal(caracteres(0, 10000), '0 de 10,000 caracteres');
  assert.equal(caracteres(999, 1000000), '999 de 1,000,000 caracteres');
});
