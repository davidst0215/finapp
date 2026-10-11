// Corre con Node: `node --experimental-strip-types --test contactos.test.ts`.
// @ts-ignore
import { test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import {
  desdeSelector, filtrar, monograma, ordenar, parsearAlias, resumenImportacion, soportaSelector, validarBorrador, type Contacto,
} from './contactos.ts';

const c = (nombre: string, telefono: string, relacion: string | null = null, alias: string[] = []): Contacto =>
  ({ contacto_id: nombre + telefono, nombre, telefono, relacion, alias });

test('el formulario valida y normaliza: teléfono en E.164, relación como nota corta, apodos sin repetir', () => {
  const v = validarBorrador({ nombre: '  Marco  ', telefono: '999 888 777', relacion: 'es de Saya.', alias: 'Marquitos, marco, Marquitos, ' });
  assert.deepEqual(v, { ok: true, valores: { nombre: 'Marco', telefono: '+51999888777', relacion: 'de Saya', alias: ['Marquitos'] } });
  const sin = validarBorrador({ nombre: 'Rosa', telefono: '+57 300 123 4567', relacion: '', alias: '' });
  assert.deepEqual(sin, { ok: true, valores: { nombre: 'Rosa', telefono: '+573001234567', relacion: null, alias: [] } });
});

test('el formulario dice qué campo está mal y por qué', () => {
  const v = validarBorrador({ nombre: ' ', telefono: '999 888', relacion: 'x'.repeat(101), alias: 'a, b, c, d, e, f, g, h, i, j, k' });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.errores.nombre, 'Escribe el nombre.');
    assert.match(v.errores.telefono ?? '', /no está completo/);
    assert.match(v.errores.relacion ?? '', /Máximo 100/);
    assert.match(v.errores.alias ?? '', /Máximo 10/);
  }
  const vacio = validarBorrador({ nombre: 'Marco', telefono: '', relacion: '', alias: '' });
  assert.ok(!vacio.ok && vacio.errores.telefono === 'Escribe el número.' && !vacio.errores.nombre);
  const numeros = validarBorrador({ nombre: '1234', telefono: '999888777', relacion: '', alias: '' });
  assert.ok(!numeros.ok && numeros.errores.nombre === 'El nombre necesita letras.');
});

test('parsearAlias: comas, tildes y el propio nombre', () => {
  assert.deepEqual(parsearAlias('Mamá, mami, MAMÁ,  ', 'Rosa'), ['Mamá', 'mami']);
  assert.deepEqual(parsearAlias('rosa, Rosi', 'Rosa'), ['Rosi']);
  assert.deepEqual(parsearAlias('', 'Rosa'), []);
});

test('monograma: dos iniciales como máximo, con tildes y sin símbolos', () => {
  assert.equal(monograma('Marco Roca'), 'MR');
  assert.equal(monograma('Niñoska'), 'N');
  assert.equal(monograma('josé luis pérez'), 'JL');
  assert.equal(monograma('(Dr.) Álvaro'), 'DÁ');
  assert.equal(monograma('😀'), '?');
  assert.equal(monograma(''), '?');
});

test('la lista se ordena en español y se filtra por nombre, apodo, relación o dígitos', () => {
  const lista = [c('Zoila', '+51900000001'), c('Álvaro', '+51900000002'), c('marco', '+51999888777', 'de Saya'), c('Rosa Tarazona', '+51977333444', 'mi madre', ['Mamá'])];
  assert.deepEqual(ordenar(lista).map((x) => x.nombre), ['Álvaro', 'marco', 'Rosa Tarazona', 'Zoila']);
  assert.deepEqual(filtrar(lista, 'mama').map((x) => x.nombre), ['Rosa Tarazona']);
  assert.deepEqual(filtrar(lista, 'SAYA marco').map((x) => x.nombre), ['marco']);
  assert.deepEqual(filtrar(lista, '977').map((x) => x.nombre), ['Rosa Tarazona']);
  assert.deepEqual(filtrar(lista, 'alvaro').map((x) => x.nombre), ['Álvaro']);
  assert.deepEqual(filtrar(lista, 'nadie'), []);
  assert.equal(filtrar(lista, '   '), lista);
});

test('importar del celular: normaliza, descarta lo inválido y no repite números', () => {
  const existentes = [c('Marco', '+51999888777', 'de Saya')];
  const r = desdeSelector([
    { name: ['Marco Roca'], tel: ['999 888 777'] }, // ya estaba
    { name: ['Rosa'], tel: ['(+51) 977-333-444', '977333444'] }, // dos formas del mismo número
    { name: ['José'], tel: ['abc', '966 555 666', '+57 300 123 4567'] }, // dos válidos: se queda el primero
    { name: ['Sin número'], tel: [] },
    { name: ['Otro'] },
    { name: [''], tel: ['955 000 111'] }, // sin nombre
    { name: ['Rosa de nuevo'], tel: ['977 333 444'] }, // repetido dentro de la selección
    { tel: ['955 000 222'] },
  ], existentes);
  assert.deepEqual(r.nuevos, [
    { nombre: 'Rosa', telefono: '+51977333444', relacion: null, alias: [] },
    { nombre: 'José', telefono: '+51966555666', relacion: null, alias: [] },
  ]);
  assert.deepEqual([r.yaEstaban, r.sinNumero, r.sinNombre, r.conVarios], [2, 2, 2, 1]);
  assert.equal(resumenImportacion(r), 'Importé 2 contactos. 2 ya estaban, 2 sin número válido, 2 sin nombre, 1 tenía varios números: guardé el primero.');
});

test('resumen de importación en singular, plural y vacío', () => {
  const vacio = { nuevos: [], yaEstaban: 0, sinNumero: 0, sinNombre: 0, conVarios: 0 };
  assert.equal(resumenImportacion(vacio), 'No importé ningún contacto nuevo.');
  assert.equal(resumenImportacion({ ...vacio, nuevos: [{ nombre: 'A', telefono: '+51900000001', relacion: null, alias: [] }], yaEstaban: 1 }), 'Importé 1 contacto. 1 ya estaba.');
});

test('el selector solo existe en navegadores con ContactsManager', () => {
  const ventana = { ContactsManager: function () {} };
  assert.equal(soportaSelector({ contacts: { select: () => {} } }, ventana), true);
  assert.equal(soportaSelector({ contacts: { select: () => {} } }, {}), false);
  assert.equal(soportaSelector({}, ventana), false);
  assert.equal(soportaSelector(undefined, ventana), false);
});
