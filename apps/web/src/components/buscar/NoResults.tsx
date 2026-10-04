interface NoResultsProps {
  /** Filtro de cliente activo, si lo hay: la salida más probable es quitarlo. */
  cliente: string | null;
  onClearCliente: () => void;
}

/** Búsqueda sin coincidencias: dice qué pasó y qué probar. */
export function NoResults({ cliente, onClearCliente }: NoResultsProps) {
  return (
    <div className="card">
      <p className="text-[15.5px] font-semibold text-slate-100">No encontré nada sobre eso en tus fichas.</p>
      <p className="mt-1 text-[14px] leading-relaxed text-slate-400">
        Prueba con otras palabras{cliente ? ' o quita el filtro de cliente' : ''}.
      </p>
      {cliente && (
        <button type="button" onClick={onClearCliente} className="btn-secondary mt-3 min-h-11 px-4 py-2 text-[14px]">
          Quitar filtro: {cliente}
        </button>
      )}
    </div>
  );
}
