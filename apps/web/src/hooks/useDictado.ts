import { useCallback, useEffect, useRef, useState } from 'react';

export type ErrorDictado = 'permiso' | 'sin-voz' | 'sin-microfono' | 'red' | 'otro';

interface Opciones {
  lang?: string;
  /** Resultado parcial o final mientras se habla (se reemplaza en cada llamada). */
  onTexto: (texto: string) => void;
  onError?: (e: ErrorDictado) => void;
  onFin?: () => void;
}

// Dictado por mantener presionado: el que llama decide qué hacer con el texto (el orb principal usa su propia
// máquina de estados; el compositor del chat solo quiere texto en el campo).
export function useDictado({ lang = 'es-PE', onTexto, onError, onFin }: Opciones) {
  const [escuchando, setEscuchando] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rec = useRef<any>(null);
  const cb = useRef({ onTexto, onError, onFin });
  cb.current = { onTexto, onError, onFin };

  const soportado = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const iniciar = useCallback(() => {
    if (!soportado || rec.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const API = w.SpeechRecognition || w.webkitSpeechRecognition;
    const r = new API();
    r.lang = lang;
    r.continuous = false;
    r.interimResults = true;
    r.onstart = () => setEscuchando(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r.onresult = (ev: any) => {
      // Solo el último resultado: en el celular los anteriores se repiten.
      const t = ev.results[ev.results.length - 1]?.[0]?.transcript ?? '';
      cb.current.onTexto(t);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r.onerror = (ev: any) => {
      const e = ev?.error as string;
      if (e === 'aborted') return;
      cb.current.onError?.(
        e === 'not-allowed' || e === 'service-not-allowed' ? 'permiso'
          : e === 'no-speech' ? 'sin-voz'
          : e === 'audio-capture' ? 'sin-microfono'
          : e === 'network' ? 'red' : 'otro',
      );
    };
    r.onend = () => {
      rec.current = null;
      setEscuchando(false);
      cb.current.onFin?.();
    };
    rec.current = r;
    try { r.start(); } catch { rec.current = null; cb.current.onError?.('otro'); }
  }, [soportado, lang]);

  const detener = useCallback(() => { rec.current?.stop(); }, []);

  useEffect(() => () => { rec.current?.abort(); }, []);

  return { soportado, escuchando, iniciar, detener };
}
