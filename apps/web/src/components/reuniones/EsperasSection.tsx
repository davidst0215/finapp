import { ExternalLink, Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Espera, EsperasRespuesta } from './api';
import { diasTexto, enlaceSeguro } from './formato';

function EsperaFila({ espera }: { espera: Espera }) {
  const enlace = enlaceSeguro(espera.enlace);
  return (
    <li className="py-3 first:pt-0 last:pb-0 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{espera.quien}</p>
          <p className="text-sm text-slate-100 break-words">{espera.texto}</p>
          {espera.reunion && <p className="text-xs text-slate-400 mt-0.5 break-words">{espera.reunion}</p>}
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold tabular-nums',
            espera.vencida ? 'border-expense/50 bg-expense/10 text-expense' : 'border-slate-600 text-slate-300',
          )}
          aria-label={espera.vencida ? `Vencida, ${diasTexto(espera.dias)}` : diasTexto(espera.dias)}
        >
          {diasTexto(espera.dias)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {/* Lo conectará el módulo de correo. */}
        <button type="button" disabled className="min-h-[44px] rounded-xl border border-slate-700 px-3 text-sm font-semibold text-slate-400 opacity-60">
          Redactar recordatorio · pronto
        </button>
        {enlace && (
          <a
            href={enlace}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Abrir grabación"
            className="w-11 h-11 flex items-center justify-center rounded-xl text-slate-400 active:bg-slate-800"
          >
            <ExternalLink size={18} />
          </a>
        )}
      </div>
    </li>
  );
}

export function EsperasSection({ datos, cargando }: { datos: EsperasRespuesta | null; cargando: boolean }) {
  return (
    <section className="space-y-3" aria-labelledby="esperas-titulo">
      <h2 id="esperas-titulo" className="flex items-center gap-2 text-lg font-bold">
        <Hourglass size={18} className="text-slate-400" />
        Esperando de otros
        {datos?.ok && datos.esperas.length > 0 && <span className="text-sm font-semibold text-slate-400">({datos.esperas.length})</span>}
      </h2>

      {cargando && !datos ? (
        <div className="card h-20 animate-pulse" aria-busy="true" />
      ) : !datos ? null : !datos.ok ? (
        <div className="card">
          <p className="text-sm text-slate-300">{datos.mensaje}</p>
        </div>
      ) : datos.esperas.length === 0 ? (
        <div className="card">
          <p className="text-sm text-slate-300">No estás esperando nada de nadie.</p>
        </div>
      ) : (
        <div className="card">
          <ul className="divide-y divide-slate-700">
            {datos.esperas.map((e) => <EsperaFila key={e.clave} espera={e} />)}
          </ul>
        </div>
      )}
    </section>
  );
}
