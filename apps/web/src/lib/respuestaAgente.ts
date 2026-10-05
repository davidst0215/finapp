// Respuesta del agente pedida con voz: la primera línea es el JSON del resultado y lo que sigue es el MP3,
// que llega mientras ElevenLabs lo genera. Solo usa streams estándar: se prueba con Node (respuestaAgente.test.ts).

export type RespuestaAgente = {
  resultado: Record<string, unknown>;
  /** null si la respuesta no trae voz: servidor sin voz, error, o ElevenLabs falló tras el JSON. */
  audio: ReadableStream<Uint8Array> | null;
};

const SALTO = 10; // '\n': JSON.stringify nunca lo deja dentro del JSON

export async function separarRespuesta(cuerpo: ReadableStream<Uint8Array>): Promise<RespuestaAgente> {
  const lector = cuerpo.getReader();
  const partes: Uint8Array[] = [];
  let resto: Uint8Array | null = null;
  while (resto === null) {
    const { done, value } = await lector.read();
    if (done) break;
    const i = value.indexOf(SALTO);
    if (i < 0) {
      partes.push(value);
    } else {
      partes.push(value.subarray(0, i));
      resto = value.subarray(i + 1);
    }
  }
  let resultado: Record<string, unknown>;
  try {
    resultado = JSON.parse(new TextDecoder().decode(unir(partes)));
  } catch {
    // Un 502 del gateway llega en HTML: no tiene sentido mostrarle a David el error de JSON.
    await lector.cancel().catch(() => {});
    throw new Error('El servidor respondió algo inesperado. Intenta de nuevo.');
  }
  if (resto === null) return { resultado, audio: null };

  // Se espera el primer fragmento de audio: si la respuesta termina antes, la voz no llegó.
  while (resto.length === 0) {
    const { done, value } = await lector.read();
    if (done) return { resultado, audio: null };
    resto = value;
  }
  const primero = resto;
  const audio = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(primero);
    },
    async pull(c) {
      const { done, value } = await lector.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(motivo) {
      return lector.cancel(motivo); // David interrumpió: también se corta la descarga
    },
  });
  return { resultado, audio };
}

function unir(partes: Uint8Array[]): Uint8Array {
  const total = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of partes) {
    total.set(p, i);
    i += p.length;
  }
  return total;
}
