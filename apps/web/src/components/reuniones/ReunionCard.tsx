import { useState } from 'react';
import { ChevronDown, ExternalLink, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Reunion } from './api';
import { bloquesResumen, duracion, enlaceSeguro, fechaReunion } from './formato';

const BLOQUES_VISIBLES = 4;

export function ReunionCard({ reunion }: { reunion: Reunion }) {
  const [abierta, setAbierta] = useState(false);
  const bloques = bloquesResumen(reunion.resumen);
  const hayMas = bloques.length > BLOQUES_VISIBLES;
  const visibles = abierta ? bloques : bloques.slice(0, BLOQUES_VISIBLES);
  const dur = duracion(reunion.duracion_min);
  const enlace = enlaceSeguro(reunion.share_url);
  const abiertos = reunion.action_items.filter((a) => !a.hecho);
  const externos = reunion.invitados.filter((i) => i.externo).length;

  return (
    <article className="card space-y-3">
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-bold text-slate-100 break-words min-w-0">{reunion.titulo}</h3>
          {enlace && (
            <a
              href={enlace}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Abrir grabación en Fathom"
              className="shrink-0 -mt-2 -mr-2 w-11 h-11 flex items-center justify-center rounded-xl text-slate-400 active:bg-slate-800"
            >
              <ExternalLink size={18} />
            </a>
          )}
        </div>
        <p className="text-sm text-slate-400">
          {fechaReunion(reunion.inicio)}
          {dur && ` · ${dur}`}
        </p>
        {reunion.invitados.length > 0 && (
          <p className="flex items-center gap-1.5 text-sm text-slate-400 min-w-0">
            <Users size={14} className="shrink-0" />
            <span className="truncate">
              {reunion.invitados.slice(0, 3).map((i) => i.name || i.email).join(', ')}
              {reunion.invitados.length > 3 && ` y ${reunion.invitados.length - 3} más`}
              {externos > 0 && ` · ${externos} ${externos === 1 ? 'externo' : 'externos'}`}
            </span>
          </p>
        )}
      </header>

      {bloques.length === 0 ? (
        <p className="text-sm text-slate-400">Fathom todavía no generó el resumen.</p>
      ) : (
        <div className="space-y-1.5">
          {visibles.map((b, i) =>
            b.tipo === 'titulo' ? (
              <p key={i} className="pt-1 text-xs font-bold uppercase tracking-wide text-slate-400">{b.texto}</p>
            ) : b.tipo === 'punto' ? (
              <p key={i} className="text-sm text-slate-200 pl-4 relative before:content-['–'] before:absolute before:left-0 before:text-slate-400">{b.texto}</p>
            ) : (
              <p key={i} className="text-sm text-slate-200">{b.texto}</p>
            ),
          )}
          {hayMas && (
            <button
              type="button"
              onClick={() => setAbierta((v) => !v)}
              aria-expanded={abierta}
              className="min-h-[44px] -ml-1 px-1 flex items-center gap-1 text-sm font-semibold text-slate-300 active:text-slate-100"
            >
              {abierta ? 'Ver menos' : 'Ver más'}
              <ChevronDown size={16} className={cn('transition-transform', abierta && 'rotate-180')} />
            </button>
          )}
        </div>
      )}

      {abiertos.length > 0 && (
        <div className="border-t border-slate-700 pt-3 space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Acuerdos ({abiertos.length})</p>
          <ul className="space-y-2">
            {abiertos.map((a, i) => (
              <li key={i} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-slate-200 min-w-0 break-words">{a.texto}</span>
                {a.dueno && (
                  <span className="shrink-0 rounded-full border border-slate-600 px-2.5 py-0.5 text-xs font-semibold text-slate-300">{a.dueno}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
