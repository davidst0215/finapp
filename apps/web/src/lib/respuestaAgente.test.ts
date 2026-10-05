// Corre con Node: `node --experimental-strip-types --test respuestaAgente.test.ts`.
// @ts-ignore
import { test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { separarRespuesta } from './respuestaAgente.ts';

const enc = new TextEncoder();
const flujo = (...partes: (string | number[])[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of partes) c.enqueue(typeof p === 'string' ? enc.encode(p) : new Uint8Array(p));
      c.close();
    },
  });
const leerTodo = async (s: ReadableStream<Uint8Array>) => {
  const bytes: number[] = [];
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) return bytes;
    bytes.push(...value);
  }
};

test('JSON partido en fragmentos y audio pegado tras el salto de línea', async () => {
  const { resultado, audio } = await separarRespuesta(flujo('{"action":"query","mes', 'sage":"Hola"}\n', [1, 2], [3]));
  assert.deepEqual(resultado, { action: 'query', message: 'Hola' });
  assert.deepEqual(await leerTodo(audio!), [1, 2, 3]);
});

test('el audio empieza en el mismo fragmento que el salto de línea', async () => {
  const { audio } = await separarRespuesta(flujo([...enc.encode('{"message":"ok"}\n'), 9, 8], [7]));
  assert.deepEqual(await leerTodo(audio!), [9, 8, 7]);
});

test('solo JSON, sin salto (servidor viejo o error): sin audio', async () => {
  const { resultado, audio } = await separarRespuesta(flujo('{"error":"No autorizado"}'));
  assert.deepEqual(resultado, { error: 'No autorizado' });
  assert.equal(audio, null);
});

test('JSON y la respuesta termina (la voz falló): sin audio', async () => {
  const { resultado, audio } = await separarRespuesta(flujo('{"message":"Listo"}\n', []));
  assert.deepEqual(resultado, { message: 'Listo' });
  assert.equal(audio, null);
});

test('un cuerpo que no es JSON falla', async () => {
  await assert.rejects(separarRespuesta(flujo('<html>gateway</html>')));
});
