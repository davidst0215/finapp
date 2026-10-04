import { useRef } from 'react';
import { Search, X } from 'lucide-react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
}

/** Barra de búsqueda: la lupa envía, Enter envía (el teclado del móvil muestra "Buscar") y la X borra. */
export function SearchBar({ value, onChange, onSubmit, onClear }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex h-[52px] items-center rounded-2xl border border-slate-500 bg-slate-900 pl-1 pr-1 transition-colors focus-within:border-slate-300 focus-within:ring-1 focus-within:ring-slate-300"
    >
      <button
        type="submit"
        aria-label="Buscar"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
      >
        <Search aria-hidden="true" size={19} />
      </button>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Pregunta"
        placeholder="Pregunta sobre tus proyectos"
        enterKeyHint="search"
        inputMode="search"
        autoComplete="off"
        className="h-full min-w-0 flex-1 bg-transparent px-1 text-base text-slate-100 outline-none placeholder:text-slate-400"
      />
      {value !== '' && (
        <button
          type="button"
          aria-label="Borrar"
          onClick={() => {
            onClear();
            inputRef.current?.focus();
          }}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
        >
          <X aria-hidden="true" size={18} />
        </button>
      )}
    </form>
  );
}
