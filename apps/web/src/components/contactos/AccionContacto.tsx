import { useState } from 'react';
import { MessageCircle, Phone, X } from 'lucide-react';
import type { AccionContacto as Accion } from '@/lib/accionContacto';

interface Props {
  accion: Accion;
  onCerrar: () => void;
}

const ring = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900';
const grande = `flex min-h-14 flex-1 items-center justify-center gap-2.5 rounded-xl px-4 text-[17px] font-bold transition-colors ${ring}`;
const principal = `${grande} bg-primary-600 text-slate-950 active:bg-primary-700`;
const secundario = `${grande} border border-slate-700 bg-slate-800 text-slate-200 active:bg-slate-700`;

// WhatsApp se abre en otra pestaña/app; el marcador (tel:) reemplaza la vista y no necesita destino.
const destinoWhatsapp = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * El botón grande que acompaña a "Escríbele a Marco…" o "Llama a Marco". El navegador exige un toque del usuario para abrir otra
 * app, así que Wabid no abre nada sola: deja el enlace listo y David toca. Queda a la vista mientras habla Wabid y mientras el
 * micrófono vuelve a escuchar (modo conversación), hasta que se cierra o empieza otro pedido (quien lo monta le cambia la `key`).
 * Tras tocarlo pasa a un botón secundario ("Abrir otra vez"): si WhatsApp no llegó a abrirse se puede reintentar, y si ya se
 * envió el mensaje, el botón principal no invita a enviarlo dos veces.
 * Las URL llegan ya validadas por `accionSegura`; aquí solo se pintan.
 */
export function AccionContacto({ accion, onCerrar }: Props) {
  const [abierta, setAbierta] = useState(false);
  const estilo = abierta ? secundario : principal;
  const titulo = accion.tipo === 'whatsapp' ? `WhatsApp para ${accion.contacto}` : accion.tipo === 'llamar' ? `Llamar a ${accion.contacto}` : accion.contacto;

  return (
    <section aria-label="Acción lista" className="card mb-3 space-y-3 p-4 motion-safe:animate-slide-up">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-lg font-bold leading-snug text-slate-100">{titulo}</h2>
          {accion.relacion && <p className="break-words text-[14px] leading-snug text-slate-300">{accion.relacion}</p>}
        </div>
        <button
          type="button"
          onClick={onCerrar}
          aria-label="Cerrar"
          className={`-mr-2 -mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-400 active:bg-slate-800 ${ring}`}
        >
          <X size={20} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {accion.tipo === 'whatsapp' && accion.texto && (
        <p className="whitespace-pre-line break-words rounded-xl bg-slate-800 px-4 py-3 text-base leading-snug text-slate-100">{accion.texto}</p>
      )}
      {accion.tipo !== 'whatsapp' && <p className="text-xl font-bold tabular-nums text-slate-100">{accion.numero}</p>}

      <div className="flex gap-3">
        {accion.tipo === 'whatsapp' && (
          <a href={accion.url} {...destinoWhatsapp} onClick={() => setAbierta(true)} className={estilo}>
            <MessageCircle size={22} strokeWidth={1.9} aria-hidden="true" />
            {abierta ? 'Abrir otra vez' : 'Abrir WhatsApp'}
          </a>
        )}
        {accion.tipo === 'llamar' && (
          <a href={accion.url} onClick={() => setAbierta(true)} className={estilo}>
            <Phone size={22} strokeWidth={1.9} aria-hidden="true" />
            {abierta ? 'Llamar otra vez' : 'Llamar'}
          </a>
        )}
        {accion.tipo === 'numero' && (
          <>
            <a href={accion.url} className={principal}>
              <Phone size={22} strokeWidth={1.9} aria-hidden="true" />
              Llamar
            </a>
            <a href={accion.urlWhatsapp} {...destinoWhatsapp} className={secundario}>
              <MessageCircle size={22} strokeWidth={1.9} aria-hidden="true" />
              WhatsApp
            </a>
          </>
        )}
      </div>
    </section>
  );
}
