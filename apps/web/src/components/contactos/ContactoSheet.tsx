import { useId, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Sheet } from '@/components/tareas/Sheet';
import { formatearTelefono, normalizarTelefono } from '@/lib/telefono';
import { MAX_NOMBRE, MAX_RELACION, validarBorrador, type Borrador, type Contacto, type Errores, type Valores } from '@/lib/contactos';
import type { Resultado } from './useContactos';

interface Props {
  /** `null` = contacto nuevo. */
  contacto: Contacto | null;
  onClose: () => void;
  onSave: (valores: Valores) => Promise<Resultado>;
  onDelete: () => Promise<Resultado>;
}

const labelClass = 'mb-1.5 block text-[14px] font-semibold text-slate-300';
const ayudaClass = 'mt-1.5 text-[14px] leading-snug text-slate-400';
const errorClass = 'mt-1.5 break-words text-[14px] leading-snug text-expense';
const ring = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900';

/** Hoja para crear o editar un contacto. Se monta solo mientras está abierta: cada apertura empieza con el formulario limpio. */
export function ContactoSheet({ contacto, onClose, onSave, onDelete }: Props) {
  const nombreRef = useRef<HTMLInputElement>(null);
  const ids = { nombre: useId(), telefono: useId(), relacion: useId(), alias: useId() };
  const esNuevo = contacto === null;

  const [b, setB] = useState<Borrador>(() => ({
    nombre: contacto?.nombre ?? '',
    telefono: contacto ? formatearTelefono(contacto.telefono) : '',
    relacion: contacto?.relacion ?? '',
    alias: contacto?.alias.join(', ') ?? '',
  }));
  const [intento, setIntento] = useState(false); // los errores aparecen al guardar, no mientras David todavía escribe
  const [telefonoTocado, setTelefonoTocado] = useState(false);
  const [pendiente, setPendiente] = useState(false);
  const [falla, setFalla] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  const validacion = validarBorrador(b);
  const errores: Errores = validacion.ok ? {} : validacion.errores;
  const tel = normalizarTelefono(b.telefono);
  const verTelefonoMal = !tel.ok && b.telefono.trim() !== '' && (telefonoTocado || intento);
  const set = (campo: keyof Borrador) => (valor: string) => setB((x) => ({ ...x, [campo]: valor }));

  const guardar = async () => {
    setIntento(true);
    if (!validacion.ok || pendiente) return;
    setPendiente(true);
    setFalla(null);
    const r = await onSave(validacion.valores);
    if (r.ok) onClose();
    else {
      setFalla(r.message);
      setPendiente(false);
    }
  };

  const eliminar = async () => {
    setPendiente(true);
    setFalla(null);
    const r = await onDelete();
    if (r.ok) onClose();
    else {
      setFalla(r.message);
      setPendiente(false);
    }
  };

  return (
    <Sheet
      open
      onOpenChange={(abierta) => !abierta && !pendiente && onClose()}
      title={esNuevo ? 'Agregar contacto' : 'Editar contacto'}
      description="Nombre, número y, si quieres, quién es y cómo lo llamas."
      hideDescription
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        if (esNuevo) nombreRef.current?.focus(); // al editar no se abre el teclado sin que David lo pida
      }}
      footer={
        <>
          <div aria-live="polite">
            {falla && <p role="alert" className="mb-2 break-words text-[14px] leading-snug text-expense">{falla}</p>}
          </div>
          <button
            type="button"
            onClick={() => void guardar()}
            disabled={pendiente}
            className={`btn-primary min-h-12 w-full text-[16px] ${ring}`}
          >
            {pendiente ? 'Guardando…' : esNuevo ? 'Guardar contacto' : 'Guardar cambios'}
          </button>
        </>
      }
    >
      <form
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void guardar();
        }}
      >
        <div>
          <label htmlFor={ids.nombre} className={labelClass}>Nombre</label>
          <input
            ref={nombreRef}
            id={ids.nombre}
            type="text"
            value={b.nombre}
            onChange={(e) => set('nombre')(e.target.value)}
            maxLength={MAX_NOMBRE + 20}
            autoComplete="off"
            enterKeyHint="next"
            aria-invalid={intento && !!errores.nombre}
            aria-describedby={intento && errores.nombre ? `${ids.nombre}-e` : undefined}
            placeholder="Marco"
            className="input"
          />
          {intento && errores.nombre && <p id={`${ids.nombre}-e`} className={errorClass}>{errores.nombre}</p>}
        </div>

        <div>
          <label htmlFor={ids.telefono} className={labelClass}>Teléfono</label>
          <input
            id={ids.telefono}
            type="tel"
            inputMode="tel"
            value={b.telefono}
            onChange={(e) => set('telefono')(e.target.value)}
            onBlur={() => setTelefonoTocado(true)}
            autoComplete="off"
            enterKeyHint="next"
            aria-invalid={verTelefonoMal || (intento && !!errores.telefono)}
            aria-describedby={`${ids.telefono}-ayuda`}
            placeholder="999 888 777"
            className="input"
          />
          <div id={`${ids.telefono}-ayuda`} aria-live="polite">
            {tel.ok ? (
              <p className={ayudaClass}>Se guarda como <span className="font-semibold text-slate-200">{formatearTelefono(tel.e164)}</span></p>
            ) : verTelefonoMal || (intento && errores.telefono) ? (
              <p className={errorClass}>{errores.telefono ?? tel.error}</p>
            ) : (
              <p className={ayudaClass}>De Perú, sin prefijo. De otro país, con +57, +1…</p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor={ids.relacion} className={labelClass}>Quién es <span className="font-normal text-slate-400">(opcional)</span></label>
          <input
            id={ids.relacion}
            type="text"
            value={b.relacion}
            onChange={(e) => set('relacion')(e.target.value)}
            maxLength={MAX_RELACION + 20}
            autoComplete="off"
            enterKeyHint="next"
            aria-describedby={`${ids.relacion}-ayuda`}
            placeholder="de Saya, mi primo, el dentista"
            className="input"
          />
          <p id={`${ids.relacion}-ayuda`} className={intento && errores.relacion ? errorClass : ayudaClass}>
            {intento && errores.relacion ? errores.relacion : 'Sirve para distinguir a dos con el mismo nombre: Wabid te pregunta cuál.'}
          </p>
        </div>

        <div>
          <label htmlFor={ids.alias} className={labelClass}>Apodos <span className="font-normal text-slate-400">(opcional)</span></label>
          <input
            id={ids.alias}
            type="text"
            value={b.alias}
            onChange={(e) => set('alias')(e.target.value)}
            autoComplete="off"
            enterKeyHint="done"
            aria-describedby={`${ids.alias}-ayuda`}
            placeholder="mamá, mami"
            className="input"
          />
          <p id={`${ids.alias}-ayuda`} className={intento && errores.alias ? errorClass : ayudaClass}>
            {intento && errores.alias ? errores.alias : 'Separados por comas. Es como se lo dices a Wabid: «escríbele a mi mamá».'}
          </p>
        </div>
        {/* Enter en un campo envía el formulario aunque el único botón de envío esté en el pie de la hoja. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>

      {!esNuevo && (
        <div className="mt-6 border-t border-slate-700 pt-5">
          {confirmando ? (
            <div role="group" aria-label="Confirmar que se elimina" className="space-y-3">
              <p className="text-base leading-snug text-slate-200">
                ¿Eliminar a <span className="font-semibold">{contacto.nombre}</span>? Wabid ya no podrá escribirle ni llamarle.
              </p>
              <div className="flex gap-3">
                <button type="button" onClick={() => setConfirmando(false)} disabled={pendiente} className={`btn-secondary min-h-12 flex-1 ${ring}`}>
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void eliminar()}
                  disabled={pendiente}
                  className={`min-h-12 flex-1 rounded-xl bg-expense px-4 py-3 font-semibold text-slate-950 transition-colors active:bg-expense/80 disabled:opacity-50 ${ring}`}
                >
                  {pendiente ? 'Eliminando…' : 'Eliminar'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmando(true)}
              className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 font-semibold text-expense transition-colors active:bg-slate-800 ${ring}`}
            >
              <Trash2 size={18} strokeWidth={1.8} aria-hidden="true" />
              Eliminar contacto
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
