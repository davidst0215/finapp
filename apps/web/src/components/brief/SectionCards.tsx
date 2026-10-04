import type { ReactNode } from 'react';
import { CalendarDays, CheckSquare, Hourglass, Wallet, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MESES } from '@/components/google/lima';
import type { Estado, Secciones } from './types';

export const soles = (n: number) => `S/ ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

function cuando(dias: number): string {
  if (dias < 0) return `Vencido hace ${plural(-dias, 'día', 'días')}`;
  if (dias === 0) return 'Hoy';
  if (dias === 1) return 'Mañana';
  return `En ${dias} días`;
}

const fechaCorta = (iso: string) => {
  const [, m = 1, d = 1] = iso.split('-').map(Number);
  return `${d} de ${MESES[m - 1]}`;
};

function Card({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <h2 className="mb-1 flex min-h-[44px] items-center gap-2 text-lg font-bold text-slate-100">
        <Icon size={20} strokeWidth={1.8} aria-hidden="true" className="flex-none text-slate-300" />
        {title}
      </h2>
      <div className="divide-y divide-slate-800">{children}</div>
    </section>
  );
}

function Row({ title, sub, trailing, alarm }: { title: string; sub?: string; trailing?: ReactNode; alarm?: boolean }) {
  return (
    <div className="flex min-h-[44px] items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className={cn('text-base font-semibold leading-snug text-slate-100', alarm && 'text-expense')}>{title}</div>
        {sub && <div className={cn('text-sm leading-snug text-slate-400', alarm && 'text-expense')}>{sub}</div>}
      </div>
      {trailing}
    </div>
  );
}

const Amount = ({ value, alarm }: { value: number; alarm?: boolean }) => (
  <span className={cn('flex-none text-base font-bold tabular-nums text-slate-100', alarm && 'text-expense')}>{soles(value)}</span>
);

function Badge({ children, alarm }: { children: ReactNode; alarm?: boolean }) {
  return (
    <span
      className={cn(
        'flex-none rounded-full border px-2.5 py-0.5 text-sm font-semibold tabular-nums',
        alarm ? 'border-expense/50 text-expense' : 'border-slate-700 bg-slate-800 text-slate-200',
      )}
    >
      {children}
    </span>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="py-3 text-base text-slate-400">{children}</p>;

/** Una fuente caída o sin conectar se dice en su tarjeta; el resto del brief sigue. */
function Unavailable({ estado, mensaje, fallback }: { estado: Estado; mensaje: string | null; fallback: string }) {
  return (
    <Note>
      {mensaje ?? fallback}
      {estado === 'no_conectado' ? ' Conéctalo desde Agenda.' : ''}
    </Note>
  );
}

const More = ({ extra }: { extra: number }) => (extra > 0 ? <p className="py-2 text-sm text-slate-400">y {extra} más</p> : null);

export function SectionCards({ s }: { s: Secciones }) {
  const { agenda, tareas, dinero, esperas } = s;

  return (
    <div className="space-y-4">
      <Card icon={CalendarDays} title="Agenda">
        {agenda.estado !== 'ok' ? (
          <Unavailable estado={agenda.estado} mensaje={agenda.mensaje} fallback="No pude leer tu agenda." />
        ) : agenda.eventos.length === 0 ? (
          <Note>Tu agenda de hoy está libre.</Note>
        ) : (
          agenda.eventos.map((e, i) => (
            <Row
              key={`${e.hora}-${e.titulo}-${i}`}
              title={e.titulo}
              sub={e.todo_dia ? 'Todo el día' : undefined}
              trailing={e.todo_dia ? undefined : <span className="flex-none text-base font-bold tabular-nums text-slate-200">{e.hora}</span>}
            />
          ))
        )}
      </Card>

      <Card icon={Wallet} title="Dinero">
        {dinero.gastado_mes !== null && (
          <Row
            title={`Gastado en ${dinero.mes}`}
            sub={`${dinero.dia_del_mes} de ${dinero.dias_del_mes} días`}
            trailing={<Amount value={dinero.gastado_mes} />}
          />
        )}
        {dinero.pagos.map((p, i) => (
          <Row
            key={`${p.descripcion}-${i}`}
            title={p.descripcion}
            sub={`${cuando(p.dias)} · ${fechaCorta(p.fecha)}`}
            alarm={p.dias < 0}
            trailing={<Amount value={p.monto} alarm={p.dias < 0} />}
          />
        ))}
        {dinero.estado === 'error' && <Note>{dinero.mensaje ?? 'No pude leer tus finanzas.'}</Note>}
        {dinero.estado === 'ok' && dinero.pagos.length === 0 && <Note>Sin pagos en los próximos 7 días.</Note>}
      </Card>

      <Card icon={CheckSquare} title="Tareas">
        {tareas.estado !== 'ok' ? (
          <Unavailable estado={tareas.estado} mensaje={tareas.mensaje} fallback="No pude leer tus tareas." />
        ) : tareas.vencidas_total === 0 && tareas.hoy_total === 0 ? (
          <Note>Sin tareas vencidas ni para hoy.</Note>
        ) : (
          <>
            {tareas.vencidas.map((t, i) => (
              <Row
                key={`v-${t.texto}-${i}`}
                title={t.texto}
                sub={`Venció hace ${plural(t.dias, 'día', 'días')}`}
                alarm
                trailing={<Badge alarm>{t.dias} d</Badge>}
              />
            ))}
            <More extra={tareas.vencidas_total - tareas.vencidas.length} />
            {tareas.hoy.map((t, i) => (
              <Row key={`h-${t.texto}-${i}`} title={t.texto} sub="Para hoy" />
            ))}
            <More extra={tareas.hoy_total - tareas.hoy.length} />
          </>
        )}
      </Card>

      <Card icon={Hourglass} title="Esperas">
        {esperas.estado !== 'ok' ? (
          <Unavailable estado={esperas.estado} mensaje={esperas.mensaje} fallback="No pude leer tus esperas." />
        ) : esperas.items.length === 0 ? (
          <Note>Nadie te debe nada con más de 3 días.</Note>
        ) : (
          <>
            {esperas.items.map((e, i) => (
              <Row
                key={`${e.con}-${e.texto}-${i}`}
                title={`${e.con} — ${e.texto}`}
                trailing={e.dias === null ? undefined : <Badge>{e.dias} d</Badge>}
              />
            ))}
            <More extra={esperas.total - esperas.items.length} />
          </>
        )}
      </Card>
    </div>
  );
}
