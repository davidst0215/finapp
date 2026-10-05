// Corre con Node: `node --experimental-strip-types --test conversacion.test.ts`.
// @ts-ignore
import { test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { esFraseDeCierre } from './conversacion.ts';

test('frases sueltas de despedida terminan la conversación', () => {
  for (const t of ['gracias', 'Gracias, Wabid.', 'muchas gracias', 'listo', 'Listo!', 'chao', 'chau Wabid', 'eso es todo', 'nada más', 'ya está', 'hasta luego', 'adiós']) {
    assert.equal(esFraseDeCierre(t), true, t);
  }
});

test('un pedido que empieza o termina con "gracias" no corta', () => {
  for (const t of ['gracias, ahora agenda una reunión mañana', 'listo el gasto de 20 en taxi', 'anota que ya está pagado el agua', 'dile gracias a Mónica por correo', '']) {
    assert.equal(esFraseDeCierre(t), false, t);
  }
});
