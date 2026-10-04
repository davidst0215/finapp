import { useCallback, useEffect, useRef, useState } from 'react';

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface NoticeInput {
  message: string;
  tone?: 'info' | 'error';
  action?: NoticeAction;
  /** Milisegundos a la vista. Por defecto 5 s (7 s si es un error). */
  duration?: number;
}

export interface NoticeState extends NoticeInput {
  id: number;
}

/**
 * Un aviso inferior a la vez. El temporizador se pausa mientras el puntero o el foco están sobre el aviso
 * (quien va con teclado o lector de pantalla no debería perder el botón "Deshacer" a mitad de camino).
 */
export function useNotice() {
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const timer = useRef<number | null>(null);
  const nextId = useRef(0);
  const duration = useRef(5000);
  const visible = useRef(false);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    timer.current = window.setTimeout(() => {
      visible.current = false;
      setNotice(null);
    }, duration.current);
  }, [stop]);

  const dismiss = useCallback(() => {
    stop();
    visible.current = false;
    setNotice(null);
  }, [stop]);

  const show = useCallback(
    (input: NoticeInput) => {
      nextId.current += 1;
      duration.current = input.duration ?? (input.tone === 'error' ? 7000 : 5000);
      visible.current = true;
      setNotice({ ...input, id: nextId.current });
      start();
    },
    [start],
  );

  const resume = useCallback(() => {
    if (visible.current) start();
  }, [start]);

  useEffect(() => stop, [stop]);

  return { notice, show, dismiss, pause: stop, resume };
}
