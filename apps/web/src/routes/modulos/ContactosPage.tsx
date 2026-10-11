import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookUser, ChevronRight, Plus, Search, Smartphone } from 'lucide-react';
import { ContactoSheet } from '@/components/contactos/ContactoSheet';
import { useContactos } from '@/components/contactos/useContactos';
import { useToastStore } from '@/stores/toastStore';
import {
  desdeSelector, filtrar, monograma, numeroLegible, resumenImportacion, soportaSelector, type Contacto, type ContactoDelSelector,
} from '@/lib/contactos';

// Con pocos contactos buscar estorba; a partir de aquí la lista ya no se lee de un vistazo.
const MIN_PARA_BUSCAR = 8;

type Hoja = { contacto: Contacto | null } | null;

type SelectorDeContactos = { select: (props: string[], opts?: { multiple?: boolean }) => Promise<ContactoDelSelector[]> };

const ring = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300';

// Contactos: la agenda propia de Wabid (no la de Google). Con ella Wabid prepara un WhatsApp o una llamada por voz, pero nunca
// envía ni llama sola: la app muestra un botón y David lo toca.
export function ContactosPage() {
  const api = useContactos();
  const addToast = useToastStore((s) => s.addToast);
  const [hoja, setHoja] = useState<Hoja>(null);
  const [busqueda, setBusqueda] = useState('');
  const [importando, setImportando] = useState(false);
  const [resultado, setResultado] = useState<{ texto: string; error: boolean } | null>(null);

  const puedeImportar = soportaSelector(
    typeof navigator === 'undefined' ? undefined : (navigator as unknown as { contacts?: { select?: unknown } }),
    typeof window === 'undefined' ? undefined : window,
  );
  const visibles = useMemo(() => filtrar(api.items, busqueda), [api.items, busqueda]);

  const importar = async () => {
    setImportando(true);
    setResultado(null);
    try {
      const elegidos = await (navigator as unknown as { contacts: SelectorDeContactos }).contacts.select(['name', 'tel'], { multiple: true });
      if (!elegidos || elegidos.length === 0) return; // cerró el selector sin elegir
      const r = desdeSelector(elegidos, api.items);
      const g = await api.importar(r.nuevos);
      if (!g.ok) {
        setResultado({ texto: g.message, error: true });
        return;
      }
      // Si en el camino alguien más guardó un número, esos ya estaban.
      const guardados = g.guardados ?? r.nuevos.length;
      setResultado({
        texto: resumenImportacion({ ...r, nuevos: r.nuevos.slice(0, guardados), yaEstaban: r.yaEstaban + (r.nuevos.length - guardados) }),
        error: false,
      });
    } catch {
      setResultado({ texto: 'No pude abrir tus contactos. Agrégalos a mano con el botón +.', error: true });
    } finally {
      setImportando(false);
    }
  };

  const guardar = async (v: Parameters<typeof api.crear>[0]) => {
    const r = hoja?.contacto ? await api.actualizar(hoja.contacto.contacto_id, v) : await api.crear(v);
    if (r.ok) addToast(hoja?.contacto ? 'Cambios guardados' : 'Contacto guardado');
    return r;
  };
  const eliminar = async () => {
    const r = await api.eliminar(hoja!.contacto!.contacto_id);
    if (r.ok) addToast('Contacto eliminado');
    return r;
  };

  const botonImportar = puedeImportar && (
    <button type="button" onClick={() => void importar()} disabled={importando} className={`btn-secondary flex min-h-12 w-full items-center justify-center gap-2 ${ring}`}>
      <Smartphone size={18} strokeWidth={1.8} aria-hidden="true" />
      {importando ? 'Abriendo tus contactos…' : 'Importar del celular'}
    </button>
  );

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-1">
        <Link to="/more" aria-label="Volver a Más" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-xl text-slate-300 active:bg-slate-800">
          <ArrowLeft size={22} strokeWidth={1.8} aria-hidden="true" />
        </Link>
        <h1 className="flex-1 text-xl font-bold">Contactos</h1>
        <button
          type="button"
          onClick={() => setHoja({ contacto: null })}
          aria-label="Agregar contacto"
          className={`flex h-11 w-11 items-center justify-center rounded-full bg-primary-600 text-slate-950 active:bg-primary-700 ${ring}`}
        >
          <Plus size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <p className="text-base leading-snug text-slate-300">
        Con esta agenda, Wabid te deja listo un WhatsApp o una llamada. Nunca envía ni llama sola: el último toque es tuyo.
      </p>

      {api.estado === 'ready' && api.items.length > 0 && botonImportar}

      {resultado && (
        <p role="status" className={`rounded-xl border px-4 py-3 text-base leading-snug ${resultado.error ? 'border-expense/50 text-expense' : 'border-slate-700 text-slate-200'}`}>
          {resultado.texto}
        </p>
      )}

      {api.estado === 'loading' && (
        <>
          <ul aria-hidden="true" className="card divide-y divide-slate-700 p-0">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="h-11 w-11 rounded-full bg-slate-800 motion-safe:animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/2 rounded bg-slate-800 motion-safe:animate-pulse" />
                  <div className="h-3.5 w-2/3 rounded bg-slate-800 motion-safe:animate-pulse" />
                </div>
              </li>
            ))}
          </ul>
          <p role="status" className="sr-only">Cargando contactos…</p>
        </>
      )}

      {api.estado === 'error' && (
        <div className="card flex flex-col items-start gap-3">
          <p className="text-base font-semibold text-slate-100">No pude cargar los contactos</p>
          <p className="text-base text-slate-300">{api.error}</p>
          <button type="button" className={`btn-secondary min-h-[44px] ${ring}`} onClick={() => void api.recargar()}>Reintentar</button>
        </div>
      )}

      {api.estado === 'ready' && api.items.length === 0 && (
        <div className="card flex flex-col items-center gap-4 py-8 text-center">
          <BookUser size={28} strokeWidth={1.6} className="text-slate-400" aria-hidden="true" />
          <div className="space-y-2">
            <p className="text-base font-semibold text-slate-100">Aún no tienes contactos</p>
            <p className="mx-auto max-w-[32ch] text-base text-slate-300">
              Dile a Wabid «guarda a Marco con el 999 888 777, es de Saya» o agrégalos aquí.
            </p>
          </div>
          <div className="flex w-full flex-col gap-3">
            <button type="button" onClick={() => setHoja({ contacto: null })} className={`btn-primary min-h-12 w-full ${ring}`}>
              Agregar contacto
            </button>
            {botonImportar}
          </div>
        </div>
      )}

      {api.estado === 'ready' && api.items.length > 0 && (
        <section aria-label="Tus contactos" className="space-y-3">
          {api.items.length >= MIN_PARA_BUSCAR && (
            <div className="relative">
              <Search size={18} strokeWidth={1.8} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                aria-label="Buscar contacto"
                placeholder="Buscar por nombre o número"
                autoComplete="off"
                className="input pl-11"
              />
            </div>
          )}
          {visibles.length === 0 ? (
            <p role="status" className="card text-center text-base text-slate-300">Nadie coincide con «{busqueda.trim()}».</p>
          ) : (
            <ul className="card divide-y divide-slate-700 overflow-hidden p-0">
              {visibles.map((c) => (
                <li key={c.contacto_id}>
                  <button
                    type="button"
                    onClick={() => setHoja({ contacto: c })}
                    className={`flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-slate-800 ${ring} focus-visible:ring-inset`}
                  >
                    <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-slate-700 bg-slate-800 text-[15px] font-bold text-slate-200">
                      {monograma(c.nombre)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-semibold text-slate-100">
                        <span className="sr-only">Editar </span>
                        {c.nombre}
                      </span>
                      {/* La relación se recorta primero: el número siempre se ve completo. */}
                      <span className="flex text-[14px] text-slate-300">
                        {c.relacion && <span className="min-w-0 truncate">{c.relacion}</span>}
                        {c.relacion && <span aria-hidden="true" className="shrink-0 px-1.5">·</span>}
                        <span className="shrink-0 whitespace-nowrap tabular-nums">{numeroLegible(c)}</span>
                      </span>
                    </span>
                    <ChevronRight size={18} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-slate-500" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {hoja && <ContactoSheet contacto={hoja.contacto} onClose={() => setHoja(null)} onSave={guardar} onDelete={eliminar} />}
    </div>
  );
}
