// node --experimental-strip-types --test apps/web/tests/contactos/telefono.test.mjs
// El formulario de Contactos (apps/web/src/lib/telefono.ts) y Wabid por voz (supabase/functions/_shared/telefono.ts) normalizan
// los teléfonos con dos copias del mismo código. Esta prueba las pone frente a la misma tabla: si una regla cambia en una sola,
// un contacto guardado a mano dejaría de coincidir con el que guarda Wabid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarTelefono as web, formatearTelefono as formatoWeb } from '../../src/lib/telefono.ts';
import { normalizarTelefono as servidor, formatearTelefono as formatoServidor } from '../../../../supabase/functions/_shared/telefono.ts';

const CASOS = [
  '999 888 777', '999888777', '999-888-777', '999.888.777', '(999) 888 777', ' 999 888 777 ', 999888777,
  '+51 999 888 777', '+51999888777', '51 999 888 777', '51999888777', '0051 999 888 777', '(+51) 999-888-777',
  '01 234 5678', '(01) 234-5678', '+51 1 234 5678', '044 123 456',
  '+57 300 123 4567', '0057 300 123 4567', '+1 (415) 555-2671', '+34 612 345 678', '+591 712 345 67',
  '', '   ', 'abc', '999 888 777 anexo 2', '999 888 77', '99988877799', '888 777 666', '+51 999 888 77', '+51 888 777 666',
  '234 5678', '1 234 5678', '+0 1234 5678', '+12345', '+1234567890123456', '++51999888777', '51+999888777', '573001234567',
  '9'.repeat(60), null, undefined, {}, 0,
];

test('web y servidor normalizan igual cada caso', () => {
  for (const caso of CASOS) {
    const a = web(caso);
    const b = servidor(caso);
    assert.equal(a.ok, b.ok, `ok difiere para ${JSON.stringify(caso)}`);
    if (a.ok && b.ok) {
      assert.equal(a.e164, b.e164, JSON.stringify(caso));
      assert.equal(formatoWeb(a.e164), formatoServidor(b.e164), `formato de ${a.e164}`);
    }
  }
});

test('la tabla cubre válidos e inválidos (la prueba no es vacía)', () => {
  const validos = CASOS.filter((c) => web(c).ok).length;
  assert.ok(validos >= 18 && CASOS.length - validos >= 20, `${validos} válidos de ${CASOS.length}`);
});
