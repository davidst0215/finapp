import { useCallback, useEffect, useRef, useState } from 'react';
import { functionUrl, supabase } from '@/lib/supabase';
import { reproducirStream, type Reproduccion } from '@/lib/audioStream';

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
    setState('idle');
  }, []);

  // Al salir de la pantalla o cambiar de texto, la voz se corta.
  useEffect(() => stop, [stop, text]);

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
        body: JSON.stringify({ text: text.slice(0, 400) }),
      });
      if (!res.ok) throw new Error('TTS failed');
      if (turn.current !== mine) return;

      const audio = new Audio();
      const playback = reproducirStream(res, audio);
      playRef.current = playback;
      audio.addEventListener('playing', () => { if (turn.current === mine) setState('playing'); }, { once: true });
      const sono = await playback.fin;
      if (turn.current !== mine) return; // lo detuvo David o cambió el texto
      setState(sono ? 'idle' : 'error');
    } catch {
      if (turn.current === mine) setState('error');
    } finally {
      if (turn.current === mine) {
        abortRef.current = null;
        playRef.current = null;
      }
    }
  }, [state, stop, text]);

  return { state, toggle };
}
