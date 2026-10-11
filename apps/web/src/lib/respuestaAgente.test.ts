// Corre con Node: `node --experimental-strip-types --test respuestaAgente.test.ts`.
// @ts-ignore
import { test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { respaldoDeVoz, separarRespuesta } from './respuestaAgente.ts';

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

test('respaldoDeVoz: si el audio llegó y no sonó, voz del navegador (ElevenLabs ya cobró); /tts solo si nunca llegó', () => {
  // Llegó el audio del agente y sonó: nada más que hacer.
  assert.equal(respaldoDeVoz({ llegoAudio: true, sono: true, vigente: true }), 'ninguno');
  // Llegó (ya se cobró) pero no sonó, p. ej. el navegador bloqueó el audio: NO se pide /tts, que cobraría de nuevo.
  assert.equal(respaldoDeVoz({ llegoAudio: true, sono: false, vigente: true }), 'navegador');
  // El audio nunca llegó (sin voz en el servidor, o ElevenLabs falló antes del primer fragmento): /tts.
  assert.equal(respaldoDeVoz({ llegoAudio: false, sono: false, vigente: true }), 'tts');
  // David interrumpió o empezó otro turno: no se habla nada, haya llegado audio o no.
  assert.equal(respaldoDeVoz({ llegoAudio: true, sono: false, vigente: false }), 'ninguno');
  assert.equal(respaldoDeVoz({ llegoAudio: false, sono: false, vigente: false }), 'ninguno');
});
