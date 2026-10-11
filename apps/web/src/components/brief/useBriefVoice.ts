import { useCallback, useEffect, useRef, useState } from 'react';
import { functionUrl, supabase } from '@/lib/supabase';
import { reproducirStream, type Reproduccion } from '@/lib/audioStream';
import { recortarParaVoz } from '@/lib/vozTexto';

/** Lo que se manda a leer del brief: el texto limpio. El servidor dice solo el titular (su primera oración, ≤ 100 caracteres). */
export const recortarBrief = (text: string): string => recortarParaVoz(text).texto;

export type VoiceState = 'idle' | 'loading' | 'playing' | 'error';

/** Lee el texto en voz alta con la voz de Wabid (función `tts`, en streaming). Tocar de nuevo la detiene. */
export function useBriefVoice(text: string) {
  const [state, setState] = useState<VoiceState>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const playRef = useRef<Reproduccion | null>(null);
  const turn = useRef(0);

  const stop = useCallback(() => {
    turn.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    playRef.current?.detener();
    playRef.current = null;
    window.speechSynthesis?.cancel();
    setState('idle');
  }, []);

  // Al salir de la pantalla o cambiar de texto, la voz se corta.
  useEffect(() => stop, [stop, text]);

  // Si la voz de Wabid no llegó a sonar, la del navegador lee el mismo texto (con tope de tiempo).
  const respaldoNavegador = useCallback(async (mine: number) => {
    if (turn.current !== mine) return;
    if (!('speechSynthesis' in window)) { setState('error'); return; }
    const hablado = recortarBrief(text);
    setState('playing');
    await new Promise<void>((ok) => {
      const tope = setTimeout(ok, hablado.length * 90 + 3000);
      const listo = () => { clearTimeout(tope); ok(); };
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(hablado);
      u.lang = 'es-PE';
      u.onend = listo;
      u.onerror = listo;
      window.speechSynthesis.speak(u);
    });
    if (turn.current === mine) setState('idle');
  }, [text]);

  const toggle = useCallback(async () => {
    if (state === 'loading' || state === 'playing') {
      stop();
      return;
    }
    const mine = ++turn.current;
    const abort = new AbortController();
    abortRef.current = abort;
    setState('loading');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Sin sesión');
      const res = await fetch(functionUrl('tts'), {
        method: 'POST',
        signal: abort.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ text: recortarBrief(text) }),
      });
      if (!res.ok) throw new Error('TTS failed');
      if (turn.current !== mine) return;

      const audio = new Audio();
      const playback = reproducirStream(res, audio);
      playRef.current = playback;
      audio.addEventListener('playing', () => { if (turn.current === mine) setState('playing'); }, { once: true });
      const sono = await playback.fin;
      if (turn.current !== mine) return; // lo detuvo David o cambió el texto
      if (sono) { setState('idle'); return; }
      await respaldoNavegador(mine);
    } catch {
      if (turn.current !== mine) return;
      await respaldoNavegador(mine);
    } finally {
      if (turn.current === mine) {
        abortRef.current = null;
        playRef.current = null;
      }
    }
  }, [state, stop, text, respaldoNavegador]);

  return { state, toggle };
}
