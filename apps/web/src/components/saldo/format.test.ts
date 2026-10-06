// Corre con Node: `node --experimental-strip-types --test format.test.ts`.
// @ts-ignore
import { test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { caracteres, duracion, textoProyeccion, usd } from './format.ts';

test('proyección en texto: días, meses, ritmo cero y agotado', () => {
  assert.equal(textoProyeccion({ tipo: 'dias', dias: 261 }), 'A este ritmo alcanza para unos 9 meses');
  assert.equal(textoProyeccion({ tipo: 'dias', dias: 11 }), 'A este ritmo alcanza para unos 11 días');
  assert.equal(textoProyeccion({ tipo: 'dias', dias: 0 }), 'A este ritmo alcanza para un día');
  assert.equal(textoProyeccion({ tipo: 'mas_de_12_meses' }), 'A este ritmo dura más de 12 meses');
  assert.equal(textoProyeccion({ tipo: 'agotado' }), 'Saldo agotado');
});

test('duración: singular de mes y borde de 30 días', () => {
  assert.equal(duracion(29), 'unos 29 días');
  assert.equal(duracion(30), 'un mes');
  assert.equal(duracion(45), 'unos 2 meses');
});

test('montos con dos decimales y caracteres con separador de miles', () => {
  assert.equal(usd(9.7289), 'US$ 9.73');
  assert.equal(usd(0), 'US$ 0.00');
  assert.match(caracteres(1200, 100000), /^1.200 de 100.000 caracteres$|^1,200 de 100,000 caracteres$/);
});
