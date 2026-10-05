import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
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

// Compositor fijo al pie, como en un chat. En el celular Enter agrega un salto de línea (se envía con el botón); en
// escritorio Enter envía y Mayús+Enter agrega el salto.
export function Composer({ placeholder = 'Escríbele a Claude…', maxLength, disabledReason, hint, label = 'Mensaje para Claude', onSend, autoFocus }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const trimmed = text.trim();

  // Crece con el texto hasta ~6 líneas y de ahí se desplaza por dentro.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text, disabledReason]);

  const submit = async () => {
    if (sending || !trimmed) return;
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
              rows={1}
              maxLength={maxLength}
              autoFocus={autoFocus}
              placeholder={placeholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              enterKeyHint="enter"
              className="max-h-36 min-h-[48px] flex-1 resize-none rounded-3xl border border-slate-700 bg-slate-800 px-4 py-3 text-base leading-snug text-slate-100 placeholder-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={sending || !trimmed}
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
