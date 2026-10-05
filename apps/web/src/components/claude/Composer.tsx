import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, MicOff } from 'lucide-react';
import { useDictado, type ErrorDictado } from '@/hooks/useDictado';
import { detenerVoz } from '@/lib/hablar';
import { unirDictado } from '@/lib/vozTexto';
import { cn } from '@/lib/utils';

interface Props {
  placeholder?: string;
  maxLength: number;
  /** Cierra el envío con un motivo: sesión terminada, sin laptop… El campo se reemplaza por la explicación. */
  disabledReason?: React.ReactNode;
  /** Una línea sobre el campo (p. ej. cuándo lo lee Claude). */
  hint?: React.ReactNode;
  label?: string;
  /** Devuelve null si salió bien (se vacía el campo) o el motivo del fallo (se muestra y se conserva el texto). */
  onSend: (text: string) => Promise<string | null>;
  autoFocus?: boolean;
}

const MAX_HEIGHT = 144; // ~6 líneas
const TOQUE_CORTO_MS = 400; // menos que esto no es "mantener presionado"

const AVISOS_VOZ: Record<ErrorDictado, string> = {
  permiso: 'El micrófono está bloqueado. Permítelo en los ajustes del navegador para dictar.',
  'sin-voz': 'No te escuché. Mantén presionado el orbe y habla.',
  'sin-microfono': 'No encuentro un micrófono en este dispositivo.',
  red: 'Dictar necesita conexión. Revisa tu internet.',
  otro: 'No pude dictar esta vez. Intenta de nuevo o escribe.',
};

// Compositor fijo al pie, como en un chat. En el celular Enter agrega un salto de línea (se envía con el botón); en
// escritorio Enter envía y Mayús+Enter agrega el salto.
export function Composer({ placeholder = 'Escríbele a Claude…', maxLength, disabledReason, hint, label = 'Mensaje para Claude', onSend, autoFocus }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Voz: lo que había en el campo al empezar a dictar (lo dictado se agrega al final) y desde cuándo se mantiene presionado.
  const base = useRef('');
  const desde = useRef(0);
  const toqueCorto = useRef(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const dictado = useDictado({
    onTexto: useCallback((t: string) => setText(unirDictado(base.current, t).slice(0, maxLength)), [maxLength]),
    // Tras un toque corto el aviso útil es "mantén presionado"; el "no te escuché" que llega después no lo pisa.
    onError: useCallback((e: ErrorDictado) => { if (!toqueCorto.current) setAviso(AVISOS_VOZ[e]); }, []),
  });
  const trimmed = text.trim();

  // Crece con el texto hasta ~6 líneas y de ahí se desplaza por dentro.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text, disabledReason]);

  const submit = async () => {
    if (sending || !trimmed || dictado.escuchando) return;
    setSending(true);
    setError(null);
    try {
      const failure = await onSend(trimmed);
      if (failure === null) {
        setText('');
        field.current?.focus();
      } else setError(failure);
    } finally {
      setSending(false);
    }
  };

  const empezarDictado = () => {
    if (dictado.escuchando || sending) return;
    detenerVoz(); // si Claude estaba leyendo, el micrófono no debe oírlo
    base.current = text;
    desde.current = Date.now();
    toqueCorto.current = false;
    setAviso(null);
    dictado.iniciar();
  };
  const soltarDictado = () => {
    if (desde.current === 0) return;
    toqueCorto.current = Date.now() - desde.current < TOQUE_CORTO_MS;
    if (toqueCorto.current) setAviso('Mantén presionado el orbe mientras hablas; al soltar, el texto queda en el campo.');
    desde.current = 0;
    dictado.detener();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    if ((finePointer && !e.shiftKey) || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t border-slate-700 bg-slate-950 px-3 pt-2.5" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
      {disabledReason ? (
        <div role="status" className="rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-[15px] leading-snug text-slate-300">
          {disabledReason}
        </div>
      ) : (
        <>
          {hint && <div className="mb-2 px-1 text-[13px] leading-snug text-slate-400">{hint}</div>}
          {dictado.escuchando && (
            <p role="status" className="mb-2 flex items-center gap-2 px-1 text-[13px] font-semibold text-slate-200">
              <span className="h-2 w-2 rounded-full bg-slate-200" aria-hidden="true" />
              Escuchando… suelta para terminar
            </p>
          )}
          {!dictado.escuchando && (aviso || !dictado.soportado) && (
            <p role="status" className="mb-2 flex items-start gap-1.5 px-1 text-[13px] leading-snug text-slate-300">
              <MicOff size={14} strokeWidth={1.9} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              {aviso ?? 'Este navegador no permite dictar por voz. Escribe tu mensaje.'}
            </p>
          )}
          {error && (
            <p role="alert" className="mb-2 px-1 text-[13px] font-semibold text-expense">
              {error}
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={field}
              aria-label={label}
              value={text}
              readOnly={dictado.escuchando}
              rows={1}
              maxLength={maxLength}
              autoFocus={autoFocus}
              placeholder={dictado.escuchando ? 'Habla ahora…' : placeholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              enterKeyHint="enter"
              className="max-h-36 min-h-[48px] flex-1 resize-none rounded-3xl border border-slate-700 bg-slate-800 px-4 py-3 text-base leading-snug text-slate-100 placeholder-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
            />
            {dictado.soportado && (
              <button
                type="button"
                aria-label={dictado.escuchando ? 'Escuchando. Suelta para terminar de dictar' : 'Dictar mensaje. Mantén presionado'}
                aria-pressed={dictado.escuchando}
                disabled={sending}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* el dictado arranca igual */ }
                  empezarDictado();
                }}
                onPointerUp={soltarDictado}
                onPointerCancel={soltarDictado}
                onContextMenu={(e) => e.preventDefault()}
                // Teclado y lector de pantalla: un toque alterna (sin mantener).
                onClick={(e) => { if (e.detail === 0) { if (dictado.escuchando) dictado.detener(); else empezarDictado(); } }}
                className={cn('orb-dictar flex-shrink-0 touch-none select-none', dictado.escuchando && 'listening', sending && 'opacity-40')}
              >
                <Mic size={21} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={sending || !trimmed || dictado.escuchando}
              aria-label={sending ? 'Enviando…' : 'Enviar'}
              className={cn(
                'grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-primary-600 text-slate-950 transition-opacity active:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
                (sending || !trimmed) && 'opacity-40',
              )}
            >
              <ArrowUp size={22} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
          {text.length > maxLength * 0.85 && (
            <p className="mt-1 px-2 text-right text-[13px] tabular-nums text-slate-400">
              {text.length}/{maxLength}
            </p>
          )}
        </>
      )}
    </div>
  );
}
