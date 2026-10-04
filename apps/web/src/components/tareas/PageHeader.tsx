import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  /** Línea pequeña bajo el título (estado de sincronización). */
  sub?: ReactNode;
  /** Acción a la derecha, alineada con la fila del título. */
  action?: ReactNode;
}

/** Cabecera de las pantallas de módulo: título de 24 px y una acción redonda a la derecha. */
export function PageHeader({ title, sub, action }: PageHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex h-11 items-center text-2xl font-bold tracking-tight">{title}</h1>
        {sub}
      </div>
      {action}
    </header>
  );
}
