import { Link } from 'react-router-dom';
import { MessageSquare, Plus, ShieldQuestion, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Conversation } from './conversations';
import { buildConversations, laptopLine } from './conversations';
import { listTime } from './format';
import { StateDot } from './StateDot';
import type { Overview } from './types';
import { useNow } from './useTick';

interface Props {
  overview: Overview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const initials = (title: string) => {
  const words = title.replace(/[^\p{L}\p{N} ·_-]/gu, '').split(/[\s·_-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words[1]?.[0] ?? '') : '')).toUpperCase();
};

// Lista de conversaciones: cada sesión de Claude Code es un chat. Lo que te necesita sube y se lee de un vistazo.
export function ConversationList({ overview, loading, error, onRetry }: Props) {
  const now = useNow(30_000);
  const conversations = overview ? buildConversations(overview, now) : [];
  const devices = overview?.devices ?? [];

  return (
    <div className="space-y-4 pb-24">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-bold">Claude Code</h1>
          <p className="truncate text-[13px] text-slate-400">{overview ? laptopLine(devices, now) : 'Cargando…'}</p>
        </div>
        <Link
          to="/claude/ajustes"
          aria-label="Ajustes de Claude Code"
          className="-mr-2 mt-0.5 grid h-11 w-11 flex-shrink-0 place-items-center rounded-full text-slate-300 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <SlidersHorizontal size={22} strokeWidth={1.7} aria-hidden="true" />
        </Link>
      </header>

      {error && (
        <div role="alert" className="card flex items-center gap-3 border-expense/50">
          <TriangleAlert size={20} strokeWidth={1.7} className="flex-shrink-0 text-expense" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-expense">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-[44px] flex-shrink-0 rounded-xl px-3 text-sm font-semibold text-slate-100 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            Reintentar
          </button>
        </div>
      )}

      {loading && !overview ? (
        <SkeletonRows />
      ) : overview && devices.length === 0 ? (
        <ConnectLaptop />
      ) : overview && conversations.length === 0 ? (
        <EmptyConversations />
      ) : (
        <ul aria-label="Conversaciones" className="-mx-4 divide-y divide-slate-800 border-y border-slate-800">
          {conversations.map((c) => (
            <li key={c.key}>
              <Row conversation={c} now={now} />
            </li>
          ))}
        </ul>
      )}

      {/* Acción principal: siempre a un toque. Un contenedor del ancho de la app para que en pantallas anchas no se vaya al borde. */}
      <div
        className="pointer-events-none fixed inset-x-0 z-30 mx-auto flex max-w-lg justify-end px-4"
        style={{ bottom: 'calc(4.5rem + env(safe-area-inset-bottom))' }}
      >
        <Link
          to="/claude/nueva"
          className="pointer-events-auto flex h-12 items-center gap-2 rounded-full bg-primary-600 pl-4 pr-5 text-base font-semibold text-slate-950 active:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
        >
          <Plus size={20} strokeWidth={2.2} aria-hidden="true" />
          Nueva tarea
        </Link>
      </div>
    </div>
  );
}

function Row({ conversation: c, now }: { conversation: Conversation; now: number }) {
  const asking = c.status.tone === 'asking';
  return (
    <Link
      to={c.path}
      className="flex min-h-[76px] items-start gap-3 px-4 py-3 active:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
    >
      <span className="relative mt-0.5 grid h-12 w-12 flex-shrink-0 place-items-center rounded-full border border-slate-700 bg-slate-800 text-base font-bold text-slate-200" aria-hidden="true">
        {initials(c.title)}
        <span className="absolute -bottom-0.5 -right-0.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-slate-950">
          <StateDot tone={c.status.tone} className="h-3 w-3" />
        </span>
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-base font-semibold text-slate-100">{c.title}</span>
          <time dateTime={c.at} className={cn('flex-shrink-0 text-[13px] tabular-nums', asking ? 'font-bold text-slate-100' : 'text-slate-400')}>
            {listTime(c.at, now)}
          </time>
        </span>
        <span className="mt-0.5 block truncate text-[15px] leading-snug text-slate-300">
          {c.previewRole === 'usuario' && <span className="text-slate-400">Tú: </span>}
          {c.preview}
        </span>
        <span className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 truncate text-[13px]',
              c.status.tone === 'error' ? 'text-expense' : asking ? 'font-bold text-slate-100' : c.status.tone === 'active' ? 'font-semibold text-slate-200' : 'text-slate-400',
            )}
          >
            {c.status.label}
          </span>
          {c.isTask && (
            <span className="flex-shrink-0 rounded-full border border-slate-600 px-2 text-[12px] font-semibold leading-5 text-slate-300">tarea</span>
          )}
          {c.pending > 0 && (
            <span className="ml-auto flex h-6 flex-shrink-0 items-center gap-1 rounded-full bg-primary-600 pl-1.5 pr-2.5 text-[13px] font-bold text-slate-950">
              <ShieldQuestion size={15} strokeWidth={2} aria-hidden="true" />
              {c.pending > 1 ? `${c.pending} permisos` : 'Permiso'}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

function SkeletonRows() {
  return (
    <ul aria-label="Cargando conversaciones" aria-busy="true" className="-mx-4 divide-y divide-slate-800 border-y border-slate-800">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex min-h-[76px] items-start gap-3 px-4 py-3">
          <span className="mt-0.5 h-12 w-12 flex-shrink-0 rounded-full bg-slate-800 motion-safe:animate-pulse" />
          <span className="flex-1 space-y-2.5 pt-1">
            <span className="block h-4 w-2/5 rounded-full bg-slate-800 motion-safe:animate-pulse" />
            <span className="block h-3.5 w-4/5 rounded-full bg-slate-800 motion-safe:animate-pulse" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function ConnectLaptop() {
  return (
    <section className="card space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-bold text-slate-100">Conecta tu laptop</h2>
        <p className="text-sm text-slate-300">
          Verás tus sesiones de Claude Code como chats en el celular, podrás aprobar permisos y escribirle a Claude cuando te alejes. Todo va
          de tu laptop a tu cuenta de Wabid: nada pasa por claude.ai.
        </p>
      </div>
      <Link to="/claude/ajustes" className="btn-primary flex min-h-[48px] w-full items-center justify-center">
        Conectar esta laptop
      </Link>
    </section>
  );
}

function EmptyConversations() {
  return (
    <section className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full border border-slate-700 bg-slate-900 text-slate-300">
        <MessageSquare size={26} strokeWidth={1.6} aria-hidden="true" />
      </span>
      <h2 className="text-base font-bold text-slate-100">Aún no hay conversaciones</h2>
      <p className="max-w-xs text-sm text-slate-300">
        Abre Claude Code en tu laptop y la conversación aparecerá aquí. O toca «Nueva tarea» y Claude trabaja por ti.
      </p>
    </section>
  );
}
