import { Info, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { caracteres, fechaCorta, horaLima, textoProyeccion, UMBRAL_BAJO_USD, usd } from './format';
import type { Saldo, SaldoVoz } from './types';
import { useSaldo } from './useSaldo';

const tarjeta = 'rounded-xl border border-slate-700 bg-slate-900';
const botonTexto =
  'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-300 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50';

function Voz({ voz }: { voz: SaldoVoz }) {
  if (voz.estado === 'ok') {
    return (
      <div>
        <p className="text-sm font-medium text-slate-100">Voz · {caracteres(voz.usados, voz.limite)}</p>
        {voz.renueva && <p className="mt-0.5 text-xs text-slate-500">Se renueva el {fechaCorta(voz.renueva)}</p>}
      </div>
    );
  }
  // Sin permiso o sin llave no es una falla del saldo: se explica con calma, en gris. Solo un error real va en rojo.
  const esError = voz.estado === 'error';
  return (
    <div className="flex items-start gap-2">
      <Info size={15} strokeWidth={1.8} className={cn('mt-0.5 flex-shrink-0', esError ? 'text-expense' : 'text-slate-500')} aria-hidden />
      <p className={cn('text-sm', esError ? 'text-expense' : 'text-slate-400')}>{voz.mensaje}</p>
    </div>
  );
}

function Cuerpo({ saldo }: { saldo: Saldo }) {
  const o = saldo.openrouter;
  if (o.estado === 'error') {
    return <p className="text-sm text-expense">{o.mensaje}</p>;
  }
  const bajo = o.restante < UMBRAL_BAJO_USD;
  return (
    <>
      <p className="text-sm text-slate-400">Te quedan en OpenRouter</p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className={cn('text-4xl font-bold tabular-nums', bajo ? 'text-expense' : 'text-slate-100')}>{usd(o.restante)}</span>
        <span className="text-sm tabular-nums text-slate-500">de {usd(o.credito)}</span>
      </p>
      <p className={cn('mt-1.5 text-sm', bajo ? 'font-medium text-expense' : 'text-slate-300')}>
        {bajo && o.proyeccion.tipo !== 'agotado' ? 'Queda poco: conviene recargar. ' : ''}
        {textoProyeccion(o.proyeccion)}
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-800 pt-3">
        {([['Hoy', o.hoy], ['Semana', o.semana], ['Mes', o.mes]] as const).map(([etiqueta, valor]) => (
          <div key={etiqueta}>
            <dt className="text-xs text-slate-500">{etiqueta}</dt>
            <dd className="mt-0.5 text-base font-bold tabular-nums text-slate-100">{usd(valor)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** Sección "Saldo de IA" de la pantalla Más: lo que queda en OpenRouter y el consumo de la voz (ElevenLabs). */
export function SaldoIA() {
  const { saldo, cargando, error, recargar } = useSaldo();

  if (!saldo) {
    // Primera carga o falla sin datos previos.
    return (
      <div className={cn(tarjeta, 'p-4')} aria-busy={cargando}>
        {error ? (
          <>
            <p role="alert" className="text-sm text-expense">{error}</p>
            <button type="button" onClick={() => void recargar()} disabled={cargando} className={cn(botonTexto, '-ml-2 mt-1')}>
              <RefreshCw size={15} strokeWidth={1.8} aria-hidden /> Reintentar
            </button>
          </>
        ) : (
          <div role="status" aria-label="Cargando saldo">
            <div className="h-4 w-36 rounded bg-slate-800" />
            <div className="mt-3 h-9 w-44 rounded bg-slate-800" />
            <div className="mt-3 h-4 w-56 rounded bg-slate-800" />
            <p className="mt-4 text-xs text-slate-500">Consultando OpenRouter y ElevenLabs…</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={tarjeta}>
      <div className="p-4">
        <Cuerpo saldo={saldo} />
      </div>
      <div className="border-t border-slate-800 p-4">
        <Voz voz={saldo.elevenlabs} />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-800 py-0.5 pl-4 pr-2">
        <p className={cn('text-xs', error ? 'text-expense' : 'text-slate-500')} role={error ? 'alert' : undefined}>
          {error ? 'No pude actualizar. Mostrando lo último.' : `Actualizado a las ${horaLima(saldo.actualizado)}`}
        </p>
        <button type="button" onClick={() => void recargar()} disabled={cargando} className={botonTexto}>
          <RefreshCw size={15} strokeWidth={1.8} className={cargando ? 'animate-spin' : undefined} aria-hidden />
          {cargando ? 'Actualizando' : error ? 'Reintentar' : 'Actualizar'}
        </button>
      </div>
    </div>
  );
}
