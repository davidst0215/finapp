import { useState } from 'react';
import { Check, CheckCheck, Clock, Laptop, ListTodo, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { deliveryOf, type Row } from './chatModel';
import { limaClock } from './format';
import { PermissionMessage } from './PermissionMessage';
import type { ApprovalView, Decision, TimelineItem } from './types';

interface Props {
  row: Extract<Row, { kind: 'item' }>;
  fetchedAt: number;
  onDecide: (approvalId: string, decision: Decision) => Promise<boolean>;
}

const CLAMP_CHARS = 700;
const CLAMP_LINES = 12;

// Una fila del chat. David a la derecha, Claude a la izquierda, el sistema (inicio, fin, permisos resueltos) en chips centrados.
export function ChatItem({ row, fetchedAt, onDecide }: Props) {
  const { item, groupStart, groupEnd } = row;
  // Poca separación dentro de un grupo; más entre grupos.
  const spacing = groupStart ? 'mt-3' : 'mt-1';

  switch (item.type) {
    case 'system':
      return <Chip className="mt-3">{item.text}</Chip>;
    case 'approval':
      return item.approval.status === 'pendiente' ? (
        <div className="mt-3 flex justify-start">
          <PermissionMessage approval={item.approval} fetchedAt={fetchedAt} onDecide={onDecide} />
        </div>
      ) : (
        <ApprovalChip approval={item.approval} />
      );
    case 'user':
      return <UserBubble item={item} spacing={spacing} showMeta={groupEnd} />;
    case 'claude':
      return <ClaudeBubble item={item} spacing={spacing} showMeta={groupEnd} />;
  }
}

export function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex justify-center px-6', className)}>
      <p className="max-w-full rounded-full bg-slate-800 px-3 py-1 text-center text-[13px] leading-snug text-slate-300">{children}</p>
    </div>
  );
}

const APPROVAL_WORDS: Record<Exclude<ApprovalView['status'], 'pendiente'>, { verb: string; Icon: typeof Check }> = {
  aprobada: { verb: 'Aprobaste', Icon: Check },
  denegada: { verb: 'Rechazaste', Icon: X },
  vencida: { verb: 'Venció sin respuesta', Icon: Clock },
};

function ApprovalChip({ approval }: { approval: ApprovalView }) {
  if (approval.status === 'pendiente') return null;
  const { verb, Icon } = APPROVAL_WORDS[approval.status];
  return (
    <div className="mt-3 flex justify-center px-4">
      <p className="flex max-w-full items-center gap-1.5 rounded-full bg-slate-800 py-1 pl-2.5 pr-3 text-[13px] text-slate-300">
        <Icon size={14} strokeWidth={2.2} className="flex-shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {verb}: <span className="font-mono">{approval.preview.split('\n')[0]}</span>
        </span>
      </p>
    </div>
  );
}

type UserItem = Extract<TimelineItem, { type: 'user' }>;
type ClaudeItem = Extract<TimelineItem, { type: 'claude' }>;

function UserBubble({ item, spacing, showMeta }: { item: UserItem; spacing: string; showMeta: boolean }) {
  const delivery = item.source === 'phone' && item.delivery ? deliveryOf(item.delivery) : null;
  return (
    <div className={cn('flex flex-col items-end', spacing)}>
      <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-slate-700 px-3.5 py-2.5 text-base leading-relaxed text-slate-100">
        {item.text ?? <span className="italic text-slate-300">Mensaje enviado desde el celular</span>}
      </div>
      {showMeta && (
        <p className="mt-1 flex items-center gap-1.5 text-[13px] text-slate-400">
          {item.source === 'laptop' && (
            <>
              <Laptop size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>desde la laptop</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          {item.source === 'task' && (
            <>
              <ListTodo size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>tarea</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <time dateTime={item.at} className="tabular-nums">{limaClock(item.at)}</time>
          {delivery && (
            <>
              <span aria-hidden="true">·</span>
              {delivery.ticks === 2 ? <CheckCheck size={16} strokeWidth={2} aria-hidden="true" /> : delivery.ticks === 1 ? <Check size={16} strokeWidth={2} aria-hidden="true" /> : <Clock size={14} aria-hidden="true" />}
              <span className={cn(delivery.ticks === 2 && 'text-slate-200')}>{delivery.label}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function ClaudeBubble({ item, spacing, showMeta }: { item: ClaudeItem; spacing: string; showMeta: boolean }) {
  const [open, setOpen] = useState(false);
  const long = item.text.length > CLAMP_CHARS || item.text.split('\n').length > CLAMP_LINES;
  const error = item.tone === 'error';
  return (
    <div className={cn('flex flex-col items-start', spacing)}>
      <div
        className={cn(
          'max-w-[90%] rounded-2xl rounded-bl-md border px-3.5 py-2.5',
          error ? 'border-expense/60 bg-slate-900' : item.tone === 'notice' ? 'border-dashed border-slate-600 bg-slate-950' : 'border-slate-700 bg-slate-900',
        )}
      >
        {error && (
          <p className="mb-1 flex items-center gap-1.5 text-[13px] font-bold text-expense">
            <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" /> Claude falló
          </p>
        )}
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-base leading-relaxed',
            error ? 'text-expense' : item.tone === 'notice' ? 'text-slate-300' : 'text-slate-100',
            long && !open && 'line-clamp-[12]',
          )}
        >
          {item.text}
        </p>
        {long && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="-mb-1 mt-1 min-h-[44px] pr-2 text-[14px] font-semibold text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            {open ? 'Ver menos' : 'Ver todo'}
          </button>
        )}
      </div>
      {showMeta && (
        <time dateTime={item.at} className="mt-1 text-[13px] tabular-nums text-slate-400">
          {limaClock(item.at)}
        </time>
      )}
    </div>
  );
}
