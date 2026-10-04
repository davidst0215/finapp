import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BellOff, Bell, CalendarDays, Check, CheckCheck, CheckSquare, CreditCard, Hourglass, Mail, Sun, Terminal,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Notice } from './api';
import { formatRelative, isAppPath, kindLabel } from './logic';
import type { InboxStatus } from './useInbox';

const KIND_ICON: Record<string, LucideIcon> = {
  brief: Sun,
  pago: CreditCard,
  tarea: CheckSquare,
  espera: Hourglass,
  agenda: CalendarDays,
  correo: Mail,
  claude: Terminal,
  sistema: Bell,
};

type Props = {
  items: Notice[];
  unread: number;
  status: InboxStatus;
  error: string | null;
  onRetry: () => void;
  onRead: (ids: string[]) => void;
  onReadAll: () => void;
};

// Un aviso sin destino propio (la bandeja misma) se despliega al tocarlo; los demás abren su pantalla.
const destination = (n: Notice) => (isAppPath(n.url) && n.url !== '/avisos' ? n.url : null);

export function NoticeList({ items, unread, status, error, onRetry, onRead, onReadAll }: Props) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const now = new Date();

  const open = (n: Notice) => {
    if (n.readAt === null) onRead([n.id]);
    const to = destination(n);
    if (to) navigate(to);
    else setExpanded((prev) => ({ ...prev, [n.id]: !prev[n.id] }));
  };

  return (
    <section aria-labelledby="avisos-bandeja">
      <div className="mb-2 flex min-h-[44px] items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id="avisos-bandeja" className="text-lg font-bold text-slate-100">
            Bandeja
          </h2>
          <span aria-live="polite">
            {status === 'ready' && unread > 0 && (
              <span className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-0.5 text-sm font-semibold text-slate-200">
                {unread}
                <span className="sr-only"> sin leer</span>
              </span>
            )}
          </span>
        </div>
        {status === 'ready' && unread > 0 && (
          <button
            type="button"
            onClick={onReadAll}
            className="-mr-2 flex min-h-[44px] flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-base font-semibold text-slate-200 active:bg-slate-800"
          >
            <CheckCheck size={18} strokeWidth={1.8} aria-hidden="true" />
            Marcar todo leído
          </button>
        )}
      </div>

      {status === 'loading' && (
        <>
          <ul aria-hidden="true" className="card divide-y divide-slate-700 p-0">
            {[0, 1, 2].map((i) => (
              <li key={i} className="space-y-2.5 px-4 py-4">
                <div className="h-4 w-2/3 rounded bg-slate-800 motion-safe:animate-pulse" />
                <div className="h-4 w-full rounded bg-slate-800 motion-safe:animate-pulse" />
                <div className="h-3.5 w-1/3 rounded bg-slate-800 motion-safe:animate-pulse" />
              </li>
            ))}
          </ul>
          <p role="status" className="sr-only">
            Cargando avisos…
          </p>
        </>
      )}

      {status === 'error' && (
        <div className="card flex flex-col items-start gap-3">
          <p className="text-base font-semibold text-slate-100">No pude cargar los avisos</p>
          <p className="text-base text-slate-300">{error}</p>
          <button type="button" className="btn-secondary min-h-[44px]" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}

      {status === 'ready' && items.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-10 text-center">
          <BellOff size={28} strokeWidth={1.6} className="text-slate-400" aria-hidden="true" />
          <p className="text-base font-semibold text-slate-100">Aún no tienes avisos</p>
          <p className="max-w-[32ch] text-base text-slate-300">
            Cuando haya algo que decirte (el brief de la mañana, un pago por vencer, una tarea) aparecerá aquí.
          </p>
        </div>
      )}

      {status === 'ready' && items.length > 0 && (
        <ul className="card divide-y divide-slate-700 overflow-hidden p-0">
          {items.map((n) => {
            const isUnread = n.readAt === null;
            const Icon = KIND_ICON[n.kind] ?? Bell;
            const to = destination(n);
            const isOpen = !!expanded[n.id];
            return (
              <li key={n.id} className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => open(n)}
                  aria-expanded={to ? undefined : isOpen}
                  className="min-w-0 flex-1 px-4 py-3.5 text-left active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                >
                  <span className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className={cn('mt-2 h-2 w-2 flex-shrink-0 rounded-full', isUnread ? 'bg-primary-500' : 'bg-transparent')}
                    />
                    <span className="min-w-0 flex-1">
                      {isUnread && <span className="sr-only">Sin leer. </span>}
                      <span className={cn('block break-words text-base', isUnread ? 'font-bold text-slate-100' : 'font-medium text-slate-300')}>
                        {n.title}
                      </span>
                      {n.body && (
                        <span
                          className={cn(
                            'mt-0.5 block whitespace-pre-line break-words text-base',
                            !isOpen && 'line-clamp-2',
                            isUnread ? 'text-slate-300' : 'text-slate-400',
                          )}
                        >
                          {n.body}
                        </span>
                      )}
                      <span className="mt-1.5 flex items-center gap-1.5 text-sm text-slate-400">
                        <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
                        {kindLabel(n.kind)}
                        <span aria-hidden="true">·</span>
                        <time dateTime={n.createdAt}>{formatRelative(n.createdAt, now)}</time>
                      </span>
                    </span>
                  </span>
                </button>
                {isUnread && (
                  <button
                    type="button"
                    aria-label={`Marcar como leído: ${n.title}`}
                    onClick={() => onRead([n.id])}
                    className="flex w-12 flex-shrink-0 items-center justify-center text-slate-400 active:bg-slate-800 active:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                  >
                    <Check size={20} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
