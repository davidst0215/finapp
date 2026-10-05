// Reproduce la voz de Wabid mientras llega, en vez de esperar el MP3 completo
// (ElevenLabs tarda ~1.5 s en el primer byte y ~0.7 s más en terminar).
// Con MediaSource el audio arranca con los primeros fragmentos; si el navegador no lo soporta
// (iPhone) o algo falla antes de sonar, se arma el archivo completo y se reproduce igual.
// Toda espera tiene salida: si nada suena a tiempo, `fin` resuelve `false` y quien llama
// decide el respaldo (la voz del navegador).

export interface Reproduccion {
  /** `true` si el audio sonó (completo o detenido por David); `false` si no llegó a sonar. */
  fin: Promise<boolean>;
  detener: () => void;
}

const MIME = 'audio/mpeg';
const MAX_ESPERA_SOURCEOPEN = 3000; // MediaSource que no abre: se pasa al archivo completo
const MAX_ESPERA_SONIDO = 10000;    // nada suena en 10 s desde el pedido: se abandona
const MAX_REPRODUCCION = 90000;     // tope duro (las respuestas son de segundos)

export function puedeStreamear(): boolean {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MIME);
}

/** `alSonar` corre una vez, cuando el audio empieza a oírse (para mostrar el texto en ese momento). */
export function reproducirStream(res: Response, audio: HTMLAudioElement, alSonar?: () => void): Reproduccion {
  let detenido = false;
  let sono = false;
  let lector: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const urls: string[] = [];
  const marcarSonido = () => {
    if (!sono) alSonar?.();
    sono = true;
  };
  audio.addEventListener('playing', marcarSonido);

  let abandonar: () => void = () => {};
  const abandono = new Promise<void>((ok) => { abandonar = ok; });

  const detener = () => {
    detenido = true;
    audio.pause();
    lector?.cancel().catch(() => {});
    abandonar();
  };

  const reproducir = async () => {
    if (!res.body || !puedeStreamear()) {
      await sonar(audio, await res.blob(), urls, () => detenido);
      return;
    }
    lector = res.body.getReader();
    const recibidos: Uint8Array[] = [];
    try {
      await streamear(audio, lector, recibidos, urls, () => detenido);
    } catch {
      if (detenido || sono) return; // ya sonó algo: no repetir desde el inicio
      // MediaSource falló antes de sonar: junta lo recibido más lo que falta y reproduce el archivo.
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        recibidos.push(value);
      }
      await sonar(audio, new Blob(recibidos as BlobPart[], { type: MIME }), urls, () => detenido);
    }
  };

  const vigilancia = setTimeout(() => { if (!sono) detener(); }, MAX_ESPERA_SONIDO);
  const tope = setTimeout(detener, MAX_REPRODUCCION);

  const fin = Promise.race([reproducir().catch(() => {}), abandono])
    .then(() => sono)
    .finally(() => {
      clearTimeout(vigilancia);
      clearTimeout(tope);
      audio.removeEventListener('playing', marcarSonido);
      if (!audio.ended) audio.pause(); // nunca queda un <audio> esperando datos que no llegan
      lector?.cancel().catch(() => {});
      urls.forEach((u) => URL.revokeObjectURL(u));
    });

  return { fin, detener };
}

async function streamear(
  audio: HTMLAudioElement,
  lector: ReadableStreamDefaultReader<Uint8Array>,
  recibidos: Uint8Array[],
  urls: string[],
  detenido: () => boolean,
): Promise<void> {
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  urls.push(url);
  audio.src = url;
  await new Promise<void>((ok, falla) => {
    const t = setTimeout(() => falla(new Error('sourceopen')), MAX_ESPERA_SOURCEOPEN);
    ms.addEventListener('sourceopen', () => { clearTimeout(t); ok(); }, { once: true });
    audio.addEventListener('error', () => { clearTimeout(t); falla(new Error('src')); }, { once: true });
  });
  const sb = ms.addSourceBuffer(MIME);
  const terminado = esperarFin(audio);

  let pidioPlay = false;
  for (;;) {
    const { done, value } = await lector.read();
    if (done || detenido()) break;
    recibidos.push(value);
    await agregar(sb, value);
    if (!pidioPlay) {
      pidioPlay = true;
      // Si el navegador bloquea el play (sin interacción previa), no hay nada que esperar.
      audio.play().catch(() => audio.dispatchEvent(new Event('error')));
    }
  }
  if (ms.readyState === 'open' && !sb.updating) ms.endOfStream();
  if (!pidioPlay) return;
  await terminado;
}

function agregar(sb: SourceBuffer, chunk: Uint8Array): Promise<void> {
  return new Promise((ok, falla) => {
    const listo = () => { sb.removeEventListener('error', error); ok(); };
    const error = () => { sb.removeEventListener('updateend', listo); falla(new Error('appendBuffer')); };
    sb.addEventListener('updateend', listo, { once: true });
    sb.addEventListener('error', error, { once: true });
    sb.appendBuffer(chunk as BufferSource);
  });
}

async function sonar(audio: HTMLAudioElement, blob: Blob, urls: string[], detenido: () => boolean): Promise<void> {
  if (detenido()) return;
  const url = URL.createObjectURL(blob);
  urls.push(url);
  audio.src = url;
  const terminado = esperarFin(audio);
  await audio.play().catch(() => audio.dispatchEvent(new Event('error')));
  await terminado;
}

function esperarFin(audio: HTMLAudioElement): Promise<void> {
  return new Promise((ok) => {
    const listo = () => {
      audio.removeEventListener('ended', listo);
      audio.removeEventListener('error', listo);
      audio.removeEventListener('pause', pausa);
      ok();
    };
    // Una pausa con el audio sin terminar es una interrupción de David.
    const pausa = () => { if (!audio.ended) listo(); };
    audio.addEventListener('ended', listo);
    audio.addEventListener('error', listo);
    audio.addEventListener('pause', pausa);
  });
}
