import { Fragment, type ReactNode } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VaultTask } from './types';

interface TaskMetaProps {
  task: VaultTask;
  /** Incluye el detalle (nota) como último tramo, que es el primero en recortarse. */
  withNote?: boolean;
  /** Sin recorte a una línea: para la fila expandida. */
  wrap?: boolean;
}

const STATUS_LABEL: Partial<Record<VaultTask['status'], string>> = {
  'in-progress': 'En curso',
  'need-help': 'Necesita ayuda',
  failed: 'Fallida',
};

function Separator() {
  return (
    <>
      <span aria-hidden="true">{' · '}</span>
      <span className="sr-only">, </span>
    </>
  );
}

/**
 * Subtítulo de la fila: estado · fecha · con quién se comparte · nota. En ese orden, de lo más a lo menos
 * urgente, para que si falta ancho se recorte primero la nota. Solo el vencimiento atrasado va en rojo.
 */
export function TaskMeta({ task, withNote = false, wrap = false }: TaskMetaProps) {
  const done = task.status === 'completed';
  const parts: { key: string; node: ReactNode }[] = [];

  const status = STATUS_LABEL[task.status];
  if (status) parts.push({ key: 'status', node: status });

  if (task.dueLabel) {
    parts.push({
      key: 'due',
      node: <span className={cn(task.overdue && !done && 'font-semibold text-expense')}>{task.dueLabel}</span>,
    });
  }

  if (task.shared) {
    parts.push({
      key: 'shared',
      // Icono en línea (no inline-flex): así comparte línea base con el resto del subtítulo.
      node: (
        <>
          <ArrowLeftRight aria-hidden="true" size={13} className="mr-1 inline-block align-[-2px]" />
          {task.sharedWith ? `con ${task.sharedWith}` : 'en conjunto'}
        </>
      ),
    });
  }

  if (withNote && task.note) parts.push({ key: 'note', node: task.note });

  if (parts.length === 0) return null;

  return (
    <span className={cn('mt-0.5 block text-[13px] leading-snug text-slate-400', !wrap && 'truncate')}>
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i > 0 && <Separator />}
          {part.node}
        </Fragment>
      ))}
    </span>
  );
}
