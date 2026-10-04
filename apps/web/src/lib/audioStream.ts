// Reproduce la voz de Wabid mientras llega, en vez de esperar el MP3 completo
// (ElevenLabs tarda ~1.5 s en el primer byte y ~0.7 s más en terminar).
// Con MediaSource el audio arranca con los primeros fragmentos; si el navegador no lo soporta
// (iPhone) o algo falla antes de sonar, se arma el archivo completo y se reproduce igual.

export interface Reproduccion {
  /** Se resuelve cuando el audio termina, falla o se detiene. */
  fin: Promise<void>;
  detener: () => void;
}

const MIME = 'audio/mpeg';

export function puedeStreamear(): boolean {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MIME);
}

export function reproducirStream(res: Response, audio: HTMLAudioElement): Reproduccion {
  let detenido = false;
  let lector: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const urls: string[] = [];

  const detener = () => {
    detenido = true;
    audio.pause();
    lector?.cancel().catch(() => {});
  };

  const fin = (async () => {
    try {
      if (!res.body || !puedeStreamear()) {
        await sonar(audio, await res.blob(), urls, () => detenido);
        return;
      }
      lector = res.body.getReader();
      const recibidos: Uint8Array[] = [];
      try {
        await streamear(audio, lector, recibidos, urls, () => detenido);
      } catch {
        if (detenido) return;
        // MediaSource falló: junta lo recibido más lo que falta y reproduce el archivo entero.
        for (;;) {
          const { done, value } = await lector.read();
          if (done) break;
          recibidos.push(value);
        }
        await sonar(audio, new Blob(recibidos as BlobPart[], { type: MIME }), urls, () => detenido);
      }
    } finally {
      urls.forEach((u) => URL.revokeObjectURL(u));
    }
  })().catch(() => {});

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
  await new Promise<void>((ok) => ms.addEventListener('sourceopen', () => ok(), { once: true }));
  const sb = ms.addSourceBuffer(MIME);
  const terminado = esperarFin(audio);

  let sonando = false;
  for (;;) {
    const { done, value } = await lector.read();
    if (done || detenido()) break;
    recibidos.push(value);
    await agregar(sb, value);
    if (!sonando) {
      sonando = true;
      // Si el navegador bloquea el play (sin interacción previa), no hay nada que esperar.
      audio.play().catch(() => audio.dispatchEvent(new Event('error')));
    }
  }
  if (ms.readyState === 'open' && !sb.updating) ms.endOfStream();
  if (!sonando) return;
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
