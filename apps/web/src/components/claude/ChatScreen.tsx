import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { calentarFunciones } from '@/lib/supabase';
import { detenerVoz } from '@/lib/hablar';
import { ChatItem, Chip } from './ChatMessages';
import type { Row } from './chatModel';
import type { ConversationTone } from './conversations';
import { ScreenShell } from './ScreenShell';
import type { Decision } from './types';

interface Props {
  title: string;
  /** Segunda línea del encabezado: estado + laptop. */
  subtitle: React.ReactNode;
  tone: ConversationTone;
  onBack: () => void;
  headerRight?: React.ReactNode;
  rows: Row[];
  fetchedAt: number;
  onDecide: (approvalId: string, decision: Decision) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  hasMore?: boolean;
  onLoadOlder?: () => void;
  /** «Claude está trabajando…» al final de la conversación. */
  working?: boolean;
  empty: React.ReactNode;
  footer: React.ReactNode;
  /** Aviso fijo arriba de la conversación (p. ej. «continuación de …»). */
  banner?: React.ReactNode;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Pantalla de chat: encabezado, línea de tiempo con auto-scroll y compositor fijo abajo. Cubre toda la pantalla (incluida la
// barra de pestañas), como cualquier app de mensajes; el botón atrás del sistema vuelve a la lista.
export function ChatScreen({ title, subtitle, tone, onBack, headerRight, rows, fetchedAt, onDecide, loading, error, onRetry, hasMore, onLoadOlder, working, empty, footer, banner }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastKey = useRef<string | null>(null);
  const [newBelow, setNewBelow] = useState(false);

  // "Escuchar" va por la función tts: se precalienta al abrir y se corta la voz al salir de la conversación.
  useEffect(() => {
    calentarFunciones('tts');
    return detenerVoz;
  }, []);

  const toBottom = (smooth: boolean) => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });

  // Al llegar algo nuevo: si ya estabas abajo, sigue abajo; si estabas leyendo más arriba, no te mueve y avisa.
  useLayoutEffect(() => {
    const key = rows[rows.length - 1]?.key ?? null;
    if (key === lastKey.current) return;
    const first = lastKey.current === null;
    lastKey.current = key;
    if (first || stick.current) {
      toBottom(!first);
      setNewBelow(false);
    } else setNewBelow(true);
  }, [rows, working]);

  // Si cambia el alto del área (teclado, compositor que crece) y estabas abajo, sigues abajo.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom(false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    if (stick.current) setNewBelow(false);
  };

  return (
    <ScreenShell title={title} subtitle={subtitle} tone={tone} onBack={onBack} headerRight={headerRight} footer={footer}>
        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={onScroll} role="log" aria-label="Conversación" aria-live="polite" className="h-full overflow-y-auto overscroll-contain px-3 pb-3 pt-1">
            {banner}
            {hasMore && onLoadOlder && (
              <div className="flex justify-center pt-2">
                <button type="button" onClick={onLoadOlder} className="min-h-[44px] rounded-full px-4 text-[14px] font-semibold text-slate-300 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
                  Ver mensajes anteriores
                </button>
              </div>
            )}

            {error && (
              <div role="alert" className="mt-3 flex items-center gap-3 rounded-2xl border border-expense/50 bg-slate-900 p-3">
                <TriangleAlert size={18} strokeWidth={1.8} className="flex-shrink-0 text-expense" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-sm text-expense">{error}</p>
                <button type="button" onClick={onRetry} className="min-h-[44px] flex-shrink-0 rounded-xl px-3 text-sm font-semibold text-slate-100 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
                  Reintentar
                </button>
              </div>
            )}

            {loading && rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-slate-400" role="status">
                <Loader2 size={22} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <p className="text-sm">Abriendo la conversación…</p>
              </div>
            ) : rows.length === 0 && !error ? (
              empty
            ) : (
              rows.map((row) =>
                row.kind === 'day' ? (
                  <Chip key={row.key} className="mt-5 first:mt-3">{row.label}</Chip>
                ) : (
                  <ChatItem key={row.key} row={row} fetchedAt={fetchedAt} onDecide={onDecide} />
                ),
              )
            )}

            {working && (
              <div className="mt-3 flex justify-start" role="status">
                <p className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 py-1.5 pl-3 pr-3.5 text-[14px] text-slate-300">
                  <span aria-hidden="true" className="flex gap-1">
                    <i className="h-1.5 w-1.5 rounded-full bg-slate-300 motion-safe:animate-pulse" />
                    <i className="h-1.5 w-1.5 rounded-full bg-slate-300 motion-safe:animate-pulse [animation-delay:200ms]" />
                    <i className="h-1.5 w-1.5 rounded-full bg-slate-300 motion-safe:animate-pulse [animation-delay:400ms]" />
                  </span>
                  Claude está trabajando…
                </p>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              toBottom(true);
              setNewBelow(false);
            }}
            tabIndex={newBelow ? 0 : -1}
            aria-hidden={!newBelow}
            className={cn(
              'absolute bottom-3 left-1/2 flex h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-500 bg-slate-900 pl-3.5 pr-4 text-[14px] font-semibold text-slate-100 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 motion-reduce:transition-none',
              newBelow ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            <ArrowDown size={16} strokeWidth={2.2} aria-hidden="true" />
            Mensajes nuevos
          </button>
        </div>

    </ScreenShell>
  );
}
